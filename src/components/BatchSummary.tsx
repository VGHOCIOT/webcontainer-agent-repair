import type { BatchArm, BatchRun } from "../lib/types";
import { ARM_ORDER, computeArmComparison, computeBatchSummary, computeSuspectChecks } from "../lib/stats";

const STAGE_LABEL: Record<string, string> = {
  generation: "Generation",
  installation: "Install",
  startup: "Start",
  validation: "Validation",
};

const REASON_LABEL: Record<string, string> = {
  converged: "Converged",
  "max-iterations": "Gave up (max iterations)",
  "no-progress": "Stopped (no progress)",
  aborted: "Aborted",
};

function pct(n: number): string {
  return `${Math.round(n * 100)}%`;
}

// A compact ASCII histogram of iterations-to-converge, so the distribution —
// not just the mean — is legible: "did most runs converge in 2, or is it bimodal?"
function iterationsHistogram(values: number[]): { label: string; count: number }[] {
  if (values.length === 0) return [];
  const max = Math.max(...values);
  const buckets: { label: string; count: number }[] = [];
  for (let i = 1; i <= max; i++) {
    buckets.push({ label: String(i), count: values.filter((v) => v === i).length });
  }
  return buckets;
}

const ARM_LABEL: Record<BatchArm, string> = {
  feedback: "Healing (retries see code + error)",
  informed: "Informed (fresh samples see spec + grader check names)",
  "spec-only": "Control (retries see spec only)",
};

const ARM_ROW_LABEL: Record<BatchArm, string> = {
  feedback: "Healing",
  informed: "Informed",
  "spec-only": "Control",
};

function ci([lo, hi]: [number, number]): string {
  return `${pct(lo)}–${pct(hi)}`;
}

// Healing vs. the spec-only control, side by side. Both arms ran the same spec,
// graders and attempt cap, so the convergence gap is what the error feedback
// adds over just trying again. Intervals are 95% Wilson — wide at small n, which
// is the point of showing them.
function ArmComparison({ runs }: { runs: BatchRun[] }) {
  const arms = computeArmComparison(runs);
  if (arms.length < 2) return null;
  const rate = (arm: BatchArm) => arms.find((a) => a.arm === arm)?.convergenceRate;
  const gap = (hi: BatchArm, lo: BatchArm, what: string) => {
    const a = rate(hi);
    const b = rate(lo);
    if (a === undefined || b === undefined) return null;
    const d = Math.round((a - b) * 100);
    return (
      <li key={what}>
        {what}: {d >= 0 ? "+" : ""}
        {d} points of convergence
      </li>
    );
  };
  return (
    <div className="batch-block batch-compare">
      <h4>{arms.map((a) => ARM_ROW_LABEL[a.arm]).join(" vs. ")}</h4>
      <table className="batch-compare__table">
        <thead>
          <tr>
            <th></th>
            <th>runs</th>
            <th>attempt 1 passes</th>
            <th>converged within cap</th>
            <th>median it.</th>
            <th>tokens / converged run</th>
          </tr>
        </thead>
        <tbody>
          {arms.map((a) => (
            <tr key={a.arm}>
              <th scope="row">{ARM_ROW_LABEL[a.arm]}</th>
              <td>{a.runs}</td>
              <td>
                {a.firstAttemptPass}/{a.runs} ({pct(a.firstAttemptRate)}, {ci(a.firstAttemptCi)})
              </td>
              <td>
                {a.converged}/{a.runs} ({pct(a.convergenceRate)}, {ci(a.convergenceCi)})
              </td>
              <td>{a.medianIterations ?? "—"}</td>
              <td>
                {a.tokensPerConvergedRun !== null ? Math.round(a.tokensPerConvergedRun) : "—"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <ul className="batch-summary__totals">
        {gap("informed", "spec-only", "Disclosing the checks (informed over control)")}
        {gap("feedback", "informed", "Debugging from errors (healing over informed)")}
        {gap("feedback", "spec-only", "Total feedback (healing over control)")}
      </ul>
      <p className="batch-summary__totals">
        Intervals overlapping means this batch can't separate the arms.
      </p>
    </div>
  );
}

// Checks that failed in every attempt they appeared in — see computeSuspectChecks.
function SuspectChecks({ runs }: { runs: BatchRun[] }) {
  const suspects = computeSuspectChecks(runs);
  if (suspects.length === 0) return null;
  return (
    <div className="app__regrade-result app__regrade-result--fail">
      <strong>Possible grader defect:</strong> {suspects.length === 1 ? "this check" : "these checks"} failed in every
      attempt it ran in, across all runs and arms. Either no build satisfied it or the check itself is wrong, so read
      it against the spec and the generated code before trusting this batch.
      <ul>
        {suspects.map((c) => (
          <li key={c.name}>
            <code>{c.name}</code> — failed {c.attempts}/{c.attempts} attempts in {c.runs} run{c.runs === 1 ? "" : "s"}
            {c.layer ? ` (${c.layer} layer)` : ""}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function BatchSummary({ runs }: { runs: BatchRun[] }) {
  if (runs.length === 0) return null;
  const arms = ARM_ORDER.filter((a) =>
    runs.some((r) => r.arm === a),
  );
  if (arms.length < 2) {
    return (
      <>
        <SuspectChecks runs={runs} />
        {arms.length === 1 && arms[0] === "spec-only" && (
          <p className="batch-summary__totals">Control arm only: retries saw the spec, not errors.</p>
        )}
        {arms.length === 1 && arms[0] === "informed" && (
          <p className="batch-summary__totals">
            Informed arm only: retries saw the spec and the grader check names, not errors.
          </p>
        )}
        <ArmSummary runs={runs} />
      </>
    );
  }
  return (
    <>
      <SuspectChecks runs={runs} />
      <ArmComparison runs={runs} />
      {arms.map((arm) => (
        <details key={arm} className="batch-arm">
          <summary>{ARM_LABEL[arm]}</summary>
          <ArmSummary runs={runs.filter((r) => r.arm === arm)} />
        </details>
      ))}
    </>
  );
}

function ArmSummary({ runs }: { runs: BatchRun[] }) {
  if (runs.length === 0) return null;
  const s = computeBatchSummary(runs);

  const reasons = Object.entries(s.stoppedReasons).filter(([, c]) => c > 0);
  const stages = Object.entries(s.failuresByStage).filter(([, c]) => c > 0);
  const hist = iterationsHistogram(s.iterationsToConverge);
  const histMax = Math.max(1, ...hist.map((b) => b.count));

  return (
    <div className="batch-summary">
      <div className="batch-summary__headline">
        <div className="batch-stat">
          <span className="batch-stat__value">{pct(s.convergenceRate)}</span>
          <span className="batch-stat__label">
            converged ({s.converged}/{s.runs})
          </span>
        </div>
        <div className="batch-stat">
          <span className="batch-stat__value">
            {s.medianIterations ?? "—"}
          </span>
          <span className="batch-stat__label">median iterations</span>
        </div>
        <div className="batch-stat">
          <span className="batch-stat__value">
            {s.meanIterations !== null ? s.meanIterations.toFixed(1) : "—"}
          </span>
          <span className="batch-stat__label">
            mean{s.maxIterations !== null ? ` · max ${s.maxIterations}` : ""}
          </span>
        </div>
        <div className="batch-stat">
          <span className="batch-stat__value">{s.totalRegressions}</span>
          <span className="batch-stat__label">regressions</span>
        </div>
      </div>

      {hist.length > 0 && (
        <div className="batch-block">
          <h4>Iterations to converge</h4>
          <ul className="batch-hist">
            {hist.map((b) => (
              <li key={b.label}>
                <span className="batch-hist__key">{b.label}</span>
                <span className="batch-hist__bar">
                  <span
                    className="batch-hist__fill"
                    style={{ width: `${(b.count / histMax) * 100}%` }}
                  />
                </span>
                <span className="batch-hist__count">{b.count}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="batch-block">
        <h4>Outcomes</h4>
        <ul className="batch-list">
          {reasons.map(([reason, count]) => (
            <li key={reason}>
              {REASON_LABEL[reason] ?? reason}: {count}
            </li>
          ))}
        </ul>
      </div>

      {stages.length > 0 && (
        <div className="batch-block">
          <h4>Failed attempts by stage</h4>
          <ul className="batch-list">
            {stages.map(([stage, count]) => (
              <li key={stage}>
                {STAGE_LABEL[stage] ?? stage}: {count}
              </li>
            ))}
          </ul>
        </div>
      )}

      {s.firstFailingChecks.length > 0 && (
        <div className="batch-block">
          <h4>Bug classes on first attempt</h4>
          <ul className="batch-list">
            {s.firstFailingChecks.map((c) => (
              <li key={c.name}>
                <code>{c.name}</code>: {c.count}
              </li>
            ))}
          </ul>
        </div>
      )}

      <p className="batch-summary__totals">
        {(s.totalElapsedMs / 1000).toFixed(1)}s · {s.totalInputTokens} in /{" "}
        {s.totalOutputTokens} out tokens across {s.runs} runs
      </p>
    </div>
  );
}
