import type { Attempt } from "../lib/types";

const STATUS_LABEL: Record<Attempt["status"], string> = {
  generating: "Generating code…",
  installing: "Installing dependencies…",
  starting: "Starting server…",
  validating: "Running checks…",
  passed: "Passed",
  failed: "Failed",
};

function formatUsage(attempt: Attempt): string | null {
  if (!attempt.usage) return null;
  const { inputTokens, outputTokens, elapsedMs } = attempt.usage;
  return `${(elapsedMs / 1000).toFixed(1)}s · ${inputTokens} in / ${outputTokens} out tokens`;
}

function AttemptCard({ attempt }: { attempt: Attempt }) {
  return (
    <li className={`attempt attempt--${attempt.status}`}>
      <div className="attempt__header">
        <span className="attempt__index">Attempt {attempt.index}</span>
        <span className="attempt__status">{STATUS_LABEL[attempt.status]}</span>
      </div>
      {attempt.files && (
        <div className="attempt__files">
          {attempt.files.map((f) => (
            <details key={f.path} className="attempt__file">
              <summary>{f.path}</summary>
              <pre>{f.contents}</pre>
            </details>
          ))}
        </div>
      )}
      {attempt.error && <div className="attempt__error">{attempt.error}</div>}
      {attempt.status === "passed" && attempt.validation && (
        <div className="attempt__success">{attempt.validation.details}</div>
      )}
      {formatUsage(attempt) && (
        <div className="attempt__usage">{formatUsage(attempt)}</div>
      )}
    </li>
  );
}

export function AttemptLog({ attempts }: { attempts: Attempt[] }) {
  if (attempts.length === 0) {
    return <p className="attempt-log__empty">No attempts yet.</p>;
  }
  return (
    <ul className="attempt-log">
      {attempts.map((attempt) => (
        <AttemptCard key={attempt.index} attempt={attempt} />
      ))}
    </ul>
  );
}
