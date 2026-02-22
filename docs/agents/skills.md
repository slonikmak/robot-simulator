# Менеджер задач для команды

Ниже приведён набор макро‑команд, удобный для упаковки в скрипты (`scripts/agent-*`) и
использования агентом как однозначного интерфейса. Обычно `execute` выполняется
"человеком‑агентом" вручную, остальные можно вызывать из автоматизированных сценариев.

## 1. capture

Используется для создания входящей задачи (фича, баг, техдолг, аудит).

### Что делает (GitHub)

- создаёт issue через `gh issue create`
- ставит `status:backlog`
- нормализует заголовок (`idea(...)` или `feat/fix/chore/spec(...)`)
- заполняет базовое описание (Why / Observed / Expected / Notes)

### Что принимает

- тип запроса: `feature | bug | chore | audit | spec`
- area
- краткое описание
- (опционально) repro / expected для бага

### Что возвращает

- `issue_number`
- `issue_url`

## 2. plan

Подготавливает задачу к утверждению плана (Plan Gate).

### Что делает (GitHub + git)

- читает issue (`gh issue view <id>`)
- нормализует заголовок (`gh issue edit <id> --title …`)
- создаёт/переключает ветку (`git checkout -b …`)
- создаёт/обновляет `tasks/T-XXXX.md`
- при необходимости обновляет `spec.md` (новый/изменённый `R‑XXX`) или
  создаёт/обновляет ADR в `adr/`
- коммитит артефакты плана
- открывает/обновляет PR (`gh pr create` / `gh pr edit`)
- дополняет PR body:
  - `Fixes #XXXX`
  - `Spec: …` (если нужно)
  - `Plan: tasks/T-XXXX.md`
  - `Why: …`

> **важное правило:** в `plan` запрещено менять `src/`/`tests/`.

### Что принимает

- `issue_number`
- опционально mode: `plan-only | plan+spec | plan+adr`

### Что возвращает

- `branch_name`
- `pr_number`
- `pr_url`

## 3. replan

Применяется, когда scope меняется или на PR стоит `plan:changes-requested`.

### Что делает (GitHub + git)

- читает PR и issue
- обновляет `tasks/T-XXXX.md`
- при необходимости правит `spec.md` / `adr/`
- коммитит изменения плана
- обновляет PR body при изменении Spec/Why
- оставляет комментарий в PR с кратким changelog
- если replan делается из реализации, снимает `plan:approved` и ставит
  `plan:changes-requested`

### Что принимает

- `issue_number` или `pr_number`
- причина replanning (текст)

### Что возвращает

- `pr_url`
- список изменённых артефактов (`tasks`, `spec`, `adr`)

## 4. execute

Выполняет задачу после утверждения плана.

### Что делает (GitHub + git)

- проверяет, что в PR есть label `plan:approved`
- проверяет issue `status:todo`
- переводит issue в `status:in-progress`
- добавляет прогресс-комментарий
- вносит изменения в `src/`/`tests/` (и docs при необходимости)
- запускает тесты (локально)
- делает коммиты реализации и пушит в тот же PR

> обычно `execute` выполняется «агентом вручную»; скрипт должен лишь
> валидировать preconditions.

### Что принимает

- `issue_number`
- (опционально) target step из `tasks/T-XXXX.md`

### Что возвращает

- список коммитов
- статус тестов
- `pr_url`

## 5. review

Подготавливает PR к финальному ревью / merge.

### Что делает (GitHub)

- читает PR, issue, `tasks/T-XXXX.md`
- проверяет PR body:
  - `Fixes #…`
  - `Spec: …` (если требуется)
  - `Plan: tasks/T-XXXX.md`
  - `Why: …`
- сверяет acceptance criteria
- обновляет PR body при необходимости
- добавляет self‑review комментарий
- опционально ставит label `ready:review`

### Что принимает

- `pr_number` или `issue_number`

### Что возвращает

- `ready_for_merge: true|false`
- список замечаний (если есть)

## 6. report

Показывает состояние задачи или проекта по FSM.

### Что делает (GitHub)

- читает issue/PR
- для проекта получает списки по меткам и открытые PR
- классифицирует элементы по состояниям:
  `backlog`, `plan review`, `plan changes requested`, `todo`,
  `in-progress`, `review`, `done`

### Что принимает

- scope: `issue <id>` либо `project`

### Что возвращает

- краткую сводку состояния
- блокеры (например, «ждёт plan approval»)

---

## Скрипты

Рекомендуемые имена:

- `scripts/agent-capture`
- `scripts/agent-plan`
- `scripts/agent-replan`
- `scripts/agent-execute`
- `scripts/agent-review`
- `scripts/agent-report`

или единый роутер `scripts/agent <command> …`.

### Минимальные правила для всех скриптов

1. Не выполнять произвольные `gh/git` действия вне команд.
2. Каждый скрипт печатает структурированный итог:

```
RESULT=ok|fail
ISSUE=…
PR=…
NEXT=…
```

3. Валидировать предусловия:

- `execute` без `plan:approved` → ошибка
- `plan` с изменениями в `src/`/`tests/` → ошибка
- `review` без `Fixes`/`Plan`/`Why` → ошибка
