# Repository Guidelines

## Project Structure & Module Organization

- `index.html`: entry page; hosts the `<canvas>` and loads scripts.
- `styles.css`: UI styling for the state panel and canvas.
- `main.js`: simulation loop, rendering, input (mouse “legs”), and constants (`CFG`).
- `robot.js`: physics + sensor models (ultrasonic, color sensor) and egg/clutch visuals.
- `firmware.js`: Arduino-style state machine and behavior transitions (keep this logic portable).
- `spec.md`: behavior/spec notes; track requirements as `R-XXX`.
- `tasks/T-*.md`: plan files used by the workflow (Plan Gate).
- `docs/agents/*`: agent workflow and skill docs.

## Build, Test, and Development Commands

Static HTML/CSS/JS (no bundler). Run via an HTTP server:

```bash
python -m http.server 8000
# open http://localhost:8000
```

Or:

```bash
npm install -g serve
serve -l 8000
```

## Coding Style & Naming Conventions

- Indentation: 2 spaces (JS/CSS/HTML).
- JS: prefer `const`/`let`, keep files in `'use strict'` mode.
- Keep behavior constraints realistic: sensor/actuator limits belong in `CFG` and in `firmware.js`.
- Naming: `UPPER_SNAKE_CASE` for enums/constants, `camelCase` for variables/functions, `PascalCase` for classes.

## Simulation Fidelity (From `spec.md`)

- Project goal: simulate the *real* robot and environment; prefer “physics + sensors” over scripted/omniscient behavior.
- Avoid assumptions and “hidden knowledge”: firmware logic must not depend on data a real robot wouldn’t have (e.g., perfect `x,y` targets).
- If real hardware can’t do something reliably, model that limitation explicitly in the simulator instead of smoothing it away.

## Testing Guidelines

Manual smoke check for behavior changes:

- Start the server, open the page, move the mouse (legs), zoom with the wheel, and confirm UI/state transitions behave correctly.

## Commit & Pull Request Guidelines

- Commit subjects use prefixes like `fix:`, `chore(sim):`, `plan: issue #<n> ...`.
- For behavior changes, PR body must include: `Fixes #<issue>`, `Spec: R-XXX` (or `New requirement`), `Plan: tasks/T-XXXX.md`, and a short `Why:`.

## Agent-Specific Workflow (Plan Gate)

This repo uses a plan-first workflow described in `docs/agents/AGENT_WORKFLOWS.md`. In short:

- For any incoming request, first verify the current Issue/PR state (FSM labels like `status:*`, `plan:*`). Use the `agent-report` skill (`.agents/skills/agent-report`) to check for blockers (e.g., missing `plan:approved`).
- Do not self-approve PRs and do not apply the `plan:approved` label yourself; plan approval is a human gate.
- Create/update `tasks/T-XXXX.md` first and get plan approval before implementing behavior changes.
- If scope changes mid-stream, update the plan (and `spec.md` if needed) and re-approve before continuing.
