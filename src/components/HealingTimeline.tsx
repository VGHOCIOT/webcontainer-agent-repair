import type { Attempt } from "../lib/types";
import { computeHealingTimeline, type CellState, type TimelineRow } from "../lib/stats";

const CELL_GLYPH: Record<CellState, string> = {
  pass: "✓",
  fail: "✗",
  absent: "–",
};

const STAGE_ABBR: Record<string, string> = {
  generation: "gen",
  installation: "install",
  startup: "start",
  validation: "checks",
};

function formatTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

// The per-attempt outcome shown in the Result row: converged, failed at a
// pre-validation stage (named), or how many checks were still failing.
function resultLabel(row: TimelineRow, checkNames: string[]): string {
  if (row.status === "passed") return "✓ pass";
  if (row.reachedValidation) {
    const failed = checkNames.filter((n) => row.cells[n] === "fail").length;
    return `${failed}✗`;
  }
  if (row.failureStage) return STAGE_ABBR[row.failureStage] ?? row.failureStage;
  return "…";
}

/**
 * check × attempt grid. Rows are the validator's named checks, columns are
 * every attempt (including ones that died before validation). A cell that went
 * pass -> fail from the previous validated attempt is flagged as a regression.
 * Two footer rows fold in the rest of the CLAUDE.md triad: each attempt's
 * outcome and its token/time cost, aligned under the same column.
 */
export function HealingTimeline({ attempts }: { attempts: Attempt[] }) {
  const { checkNames, rows, regressions, regressionCount } =
    computeHealingTimeline(attempts);

  if (rows.length === 0) {
    return null;
  }

  const regressed = new Set(
    regressions.map((r) => `${r.checkName}@${r.atAttempt}`),
  );

  return (
    <div className="timeline">
      <div className="timeline__header">
        <h3>Healing timeline</h3>
        {regressionCount > 0 && (
          <span className="timeline__regressions">
            {regressionCount} regression{regressionCount === 1 ? "" : "s"}
          </span>
        )}
      </div>
      <div className="timeline__scroll">
        <table className="timeline__grid">
          <thead>
            <tr>
              <th className="timeline__check-head">Attempt</th>
              {rows.map((row) => (
                <th
                  key={row.index}
                  className={`timeline__attempt-head timeline__attempt-head--${row.status}`}
                >
                  {row.index}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {checkNames.map((name) => (
              <tr key={name}>
                <td className="timeline__check-name">{name}</td>
                {rows.map((row) => {
                  const state = row.cells[name];
                  const isRegression = regressed.has(`${name}@${row.index}`);
                  return (
                    <td
                      key={row.index}
                      className={`timeline__cell timeline__cell--${state}${
                        isRegression ? " timeline__cell--regression" : ""
                      }`}
                      title={isRegression ? "Regressed here" : state}
                    >
                      {CELL_GLYPH[state]}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="timeline__result-row">
              <td className="timeline__check-name">Result</td>
              {rows.map((row) => (
                <td
                  key={row.index}
                  className={`timeline__result timeline__result--${row.status}`}
                >
                  {resultLabel(row, checkNames)}
                </td>
              ))}
            </tr>
            <tr className="timeline__cost-row">
              <td className="timeline__check-name">Cost</td>
              {rows.map((row) => (
                <td key={row.index} className="timeline__cost">
                  <span className="timeline__cost-tok">
                    {formatTokens(row.inputTokens + row.outputTokens)}
                  </span>
                  <span className="timeline__cost-time">
                    {(row.elapsedMs / 1000).toFixed(1)}s
                  </span>
                </td>
              ))}
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
}
