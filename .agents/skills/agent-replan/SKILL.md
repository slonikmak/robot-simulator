---
name: agent-replan
description: "Update a previously submitted plan when scope changes or a PR has `plan:changes-requested`. Use when the user says `replan`/“перепланировать” and you need to modify `tasks/T-XXXX.md` (and optionally `spec.md`/`adr/`), commit and push updates, refresh the PR body, post a concise PR comment changelog, and (if applicable) remove `plan:approved` and set `plan:changes-requested`."
---

# Agent replan

## Overview

Перепланировать задачу в уже созданном PR: обновить артефакты плана и вернуть PR в состояние ожидания апрува плана.

## Preconditions

- Есть `issue_number` или `pr_number` и связанный PR.
- Понятна причина replanning (что изменилось и почему).

## Workflow

### 1) Read current state (Issue + PR)

```bash
gh issue view <issue_number>
gh pr view <pr_number>
```

### 2) Update plan artifacts

Обновить:

- `tasks/T-<issue_number>.md` (шаги/Goal/Acceptance)
- при необходимости `spec.md` (уточнить/добавить `R-XXX`) и/или `adr/`

### 3) Commit and push

```bash
git add tasks spec.md adr
git commit -m "plan: replan issue #<issue_number>"
git push
```

### 4) Refresh PR body + add changelog comment

Если изменились `Spec:`/`Why:`/`Plan:` — обновить PR body.

Оставить короткий комментарий в PR: “что поменялось в плане” + “что теперь нужно ревьюеру”.

### 5) Manage Plan Gate labels (when applicable)

Если replan делается из фазы реализации или план существенно меняется — снять `plan:approved` и поставить `plan:changes-requested`:

```bash
gh pr edit <pr_number> --remove-label "plan:approved" --add-label "plan:changes-requested"
```

## Output contract

```
RESULT=ok|fail
ISSUE=<issue_number>
PR=<pr_number>
NEXT=wait for plan approval
```

## References

- `docs/agents/skills.md`
