# Repository Guidelines

## Project Structure & Module Organization

- `index.html`: entry page; loads scripts and hosts the `<canvas>` + UI panel.
- `styles.css`: UI styling for the state panel and canvas.
- `main.js`: simulation loop, rendering, input (mouse “legs”), and constants (`CFG`).
- `robot.js`: physics/sensors models (ultrasonic + color sensor), eggs/clutch visuals, and robot primitives.
- `firmware.js`: Arduino-style state machine and behavior transitions (keep this logic portable).
- `spec.md`: spec/behavior notes; track requirements as `R-XXX`.
- `tasks/T-*.md`: plan files used by the repo workflow (Plan Gate).
- `docs/agents/*`: agent workflow + skills docs.

## Build, Test, and Development Commands

This repo is static HTML/CSS/JS (no bundler required). Run via an HTTP server:

```bash
python -m http.server 8000
# open http://localhost:8000
```

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
- Avoid assumptions and “hidden knowledge”: firmware logic should not depend on data a real robot wouldn’t have (e.g., perfect `x,y` targets).
- If real hardware can’t do something reliably, model that limitation explicitly in the simulator instead of smoothing it away.

## Testing Guidelines

No automated test suite is currently configured. For behavior changes, do a quick manual smoke check:

- Start the server, open the page, move the mouse (legs), zoom with the wheel, and confirm UI/state transitions behave correctly.

## Commit & Pull Request Guidelines

- Commit subjects use a Conventional Commits-like pattern, e.g. `fix: ...`, `chore(sim): ...`, `plan: issue #<n> ...`.
- For behavior changes, PR body must include: `Fixes #<issue>`, `Spec: R-XXX` (or `New requirement`), `Plan: tasks/T-XXXX.md`, and a short `Why:`.

## Agent-Specific Workflow (Plan Gate)

This repo uses a plan-first workflow described in `docs/agents/AGENT_WORKFLOWS.md`. In short:

- For any incoming request, first verify the current Issue/PR state (FSM labels like `status:*`, `plan:*`). Use the `agent-report` skill (`.agents/skills/agent-report`) to check for blockers (e.g., missing `plan:approved`).
- Create/update `tasks/T-XXXX.md` first and get plan approval before implementing behavior changes.
- If scope changes mid-stream, update the plan (and `spec.md` if needed) and re-approve before continuing.
