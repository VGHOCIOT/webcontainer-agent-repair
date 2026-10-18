#!/usr/bin/env node
// Merge batch exports (the JSON from "Download results (JSON)") into the tables
// the write-up needs. Offline, no dependencies:
//
//   node scripts/analyze.mjs results/*.json
//   node scripts/analyze.mjs results/*.json --json   # machine-readable
//
// One row per cell = (spec preset x builder model). Files for the same cell are
// merged. Anything that would make two cells incomparable (different grader
// hashes for the same spec, an unqualified grader, mixed perturbations) is
// printed as a WARNING rather than silently averaged over.

import { readFileSync } from "node:fs";

const args = process.argv.slice(2);
const asJson = args.includes("--json");
const files = args.filter((a) => !a.startsWith("--"));
if (files.length === 0) {
  console.error("usage: node scripts/analyze.mjs <export.json>... [--json]");
  process.exit(1);
}

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
function regressions(run) {
  let n = 0;
  for (let i = 1; i < run.attempts.length; i++) {
    const prev = new Map(run.attempts[i - 1].checks.map((c) => [c.name, c.pass]));
    for (const c of run.attempts[i].checks) if (prev.get(c.name) === true && !c.pass) n++;
  }
  return n;
}

// ---- load + group ----------------------------------------------------------

const cells = new Map(); // key -> { spec, builder, runs[], graders:Set, qual:Set, perturb:Set }
const specGraders = new Map(); // specHash -> Set of "validatorHash/driverHash"
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
      grader: c.graderModel,
      runs: [],
      graders: new Set(),
      qual: new Set(),
      perturb: new Set(),
    });
  }
  const cell = cells.get(key);
  const gid = `${d.graders.validator.hash}/${d.graders.driver?.hash ?? "-"}`;
  cell.graders.add(gid);
  cell.qual.add(c.qualification?.status ?? "unknown");
  cell.perturb.add(JSON.stringify(c.perturbations));
  for (const r of d.runs) cell.runs.push(r);
  if (!specGraders.has(c.specHash)) specGraders.set(c.specHash, new Map());
  specGraders.get(c.specHash).set(gid, [...(specGraders.get(c.specHash).get(gid) ?? []), `${name} / ${c.builderModel}`]);
}

// ---- per-cell metrics ------------------------------------------------------

const rows = [];
for (const cell of cells.values()) {
  const runs = cell.runs;
  const n = runs.length;
  const firstPass = runs.filter((r) => r.attempts[0]?.status === "passed").length;
  const converged = runs.filter((r) => r.stoppedReason === "converged");
  const iters = converged.map((r) => r.attempts.length);

  // Layer of each check on the first attempt that reached the validator.
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
    [...m.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([k, v]) => `${k} x${v}`)
      .join("; ") || "-";

  // False pass of the data layer: attempts where every data-layer check passed
  // (so a validator-only grader would have accepted the build) but a frontend
  // check failed. The driver only runs once the validator passes, so frontend
  // checks exist exactly on those attempts. This is a count of what the driver
  // caught, NOT a claim about what a validator-only loop would have done next.
  let dataPassAttempts = 0;
  let falsePass = 0;
  for (const r of runs)
    for (const a of r.attempts) {
      const data = a.checks.filter((c) => c.layer !== "frontend");
      if (data.length === 0 || !data.every((c) => c.pass)) continue;
      dataPassAttempts++;
      if (a.checks.some((c) => c.layer === "frontend" && !c.pass)) falsePass++;
    }

  const convTokens = converged.map((r) => r.attempts.reduce((s, a) => s + a.inputTokens + a.outputTokens, 0));
  const convMs = converged.map((r) => r.attempts.reduce((s, a) => s + a.elapsedMs, 0));
  const stopped = {};
  for (const r of runs) stopped[r.stoppedReason] = (stopped[r.stoppedReason] ?? 0) + 1;

  rows.push({
    spec: cell.spec,
    builder: cell.builder,
    runs: n,
    firstAttemptPass: rate(firstPass, n),
    converged: rate(converged.length, n),
    medianIterations: median(iters),
    meanIterations: mean(iters),
    maxIterations: iters.length ? Math.max(...iters) : null,
    stopped,
    firstFailingData: top(firstFail.data),
    firstFailingFrontend: top(firstFail.frontend),
    regressions: runs.reduce((s, r) => s + regressions(r), 0),
    falsePass: dataPassAttempts ? rate(falsePass, dataPassAttempts) : "-",
    tokensPerConvergedRun: mean(convTokens),
    secondsPerConvergedRun: mean(convMs) == null ? null : mean(convMs) / 1000,
    graders: [...cell.graders].join(", "),
    qualification: [...cell.qual].join(", "),
  });

  if (cell.graders.size > 1)
    warnings.push(`${cell.spec} / ${cell.builder}: ${cell.graders.size} different grader pairs merged into one cell (${[...cell.graders].join(", ")})`);
  if (cell.perturb.size > 1) warnings.push(`${cell.spec} / ${cell.builder}: mixed perturbation settings merged into one cell`);
  for (const q of cell.qual)
    if (q !== "qualified") warnings.push(`${cell.spec} / ${cell.builder}: graders not qualified (status: ${q}) - its numbers are not trustworthy`);
  if (n < 20) warnings.push(`${cell.spec} / ${cell.builder}: only ${n} runs - treat rates as indicative, see the CI`);
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
    "spec", "builder", "runs", "attempt-1 pass", "converged (<=cap)", "median it", "mean it", "max it",
    "regressions", "data-pass but UI-fail", "tok/converged run", "s/converged run", "qualification", "graders",
  ];
  const body = rows.map((r) => [
    r.spec, r.builder, r.runs, r.firstAttemptPass, r.converged, fmt(r.medianIterations), fmt(r.meanIterations),
    r.maxIterations ?? "-", r.regressions, r.falsePass, fmt(r.tokensPerConvergedRun, 0), fmt(r.secondsPerConvergedRun),
    r.qualification, r.graders,
  ]);
  const table = [head, ...body];
  console.log("| " + head.join(" | ") + " |");
  console.log("|" + head.map(() => "---").join("|") + "|");
  for (const row of body) console.log("| " + row.join(" | ") + " |");
  void table;
  console.log("\nFirst-failing checks (first validated attempt of each run), by layer:");
  for (const r of rows) {
    console.log(`- ${r.spec} / ${r.builder}`);
    console.log(`    data:     ${r.firstFailingData}`);
    console.log(`    frontend: ${r.firstFailingFrontend}`);
  }
  console.log("\nStopped reasons:");
  for (const r of rows) console.log(`- ${r.spec} / ${r.builder}: ${JSON.stringify(r.stopped)}`);
  if (warnings.length) {
    console.log("\nWARNINGS:");
    for (const w of warnings) console.log(`- ${w}`);
  }
}
