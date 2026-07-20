import type { BatchRun } from "../lib/types";
import { computeBatchSummary } from "../lib/stats";

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

export function BatchSummary({ runs }: { runs: BatchRun[] }) {
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
