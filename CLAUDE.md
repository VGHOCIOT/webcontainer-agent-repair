# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this project is

A self-healing, backend-less "micro-SaaS builder" demo: an agent writes code for a small app spec, runs it in a real in-browser Node.js sandbox, and iteratively patches it based on actual runtime errors until it works (or hits a retry cap).

## Commands

- `npm run dev` — Vite dev server (the app runs entirely in the browser; needs an Anthropic API key entered in the UI or via `VITE_ANTHROPIC_API_KEY` in `.env`).
- `npm run build` — `tsc -b && vite build` (full typecheck + production bundle).
- `npm run lint` — oxlint (config in `.oxlintrc.json`).
- `npx tsc --noEmit` — typecheck only, without building.

There is **no test runner** in this project — no unit/integration test framework is set up, so there is no single-test command. "Verification" here means running the app and driving the agent loop end-to-end in the browser (see the design constraints below on why the loop's behavior, not a test suite, is the signal). Don't assume a test command exists; if you add one, update this file.

## Architecture (implemented)

- **In-browser runtime** (`src/lib/webcontainer.ts`): WebContainers (`@webcontainer/api`). Boots a real Node.js process with a working filesystem and `npm install` entirely inside the browser tab — no server-side execution. This is the core "no backend" property.
- **Agent loop** (`src/lib/agentLoop.ts`): write → install → start → validate, capped at `MAX_ITERATIONS` (currently 6). Each iteration asks Claude for code (`src/lib/anthropic.ts`), mounts and runs it, and on any failure (no files / install / startup / wrong behavior) feeds the actual captured output back as the next prompt (`buildRetryPrompt` in `src/lib/spec.ts`). Returns `{ attempts, stoppedReason }`.
  - **No-progress guard**: tracks a file fingerprint and a failure signature per attempt; a repeat escalates the retry prompt (`buildEscalatedRetryPrompt`) and two consecutive stalls stop the loop with `stoppedReason: "no-progress"`, so a stuck run can't burn the whole budget.
- **Validation is generated per-spec — "Mode A"** (`src/lib/validatorGen.ts`, `src/lib/validate.ts`): one AI call turns the freeform spec into a deterministic Node validator *script*; the loop then runs that fixed script every attempt, so the grader is deterministic at run time and only its authoring uses the model. This deliberately replaced an earlier hardcoded validator and an earlier "keep validation non-AI" stance. **Mode B (an LLM judging each attempt) was rejected** — a non-deterministic grader in the fitness-function seat corrupts convergence data and is gameable by the code generator. Every validator honors a shared per-check contract: it prints `{ checks: [{ name, pass, details }] }` as its last stdout line.
- **Frontend shell** (`src/App.tsx`, `src/components/`): React/TS. Shows a validator panel (generated script + check chips + Regenerate), a live attempt log, the live preview pane, run stats, and a **healing timeline** (`computeHealingTimeline` in `src/lib/stats.ts` + `HealingTimeline.tsx`) — a check×attempt grid that flags pass→fail regressions. The healing process must stay visible, not just the end result.

## Design constraints to preserve

- Keep the target demo app deliberately trivial (the default spec is a tiny paginated REST endpoint). The loop is the point, not the app — small enough that bugs are predictable but real enough to read as a legitimate app.
- Bugs shown healing must be genuine, not faked: either let them arise naturally from an underspecified spec, or deliberately seed a known bug class — but if seeded, disclose that transparently rather than presenting it as organic.
- The valuable output is the data on how the loop behaves, not just a working demo: iterations to convergence, which failure classes it handles vs. regresses on, and token/time cost per fix. This is already instrumented (per-attempt `usage`, `failureStage`, per-check results, regression detection) — keep new work capturable this way, not just pass/fail.
- Retry prompts must carry enough context (spec, prior code, actual captured error) for a targeted fix, not a blind full-file rewrite.
