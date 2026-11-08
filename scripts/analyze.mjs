#!/usr/bin/env node
// Merge batch exports (the JSON from "Download results (JSON)") into the tables
// the write-up needs. Offline, no dependencies:
//
//   node scripts/analyze.mjs results/*.json
//   node scripts/analyze.mjs results/*.json --json   # machine-readable
//
// One cell = (spec x builder model). Files for the same cell are merged. Each
// cell is summarised PER ARM (healing / informed / spec-only), never pooled, and
// the arm gaps (disclosure, debugging, total feedback) are reported with an
// explicit "separable?" verdict from the Wilson intervals. Anything that would
// make two cells incomparable (different grader hashes for one spec, an
// unqualified grader, mixed perturbations, a checklist from authored names) is
// printed as a WARNING rather than silently averaged over.

import { readFileSync } from "node:fs";

const args = process.argv.slice(2);
const asJson = args.includes("--json");
const files = args.filter((a) => !a.startsWith("--"));
if (files.length === 0) {
  console.error("usage: node scripts/analyze.mjs <export.json>... [--json]");
  process.exit(1);
}

const ARM_ORDER = ["feedback", "informed", "spec-only"];
const ARM_NAME = { feedback: "healing", informed: "informed", "spec-only": "spec-only" };

// ---- helpers ---------------------------------------------------------------

// 95% Wilson score interval for k successes in n trials (sane at k=0, k=n).
function wilson(k, n) {
  if (n === 0) return [0, 0];
  const z = 1.96;
  const p = k / n;
  const denom = 1 + (z * z) / n;
  const centre = (p + (z * z) / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denom;
  return [Math.max(0, centre - half), Math.min(1, centre + half)];
}
const pct = (x) => `${Math.round(x * 100)}%`;
const rate = (k, n) => {
  if (n === 0) return "-";
  const [lo, hi] = wilson(k, n);
  return `${k}/${n} (${pct(k / n)}, CI ${pct(lo)}-${pct(hi)})`;
};
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const fmt = (x, d = 1) => (x == null ? "-" : Number(x).toFixed(d));

// pass->fail transitions of a check between consecutive attempts in one run.
// Only meaningful for the healing arm (the others are independent samples).
function regressions(run) {
  let n = 0;
  for (let i = 1; i < run.attempts.length; i++) {
    const prev = new Map(run.attempts[i - 1].checks.map((c) => [c.name, c.pass]));
    for (const c of run.attempts[i].checks) if (prev.get(c.name) === true && !c.pass) n++;
  }
  return n;
}

const tokens = (r) => r.attempts.reduce((s, a) => s + a.inputTokens + a.outputTokens, 0);
const ms = (r) => r.attempts.reduce((s, a) => s + a.elapsedMs, 0);

// ---- load + group ----------------------------------------------------------

const cells = new Map();
const specGraders = new Map(); // specHash -> Map(graderId -> [cells])
const warnings = [];

for (const file of files) {
  const d = JSON.parse(readFileSync(file, "utf8"));
  if (d.schemaVersion !== 1) {
    warnings.push(`${file}: unsupported schemaVersion ${d.schemaVersion}, skipped`);
    continue;
  }
  const c = d.config;
  const name = c.presetName ?? `custom(${c.specHash})`;
  const key = `${name}\u0000${c.builderModel}`;
  if (!cells.has(key)) {
    cells.set(key, {
      spec: name,
      specHash: c.specHash,
      builder: c.builderModel,
      maxIterations: c.maxIterations,
      runs: [],
      graders: new Set(),
      qual: new Set(),
      tries: [],
      perturb: new Set(),
      checklistSources: new Set(),
      suspects: new Map(),
    });
  }
  const cell = cells.get(key);
  const gid = `${d.graders.validator.hash}/${d.graders.driver?.hash ?? "-"}`;
  cell.graders.add(gid);
  cell.qual.add(c.qualification?.status ?? "unknown");
  cell.tries.push(c.qualification?.tries ?? null);
  cell.perturb.add(JSON.stringify(c.perturbations));
  if (c.informedChecklistSource) cell.checklistSources.add(c.informedChecklistSource);
  for (const s of d.suspectChecks ?? []) cell.suspects.set(s.name, s);
  // Run indices restart per file; keep the file so merged runs stay distinguishable.
  for (const r of d.runs) cell.runs.push({ ...r, file });
  if (!specGraders.has(c.specHash)) specGraders.set(c.specHash, new Map());
  const byG = specGraders.get(c.specHash);
  byG.set(gid, [...(byG.get(gid) ?? []), `${name} / ${c.builderModel}`]);
}

// ---- per-arm metrics -------------------------------------------------------

function armStats(runs, cap) {
  const n = runs.length;
  const firstPass = runs.filter((r) => r.attempts[0]?.status === "passed").length;
  const converged = runs.filter((r) => r.stoppedReason === "converged");
  const iters = converged.map((r) => r.attempts.length);

  // First-attempt failing checks by layer: the bugs the builder started with.
  const firstFail = { data: new Map(), frontend: new Map() };
  for (const r of runs) {
    const a = r.attempts.find((x) => x.checks.length > 0);
    if (!a) continue;
    for (const c of a.checks) {
      if (c.pass) continue;
      const layer = c.layer === "frontend" ? "frontend" : "data";
      firstFail[layer].set(c.name, (firstFail[layer].get(c.name) ?? 0) + 1);
    }
  }
  const top = (m) =>
    [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, v]) => `${k} x${v}`).join("; ") || "-";

  // Attempts where every data-layer check passed (a validator-only grader would
  // have accepted the build) but a frontend check failed. Counts what the driver
  // caught; not a claim about what a validator-only loop would have done next.
  let dataPass = 0;
  let falsePass = 0;
  for (const r of runs)
    for (const a of r.attempts) {
      const data = a.checks.filter((c) => c.layer !== "frontend");
      if (data.length === 0 || !data.every((c) => c.pass)) continue;
      dataPass++;
      if (a.checks.some((c) => c.layer === "frontend" && !c.pass)) falsePass++;
    }

  // Failure stage of every failed attempt (install/startup/validation/generation).
  const stages = {};
  for (const r of runs)
    for (const a of r.attempts)
      if (a.status !== "passed" && a.failureStage) stages[a.failureStage] = (stages[a.failureStage] ?? 0) + 1;

  const stopped = {};
  for (const r of runs) stopped[r.stoppedReason] = (stopped[r.stoppedReason] ?? 0) + 1;

  const p1 = n ? firstPass / n : 0;
  return {
    runs: n,
    firstPass,
    firstPassCi: wilson(firstPass, n),
    converged: converged.length,
    convergedCi: wilson(converged.length, n),
    // Independent-sampling prediction for a fresh-sample arm: 1-(1-p)^cap. A
    // cross-check, not a substitute; it breaks down if the builder repeats mistakes.
    predictedIndependent: n && cap ? 1 - Math.pow(1 - p1, cap) : null,
    medianIterations: median(iters),
    meanIterations: mean(iters),
    maxIterations: iters.length ? Math.max(...iters) : null,
    tokensPerConvergedRun: mean(converged.map(tokens)),
    secondsPerConvergedRun: mean(converged.map(ms)) == null ? null : mean(converged.map(ms)) / 1000,
    // All tokens/time spent, converged or not: the real cost of the arm.
    tokensPerRun: mean(runs.map(tokens)),
    regressions: runs.reduce((s, r) => s + regressions(r), 0),
    stalledAttempts: runs.reduce((s, r) => s + r.attempts.filter((a) => a.stalled).length, 0),
    falsePass: { k: falsePass, n: dataPass },
    firstFailingData: top(firstFail.data),
    firstFailingFrontend: top(firstFail.frontend),
    failureStages: stages,
    stopped,
  };
}

// Gap a - b in convergence rate, with a verdict from interval overlap.
function gap(a, b) {
  if (!a || !b) return null;
  const diff = a.converged / a.runs - b.converged / b.runs;
  const overlap = a.convergedCi[0] <= b.convergedCi[1] && b.convergedCi[0] <= a.convergedCi[1];
  return { diff, separable: !overlap };
}

const rows = [];
for (const cell of cells.values()) {
  const cap = cell.maxIterations;
  const arms = {};
  for (const arm of ARM_ORDER) {
    const runs = cell.runs.filter((r) => r.arm === arm);
    if (runs.length) arms[arm] = armStats(runs, cap);
  }
  rows.push({
    spec: cell.spec,
    builder: cell.builder,
    cap,
    qualification: [...cell.qual].join(", "),
    qualifyTries: cell.tries,
    graders: [...cell.graders].join(", "),
    informedChecklistSource: [...cell.checklistSources].join(", ") || null,
    suspectChecks: [...cell.suspects.values()],
    arms,
    gaps: {
      disclosure: gap(arms["informed"], arms["spec-only"]), // informed - spec-only
      debugging: gap(arms["feedback"], arms["informed"]), // healing - informed
      totalFeedback: gap(arms["feedback"], arms["spec-only"]), // healing - spec-only
    },
  });

  const label = `${cell.spec} / ${cell.builder}`;
  if (cell.graders.size > 1)
    warnings.push(`${label}: ${cell.graders.size} different grader pairs merged into one cell (${[...cell.graders].join(", ")})`);
  if (cell.perturb.size > 1) warnings.push(`${label}: mixed perturbation settings merged into one cell`);
  for (const q of cell.qual)
    if (q !== "qualified") warnings.push(`${label}: graders not qualified (status: ${q}); its numbers are not findings`);
  if (cell.checklistSources.has("authored"))
    warnings.push(`${label}: informed arm used AUTHORED check names (unqualified); do not pool with run-sourced checklists`);
  if (cell.suspects.size)
    warnings.push(`${label}: ${cell.suspects.size} suspect check(s) failed every attempt: ${[...cell.suspects.keys()].join("; ")}. Read each against the spec and generated code`);
  for (const [arm, s] of Object.entries(arms))
    if (s.runs < 20) warnings.push(`${label} [${ARM_NAME[arm]}]: only ${s.runs} runs; treat rates as indicative, see the CI`);
  const counts = Object.values(arms).map((s) => s.runs);
  if (counts.length > 1 && new Set(counts).size > 1)
    warnings.push(`${label}: arms have unequal run counts (${Object.entries(arms).map(([a, s]) => `${ARM_NAME[a]}=${s.runs}`).join(", ")})`);
}
for (const [specHash, byGrader] of specGraders)
  if (byGrader.size > 1)
    warnings.push(
      `spec ${specHash}: cells were scored by DIFFERENT graders, so builder-model comparisons on it are confounded: ` +
        [...byGrader.entries()].map(([g, who]) => `${g} <- ${[...new Set(who)].join(", ")}`).join(" | "),
    );

rows.sort((a, b) => a.spec.localeCompare(b.spec) || a.builder.localeCompare(b.builder));

// ---- output ----------------------------------------------------------------

if (asJson) {
  console.log(JSON.stringify({ rows, warnings }, null, 2));
} else {
  const head = [
    "spec", "builder", "arm", "runs", "attempt-1 pass", "converged (<=cap)", "median it", "mean it",
    "regressions", "data-pass but UI-fail", "tok/converged run", "tok/run (all)", "s/converged run",
  ];
  console.log("| " + head.join(" | ") + " |");
  console.log("|" + head.map(() => "---").join("|") + "|");
  for (const r of rows)
    for (const arm of ARM_ORDER) {
      const s = r.arms[arm];
      if (!s) continue;
      console.log(
        "| " + [
          r.spec, r.builder, ARM_NAME[arm], s.runs, rate(s.firstPass, s.runs), rate(s.converged, s.runs),
          fmt(s.medianIterations), fmt(s.meanIterations),
          arm === "feedback" ? s.regressions : "n/a",
          s.falsePass.n ? rate(s.falsePass.k, s.falsePass.n) : "-",
          fmt(s.tokensPerConvergedRun, 0), fmt(s.tokensPerRun, 0), fmt(s.secondsPerConvergedRun),
        ].join(" | ") + " |",
      );
    }

  console.log("\nArm gaps in convergence rate (percentage points; 'separable' = 95% intervals do not overlap):");
  const g = (x) => (x ? `${x.diff >= 0 ? "+" : ""}${Math.round(x.diff * 100)}pp, ${x.separable ? "separable" : "NOT separable"}` : "n/a (arm missing)");
  for (const r of rows) {
    console.log(`- ${r.spec} / ${r.builder}`);
    console.log(`    disclosure (informed - spec-only):     ${g(r.gaps.disclosure)}`);
    console.log(`    debugging  (healing - informed):       ${g(r.gaps.debugging)}`);
    console.log(`    total feedback (healing - spec-only):  ${g(r.gaps.totalFeedback)}`);
    const c = r.arms["spec-only"];
    if (c && c.predictedIndependent != null)
      console.log(
        `    spec-only observed ${pct(c.converged / c.runs)} vs independent-sampling prediction 1-(1-p)^${r.cap} = ${pct(c.predictedIndependent)}`,
      );
  }

  console.log("\nQualification:");
  for (const r of rows) console.log(`- ${r.spec} / ${r.builder}: ${r.qualification}, tries ${r.qualifyTries.join("/")}, checklist ${r.informedChecklistSource ?? "n/a"}`);

  console.log("\nFirst-failing checks (first validated attempt of each run), by layer:");
  for (const r of rows)
    for (const arm of ARM_ORDER) {
      const s = r.arms[arm];
      if (!s) continue;
      console.log(`- ${r.spec} / ${r.builder} [${ARM_NAME[arm]}]`);
      console.log(`    data:     ${s.firstFailingData}`);
      console.log(`    frontend: ${s.firstFailingFrontend}`);
    }

  console.log("\nFailed attempts by stage, and stopped reasons:");
  for (const r of rows)
    for (const arm of ARM_ORDER) {
      const s = r.arms[arm];
      if (!s) continue;
      console.log(`- ${r.spec} / ${r.builder} [${ARM_NAME[arm]}]: stages ${JSON.stringify(s.failureStages)}, stopped ${JSON.stringify(s.stopped)}, stalled attempts ${s.stalledAttempts}`);
    }

  if (warnings.length) {
    console.log("\nWARNINGS:");
    for (const w of warnings) console.log(`- ${w}`);
  }
}
