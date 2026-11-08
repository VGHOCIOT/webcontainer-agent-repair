# Experiment design

Written before any result batch is run, so the setup can't be adjusted after seeing
the numbers. Change this file (and note why) before changing a setting, never after.
Items marked **Proposed** are defaults chosen to be sensible and cheap enough; confirm
or edit them before the first full batch.

## Question

Does an in-browser agent loop that feeds back real runtime errors converge on a working
app more often than the same budget of fresh independent attempts, and how much of that
is *debugging* the error versus merely being *told the requirements*?

The loop runs entirely in a browser tab (WebContainers), so a positive result also
supports the claim that frontend development can be decoupled from a backend or
database definition. The difficulty is deliberately pushed into the frontend; the data
layer is a stub.

## Arms

Every run index is executed in every arm, scored by the **same qualified graders**, with
the same attempt cap.

| Arm | Code name | Each retry sees |
|---|---|---|
| healing | `feedback` | spec, previous code, the real captured failure |
| informed | `informed` | spec + the grader's check *names*; fresh sample, no history |
| spec-only (control) | `spec-only` | spec only; fresh sample, no history |

Contrasts (percentage points of convergence rate):

- disclosure = informed − spec-only
- debugging = healing − informed
- total feedback = healing − spec-only

## Primary metric

Convergence rate: the share of runs whose build passes every grader check within
the cap (`stoppedReason === "converged"`), per arm, per spec, with 95% Wilson intervals.
An arm gap is reported as a difference only when the intervals do not overlap;
otherwise it is reported as "not separable at this N".

## Secondary metrics

- Attempt-1 pass rate (the base builder capability on that spec).
- Iterations to converge (median, mean, max) over converged runs.
- Tokens and wall time per converged run, and tokens per run overall (the true cost of an arm).
- Regressions (pass→fail between attempts; healing arm only) and stalled attempts.
- First-failing checks and failed-attempt stages, split by layer (`data` vs `frontend`).
- Data-pass-but-UI-fail attempts: how often the frontend grader caught a build that a
  data-layer-only validator would have accepted.
- Independent-sampling cross-check `1 − (1 − p)^cap` for the spec-only arm. A sanity
  check on the control, not a substitute for it.

## Fixed settings

| Setting | Value | Where |
|---|---|---|
| Attempt cap | 6 | `MAX_ITERATIONS` in `src/App.tsx` |
| Qualify tries per batch | 3 | `QUALIFY_MAX_TRIES` in `src/lib/qualify.ts` |
| Builder model | `claude-haiku-4-5` (**Proposed**) | weaker than the grader, so natural bugs appear |
| Grader model | `claude-sonnet-5` (**Proposed**) | authors the validator + interaction driver |
| Perturbations (PORT / offline / fuzz) | off | the base result is unperturbed |

Do not change the builder, grader, prompts or cap partway through. The export's prompt
hashes and qualification record are only comparable when nothing changed.

## Scope

**Eligible specs (graders are gated by a reference app and known-bad mutants):**

- Presets: REST endpoint, Frontend app, Interactive tasks, Task filter, Live search.
- Corpus: Flashcards, Tip splitter, Counter, FAQ accordion, Star rating, Tabs. These are
  loosely worded and id-free, so builders have more room for natural mistakes, and they
  also get a known-good variant (graders overfit to one DOM structure are rejected).

Eligible does not mean run. The pilot picks the specs that get the full phase: a spec
only helps if the builder sometimes fails at attempt 1 (in the October pilot Interactive
tasks passed attempt 1 in 4 of 5 runs, leaving the arms little to differ on). The goal is
3–4 specs that discriminate, not coverage of every eligible spec.

**Out of scope for findings:** custom specs. They run on unqualified graders (accepted
risk, see `CLAUDE.md`). Their results are demonstrations, never reported numbers.

## Sample size (**Proposed**)

- Pilot: 5 runs per arm on a small candidate set (**Proposed**: Interactive tasks, Live
  search, Flashcards, Tabs). Purpose is not a result; it is to catch grader defects and
  to choose which specs get the full phase. Add candidates only if fewer than 3 survive.
- Full: 20 runs per arm on the 3–4 specs that survive. At N=10 the Wilson intervals are
  too wide to separate arms that differ by 20–30 points; N=20 is the floor. Raise N for
  any spec whose contrasts come out not separable but close.
- A spec survives if attempt-1 pass is clearly between 0% and 100% in the pilot, its
  qualification is `qualified`, and it has no unexplained suspect checks.

Run count for the full phase is `surviving specs × arms × N`; 4 specs × 3 arms × 20 =
240 runs, 80 per arm.

## Cost estimate (**assumptions, not measurements**)

Haiku 4.5 builder at $1/M input and $5/M output (cached price table dated 2026-10-06,
not re-verified). Assumed ~5k in / 3k out per builder attempt (~$0.02) and ~2.5 / 3.5 / 4
attempts per run for healing / informed / spec-only, so about $0.20 per run index across
three arms. Grader authoring is ~$1 per 12 grader pairs on Sonnet; qualification makes no
model calls.

| Phase | Run indices | Estimate |
|---|---|---|
| Pilot, 4 specs × 5 | 20 | ~$4 |
| Full, 4 specs × 20 | 80 | ~$16 |
| Total | | ~$20 (plausible range $10–40) |

After the pilot, replace this with the measured figure: the analysis table's
`tok/run (all)` column times the Haiku prices, scaled to the full phase.

## Procedure

1. **Preflight.** `npm run build` and `npm run lint` pass on `main`. Dev server up with an
   API key. Builder = Haiku, grader = Sonnet.
2. **Pilot per candidate spec.** Pick the spec, tick all three arms, runs = 5, Run batch. Check:
   - Qualification is `qualified` and `tries` is not at the cap.
   - There is no "Possible grader defect" notice. If there is, read the failing check
     against the spec and the generated code. If the check is wrong, fix the grader
     prompt (`VALIDATOR_SYSTEM_PROMPT` / `DRIVER_SYSTEM_PROMPT`), never the spec; add a
     known-good variant only if the cause is structural.
   - `informedChecklistSource` is `run`.
   Download the export. Drop specs that cannot discriminate (see "A spec survives").
3. **Full batch per surviving spec (3–4 specs).** Same settings, runs = 20. One export file per spec.
   Keep the exports in a local `results/` directory (not committed unless you decide to).
4. **Re-use graders across cells.** If a second builder model is added later, import the
   first export's graders ("import graders") so both cells are scored by identical
   scripts; the analysis flags cells scored by different graders.
5. **Analyze.** `node scripts/analyze.mjs results/*.json` (add `--json` for machine output).
6. **Write up** with the validity checks below.

## Validity checks (all must hold to report a number)

- `gradersQualified: true` (`qualification.status === "qualified"`) for the cell.
- No unexplained suspect checks. Every flagged check was read against the spec and code.
- All arms have equal run counts, and one grader pair per spec (no grader-hash warning).
- Informed checklist sourced from the qualification run (`informedChecklistSource: "run"`).
- Perturbations identical across merged files.
- Seeded or perturbation-induced bugs are disclosed as such, not presented as organic.
- Never pool arms. Pool across specs only if stated, and report per spec as well.

## What would change the plan

- A grader defect found mid-experiment invalidates that spec's cell; fix the grader
  prompt, requalify, and re-run that spec from scratch.
- If most specs saturate at attempt 1 with the Haiku builder, the capability gap is too
  small to show healing. Choose a weaker or harder setup *before* the full phase and
  record the change here.
