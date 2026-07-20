import type { Attempt } from "../lib/types";
import { computeHealingTimeline, type CellState } from "../lib/stats";

const CELL_GLYPH: Record<CellState, string> = {
  pass: "✓",
  fail: "✗",
  absent: "–",
};

/**
 * check × attempt grid. Rows are the validator's named checks, columns are the
 * attempts that reached validation. A cell that went pass -> fail from the
 * previous validated attempt is flagged as a regression — the loop "fixing"
 * one thing and breaking another is exactly what this is meant to surface.
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
              <th className="timeline__check-head">Check</th>
              {rows.map((row) => (
                <th key={row.index} className="timeline__attempt-head">
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
        </table>
      </div>
    </div>
  );
}
