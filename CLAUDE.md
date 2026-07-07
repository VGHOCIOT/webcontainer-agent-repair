# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project status

This repository is pre-implementation: it currently contains only a README and LICENSE, no source code, package manifest, or build tooling yet. There are no build/lint/test commands to run until the initial scaffolding is created. When you add the first package.json, update this file with the actual commands (dev server, lint, test runner, single-test invocation) rather than assuming defaults.

## What this project is

A self-healing, backend-less "micro-SaaS builder" demo: an agent writes code for a small app spec, runs it in a real in-browser Node.js sandbox, and iteratively patches it based on actual runtime errors until it works (or hits a retry cap).

## Intended architecture

- **In-browser runtime**: WebContainers (`@webcontainer/api`, the engine behind StackBlitz/bolt.new). Spins up a real Node.js process with a working filesystem and `npm install` entirely inside the browser tab — no server-side execution. This is the core "no backend" property of the project.
- **Agent loop** (Claude API, `/v1/messages`):
  1. Generate code for a small spec.
  2. Run it in the WebContainer and capture actual stdout/stderr.
  3. On failure, feed the error back into the next prompt ("here's what broke, fix it").
  4. Repeat up to a capped iteration count (5–8) so a bad loop can't run forever or burn API budget.
- **Frontend shell**: React/TS UI with a live preview pane and a running "attempt log" (attempt #N failed: error → patch applied → attempt #N+1 passed) — the healing process must be visible, not just the end result.

## Design constraints to preserve

- Keep the target demo app deliberately trivial (e.g. a tiny paginated REST endpoint or a form-with-validation). The loop is the point, not the app — pick something small enough that bugs are predictable but real enough to read as a legitimate app.
- Bugs shown healing must be genuine, not faked: either let them arise naturally from an underspecified spec, or deliberately seed a known bug class — but if seeded, that must be disclosed transparently rather than presented as organic.
- The valuable output of this project is the data on how the loop behaves, not just a working demo: iteration counts to convergence, which failure classes it handles vs. never fixes (loops that regress instead of converge), and token/time cost per fix. Instrument the agent loop so this data is actually capturable (per-attempt logs, token usage, timing), not just the pass/fail outcome.
- Retry prompts must carry enough context (spec, prior code, actual captured error) for the model to targeted-fix the bug, not blindly rewrite the whole file from scratch.
