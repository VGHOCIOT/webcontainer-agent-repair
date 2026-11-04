import { useRef, useState } from "react";
import { downloadJson } from "../lib/exportResults";
import {
  buildEvalExport,
  qualifiedRate,
  runGraderEval,
  type EvalSample,
  type EvalSpec,
} from "../lib/graderEval";

interface Props {
  apiKey: string;
  graderModel: string;
  specs: EvalSpec[];
  // Another run (build, batch) owns the shared WebContainer.
  blocked: boolean;
  onRunningChange: (running: boolean) => void;
}

const pct = (x: number) => `${Math.round(x * 100)}%`;

export function GraderEval({ apiKey, graderModel, specs, blocked, onRunningChange }: Props) {
  const [selected, setSelected] = useState<Set<string>>(() => new Set(specs.map((s) => s.name)));
  const [perSpec, setPerSpec] = useState(2);
  const [samples, setSamples] = useState<EvalSample[]>([]);
  const [progress, setProgress] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ranWith, setRanWith] = useState<{ model: string; perSpec: number } | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const chosen = specs.filter((s) => selected.has(s.name));

  function toggle(name: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }

  async function start() {
    if (!apiKey.trim()) {
      setError("Enter your Anthropic API key first.");
      return;
    }
    setError(null);
    setSamples([]);
    setRanWith({ model: graderModel, perSpec });
    setRunning(true);
    onRunningChange(true);
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      await runGraderEval({
        apiKey,
        model: graderModel,
        specs: chosen,
        samples: perSpec,
        signal: controller.signal,
        onSample: (s) => setSamples((prev) => [...prev, s]),
        onProgress: (name, n) => setProgress(`${name} · sample ${n} of ${perSpec}`),
      });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setProgress(null);
      setRunning(false);
      onRunningChange(false);
    }
  }

  async function download() {
    if (!ranWith || samples.length === 0) return;
    const data = await buildEvalExport(ranWith.model, ranWith.perSpec, samples);
    downloadJson(`grader-eval-${ranWith.model}-${data.promptHashes.driver}.json`, data);
  }

  const rows = chosen.filter((s) => samples.some((x) => x.specName === s.name));

  return (
    <details className="card card--collapsible">
      <summary>
        Grader eval <span className="card__sub">optional · measures grader reliability, no builder calls</span>
      </summary>
      <p className="card__hint">
        Authors a fresh validator + driver for each spec and qualifies it once (no retry) against that
        spec's reference app, its differently built correct variants, and its known-broken variants. The
        qualified rate is how often the grader-authoring prompts produce a trustworthy grader — re-run
        after changing them. Uses the Grader model above; only grader authoring is billed.
      </p>
      <div className="field">
        <span>Specs</span>
        <div className="toggle-group" role="group" aria-label="Specs to evaluate">
          {specs.map((s) => (
            <button
              key={s.name}
              type="button"
              className="toggle-chip"
              aria-pressed={selected.has(s.name)}
              onClick={() => toggle(s.name)}
              disabled={running}
            >
              {s.name}
            </button>
          ))}
        </div>
      </div>
      <div className="setup-grid">
        <label className="field field--compact">
          <span>Samples per spec</span>
          <input
            type="number"
            min={1}
            max={10}
            value={perSpec}
            onChange={(e) => setPerSpec(Math.max(1, Math.min(10, Number(e.target.value) || 1)))}
            disabled={running}
          />
        </label>
      </div>
      <div className="card__head">
        {running && (
          <button type="button" className="btn btn--secondary btn--sm" onClick={() => abortRef.current?.abort()}>
            Stop
          </button>
        )}
        <button
          type="button"
          className="btn btn--primary btn--sm"
          onClick={start}
          disabled={running || blocked || chosen.length === 0}
        >
          {running ? "Running…" : `Run eval (${chosen.length * perSpec} grader pairs)`}
        </button>
      </div>
      {progress && <p className="card__hint">Now: {progress}</p>}
      {error && <p className="card__hint">{error}</p>}

      {rows.length > 0 && (
        <>
          <table className="batch-compare__table">
            <thead>
              <tr>
                <th>Spec</th>
                <th>Qualified</th>
                <th>Samples</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((spec) => {
                const mine = samples.filter((x) => x.specName === spec.name);
                return (
                  <tr key={spec.name}>
                    <th>{spec.name}</th>
                    <td>
                      {mine.filter((x) => x.status === "qualified").length}/{mine.length}
                    </td>
                    <td>
                      {mine.map((x) => (
                        <span
                          key={x.sample}
                          className={`run-chip run-chip--${x.status === "qualified" ? "pass" : "fail"}`}
                          title={x.message}
                        >
                          {x.status}
                        </span>
                      ))}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <p className="card__hint">
            Overall qualified: {pct(qualifiedRate(samples))} ({samples.filter((x) => x.status === "qualified").length}/
            {samples.length}). Hover a status for why; the download has every grader's source and failing checks.
          </p>
          <div className="card__head">
            <button type="button" className="btn btn--secondary btn--sm" onClick={download} disabled={running}>
              Download eval (JSON)
            </button>
          </div>
        </>
      )}
    </details>
  );
}
