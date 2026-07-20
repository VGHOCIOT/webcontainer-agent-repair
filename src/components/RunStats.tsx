import type { Attempt } from "../lib/types";
import { computeRunStats, computeHealingTimeline } from "../lib/stats";

// A lean per-run header. The per-attempt detail — which checks healed, which
// stage each attempt died at, and its token/time cost — now lives in the
// healing timeline (one grid instead of a 2-point sparkline + a stage list that
// duplicated the batch summary). This card just states the run's verdict.
export function RunStats({
  attempts,
  running,
}: {
  attempts: Attempt[];
  running: boolean;
}) {
  const stats = computeRunStats(attempts);
  const { regressionCount } = computeHealingTimeline(attempts);

  // `running` has to come from the parent: stats.converged is false both
  // while a run is still in progress (no "passed" attempt yet) and once it
  // has genuinely failed — without this the badge reads "Failed" mid-loop.
  let badge = null;
  if (running) {
    badge = <span className="run-stats__badge run-stats__badge--pending">Running…</span>;
  } else if (attempts.length > 0) {
    badge = stats.converged ? (
      <span className="run-stats__badge run-stats__badge--success">Converged</span>
    ) : (
      <span className="run-stats__badge run-stats__badge--failure">Failed</span>
    );
  }

  const outcome =
    !running && attempts.length > 0
      ? stats.converged
        ? `Converged in ${stats.iterationsToConvergence} ${
            stats.iterationsToConvergence === 1 ? "attempt" : "attempts"
          }`
        : `Gave up after ${stats.totalAttempts} ${
            stats.totalAttempts === 1 ? "attempt" : "attempts"
          }`
      : null;

  const totals = `${(stats.totalElapsedMs / 1000).toFixed(1)}s · ${stats.totalInputTokens} in / ${stats.totalOutputTokens} out tokens`;

  return (
    <div className="run-stats">
      <div className="run-stats__header">
        <h2>Run stats</h2>
        {badge}
      </div>
      {outcome && <p className="run-stats__outcome">{outcome}</p>}
      {regressionCount > 0 && (
        <p className="run-stats__regressions">
          {regressionCount} check regression{regressionCount === 1 ? "" : "s"}{" "}
          (a passing check later broke)
        </p>
      )}
      {attempts.length > 0 && <p className="run-stats__totals">{totals}</p>}
    </div>
  );
}
