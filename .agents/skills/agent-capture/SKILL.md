---
name: agent-capture
description: "Create a new GitHub Issue in `status:backlog` using the repo’s agent workflow. Use when the user says `capture` (or asks to “создать/зафиксировать задачу/идею/баг/аудит”) and you need to open an intake issue via `gh issue create`, apply the right labels, and produce `issue_number` + `issue_url` in a predictable output format."
---

# Agent capture

## Overview

Создавать входящие задачи (feature/bug/chore/audit/spec) как GitHub Issue в состоянии `status:backlog` по правилам из `docs/agents/AGENT_WORKFLOWS.md` и `docs/agents/skills.md`.

## Preconditions

- Доступ к репозиторию и настроенный GitHub CLI: `gh auth status`.
- Достаточно контекста, чтобы заполнить: `type` (`feature|bug|chore|audit|spec`), `area`, короткое описание.

## Workflow

### 0) Ask clarifying questions only if there are gaps

**Правило:** задавать уточняющие вопросы *только* если без них нельзя корректно создать issue. Если информации достаточно — сразу создавать issue, а мелкие допущения фиксировать в `Notes:` как `Assumptions: ...`.

Минимально необходимая информация:

- `type`: что это — feature/bug/chore/audit/spec
- `area`: короткий модуль/область в скобках (например, `sim`, `ui`, `robot`, `firmware`, `docs`)
- 1–2 предложения описания сути

Для `bug` дополнительно (если отсутствует — спросить):

- `Observed:` что происходит
- `Expected:` что должно происходить
- (опционально) `Repro:` шаги/условия

Если есть пробелы, задать **1–3** коротких вопроса и дождаться ответа. Пример:

- “Это `bug` или `feature`?”
- “Какой `area` поставить (например `sim`/`firmware`/`robot`/`ui`/`docs`)?“
- “Для бага: что *Observed* и что *Expected*?”

### 1) Normalize the issue title

Собрать заголовок в одном из форматов:

- `feat(area): ...`
- `fix(area): ...`
- `chore(area): ...`
- `spec(area): ...`
- `chore(area): architecture audit ...`

Если исходно это “idea”, допустимо начать с `idea(area): ...`, но стараться сразу нормализовать под `feat/fix/...`.

### 2) Create the Issue (GitHub)

Создать issue и применить лейбл `status:backlog` (и другие нужные лейблы проекта, если они существуют):

```bash
gh issue create --title "<title>" --body "<body>" --label "status:backlog"
```

Тело issue (минимум):

- `Why:` 2–5 строк мотивации
- `Observed:` (для багов)
- `Expected:` (для багов)
- `Repro:` (для багов, если применимо)
- `Notes:` контекст/ссылки/ограничения

Если нужно поправить заголовок/лейблы после создания:

```bash
gh issue edit <id> --title "<normalized title>"
gh issue edit <id> --add-label "status:backlog"
```

### 3) Return a structured result

Считать `issue_number`/`issue_url` из вывода `gh` (или через `gh issue view`), и завершить команду структурированным итогом:

```
RESULT=ok|fail
ISSUE=<number>
PR=
NEXT=plan <issue_number>
```

## Guardrails

- `capture` не создаёт PR и не меняет код.
- Не превращать `capture` в интервью: вопросы — только по явным пробелам, иначе фиксировать допущения в `Notes:`.
- Если в репо нет лейбла `status:backlog`, явно сообщить об этом и продолжить без лейбла (или предложить создать лейбл).

## References

- `docs/agents/AGENT_WORKFLOWS.md`
- `docs/agents/skills.md`
