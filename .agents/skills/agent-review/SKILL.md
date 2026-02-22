---
name: agent-review
description: "Prepare a PR for final review/merge according to the repo’s agent workflow. Use when the user says `review`/“подготовь PR к ревью/мерджу” and you need to check PR body fields (`Fixes`, `Spec`, `Plan`, `Why`), verify acceptance criteria from `tasks/T-XXXX.md`, run/confirm tests, add a self-review comment, and optionally apply a readiness label (e.g. `ready:review`)."
---

# Agent review

## Overview

Проверить, что PR соответствует процессу (артефакты, тексты, критерии приёмки) и готов к финальному ревью/merge.

## Workflow

### 1) Load context

```bash
gh pr view <pr_number>
gh pr view <pr_number> --json body,labels,baseRefName,headRefName
```

Открыть `tasks/T-<issue_number>.md` и сверить с текущими изменениями.

### 2) Validate PR body contract

PR body должен содержать:

- `Fixes #<issue_number>`
- `Spec: R-XXX` (или `Spec: New requirement`)
- `Plan: tasks/T-<issue_number>.md`
- `Why: ...` (2–5 строк)

Если чего-то не хватает — обновить body через `gh pr edit`.

### 3) Check acceptance criteria

- Каждому пункту Acceptance соответствует проверяемый факт (тест, ручная проверка, скриншот/видео для UI, и т.д.).
- Нет “скрытых” изменений вне scope (если есть — поднять это как follow-up issue).

### 4) Confirm tests

Убедиться, что тесты/сборка запускались и результат зафиксирован (в PR комментарии или описании).

### 5) Add self-review comment + (optional) label

Добавить self‑review: что сделано, как проверено, риски/edge cases.

Опционально:

```bash
gh pr edit <pr_number> --add-label "ready:review"
```

## Output contract

```
RESULT=ok|fail
ISSUE=<issue_number>
PR=<pr_number>
NEXT=await reviewer / merge
```

## References

- `docs/agents/skills.md`
