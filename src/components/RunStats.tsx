import type { Attempt } from "../lib/types";
import { computeRunStats, computeHealingTimeline } from "../lib/stats";
import { Sparklines, SparklinesLine } from "react-sparklines-typescript";

const STAGE_LABEL: Record<string, string> = {
  generation: "Generation",
  installation: "Install",
  startup: "Start",
  validation: "Validation",
};

// Categorical counts (4 unrelated stages), not a sequence — a labeled list
// reads correctly here; a sparkline would connect them as if index order meant
// something and drop the labels that make "which failure class recurs" legible.
function failureBreakdown(failuresByStage: Record<string, number>) {
  const entries = Object.entries(failuresByStage).filter(([, count]) => count > 0);
  if (entries.length === 0) return null;
  return (
    <ul className="run-stats__failures">
      {entries.map(([stage, count]) => (
        <li key={stage}>
          {STAGE_LABEL[stage] ?? stage}: {count}
        </li>
      ))}
    </ul>
  );
}

// Per-attempt token cost IS a real sequence across attempt index, so a
// sparkline fits here — trend of "is each retry getting cheaper or pricier."
function costSparkline(perAttempt: { inputTokens: number; outputTokens: number }[]) {
  if (perAttempt.length < 2) return null;
  const totalTokens = perAttempt.map((a) => a.inputTokens + a.outputTokens);
  return (
    <Sparklines data={totalTokens} width={100} height={20}>
      <SparklinesLine color="red" />
    </Sparklines>
  );
}

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

  const totals = `${(stats.totalElapsedMs/ 1000).toFixed(1)}s · ${stats.totalInputTokens} in / ${stats.totalOutputTokens} out tokens`;

  return (
    <div className="run-stats">
      <div className="run-stats__header">
        <h2>Run stats</h2>
        {badge}
      </div>
      {failureBreakdown(stats.failuresByStage)}
      {regressionCount > 0 && (
        <p className="run-stats__regressions">
          {regressionCount} check regression{regressionCount === 1 ? "" : "s"}{" "}
          (a passing check later broke)
        </p>
      )}
      {costSparkline(stats.perAttempt)}
      <p className="run-stats__totals">{totals}</p>
    </div>
  );
}