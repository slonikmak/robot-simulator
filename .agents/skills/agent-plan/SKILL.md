---
name: agent-plan
description: "Prepare an Issue for Plan Gate by creating a plan-only PR. Use when the user says `plan`/`prepare` (or asks to “подготовить задачу к апруву плана”), and you need to: normalize the issue title, create a branch, write/update `tasks/T-XXXX.md` (3–7 checkbox steps + Goal + Acceptance), optionally update `spec.md` (add/adjust `R-XXX`), open/update a PR with required body fields, and ensure no changes land in `src/` or `tests/` before `plan:approved`."
---

# Agent plan (aka prepare)

## Overview

Подготовить задачу к Plan Gate: создать ветку и PR, содержащий только артефакты плана (`tasks/`, при необходимости `spec.md` и/или `adr/`), без изменений в коде.

## Preconditions

- Issue существует и находится в `status:backlog` (или эквивалентном входящем состоянии).
- Есть доступ к `gh` и `git`, настроены remotes.

## Workflow

### 1) Read and normalize the Issue

```bash
gh issue view <issue_number>
```

Привести заголовок к `feat/fix/chore/spec(area): ...`:

```bash
gh issue edit <issue_number> --title "<normalized title>"
```

### 2) Create/switch branch

Рекомендуемый шаблон: `<type>/<area>-<issue_number>-<slug>`.

```bash
git fetch
git checkout -b "<branch>"
```

### 3) Create/update the plan artifact `tasks/T-XXXX.md`

Создать директорию `tasks/` (если её нет), затем файл плана `tasks/T-<issue_number>.md`:

- 3–7 проверяемых чекбоксов шагов реализации
- `Goal:` (ожидаемый итог)
- `Acceptance:` (критерии приёмки)

Ссылаться на `Spec: R-XXX` если требование уже есть; иначе указать `Spec: New requirement` и предложить добавить `R-0YY` в `spec.md`.

### 4) Optionally update `spec.md` and/or `adr/`

Если задача spec-first или требует легализации ожиданий — добавить/уточнить требование `R-XXX` в `spec.md` (уникальный номер) и описать корректное поведение.

Если это “audit-first” — создать ADR в `adr/` и зафиксировать решения **без изменений кода**.

### 5) Enforce “no code changes” rule (Plan Gate)

Перед коммитом убедиться, что не менялись `src/` и `tests/`:

```bash
git status --porcelain
git diff --name-only --diff-filter=ACMRT
```

Если есть изменения в `src/`/`tests/` — остановиться и вынести их в фазу `execute` после `plan:approved`.

### 6) Commit plan artifacts

```bash
git add tasks spec.md adr
git commit -m "plan: issue #<issue_number>"
git push -u origin "<branch>"
```

### 7) Create/update PR for Plan Gate

Создать PR (или обновить существующий) и заполнить body:

- `Fixes #<issue_number>`
- `Spec: R-XXX` или `Spec: New requirement`
- `Plan: tasks/T-<issue_number>.md`
- `Why: ...`

Команды (примерно):

```bash
gh pr create --fill
gh pr edit <pr_number> --body "<body>"
```

## Output contract

```
RESULT=ok|fail
ISSUE=<issue_number>
PR=<pr_number>
NEXT=wait for plan:approved, then execute <issue_number>
```

## References

- `docs/agents/AGENT_WORKFLOWS.md` (термин “prepare”)
- `docs/agents/skills.md` (термин “plan”)
