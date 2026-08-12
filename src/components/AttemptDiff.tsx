import type { Attempt } from "../lib/types";
import { computeAttemptDiffs, type FileChange } from "../lib/diff";

const KIND_LABEL: Record<FileChange["kind"], string> = {
  added: "added",
  removed: "removed",
  modified: "modified",
};

function ChangeBody({ change }: { change: FileChange }) {
  if (change.kind === "modified") {
    return (
      <pre className="attempt-diff__hunk">
        {change.hunks?.map((line, i) => (
          <div key={i} className={`attempt-diff__line attempt-diff__line--${line.type}`}>
            <span className="attempt-diff__sign">
              {line.type === "add" ? "+" : line.type === "del" ? "-" : " "}
            </span>
            {line.text}
          </div>
        ))}
      </pre>
    );
  }
  // Added / removed: show the whole file, tinted by direction.
  const sign = change.kind === "added" ? "+" : "-";
  const type = change.kind === "added" ? "add" : "del";
  return (
    <pre className="attempt-diff__hunk">
      {(change.contents ?? "").split("\n").map((text, i) => (
        <div key={i} className={`attempt-diff__line attempt-diff__line--${type}`}>
          <span className="attempt-diff__sign">{sign}</span>
          {text}
        </div>
      ))}
    </pre>
  );
}

/**
 * The source-level companion to the healing timeline: for each attempt after
 * the first, what files the model changed and the line-level edit. Lets you
 * read *which edit* healed a check or introduced a regression, not just that
 * one flipped. First file-writing attempt is shown as the initial write.
 */
export function AttemptDiff({ attempts }: { attempts: Attempt[] }) {
  const diffs = computeAttemptDiffs(attempts);
  if (diffs.length === 0) return null;

  return (
    <div className="attempt-diff">
      <h3>Code changes</h3>
      {diffs.map((diff) => (
        <div key={diff.index} className="attempt-diff__attempt">
          <div className="attempt-diff__attempt-head">
            <span className="attempt-diff__attempt-title">
              Attempt {diff.index}
              {diff.baseIndex === null ? (
                <span className="attempt-diff__base"> · initial write</span>
              ) : (
                <span className="attempt-diff__base"> · vs attempt {diff.baseIndex}</span>
              )}
            </span>
            {diff.changes.length === 0 && (
              <span className="attempt-diff__unchanged">no file changes</span>
            )}
          </div>
          {diff.changes.map((change) => (
            <details key={change.path} className="attempt-diff__file">
              <summary>
                <span className={`attempt-diff__kind attempt-diff__kind--${change.kind}`}>
                  {KIND_LABEL[change.kind]}
                </span>
                <span className="attempt-diff__path">{change.path}</span>
                <span className="attempt-diff__stat">
                  {change.added > 0 && (
                    <span className="attempt-diff__stat-add">+{change.added}</span>
                  )}
                  {change.removed > 0 && (
                    <span className="attempt-diff__stat-del">−{change.removed}</span>
                  )}
                </span>
              </summary>
              <ChangeBody change={change} />
            </details>
          ))}
        </div>
      ))}
    </div>
  );
}
