import { useEffect, useRef, useState } from "react";
import "./App.css";
import { AttemptLog } from "./components/AttemptLog";
import { PreviewPane } from "./components/PreviewPane";
import { RunStats } from "./components/RunStats";
import { HealingTimeline } from "./components/HealingTimeline";
import { DEFAULT_MODEL, DEFAULT_BUILDER_MODEL } from "./lib/anthropic";
import { runAgentLoop } from "./lib/agentLoop";
import { runBatch } from "./lib/batch";
import { generateValidator } from "./lib/validatorGen";
import { derivePreviewPath } from "./lib/preview";
import { DEFAULT_SPEC, FRONTEND_SPEC } from "./lib/spec";
import { BatchSummary } from "./components/BatchSummary";
import type { Attempt, AttemptUsage, BatchRun, StoppedReason } from "./lib/types";

const API_KEY_STORAGE_KEY = "webcontainer-agent-repair:anthropic-api-key";
const MODELS = ["claude-sonnet-5", "claude-opus-4-8", "claude-haiku-4-5"];
const MAX_ITERATIONS = 6;
// Built-in spec presets. The REST endpoint keeps the preview as raw JSON; the
// frontend app renders a real little UI in the preview pane.
const SPEC_PRESETS = [
  { name: "REST endpoint", spec: DEFAULT_SPEC },
  { name: "Frontend app", spec: FRONTEND_SPEC },
];
// Non-default port the PORT-honoring probe launches the app with (see envPort
// in agentLoop). Anything other than the conventional 3000 fallback works.
const PROBE_PORT = 4001;

function App() {
  const [apiKey, setApiKey] = useState(
    () =>
      localStorage.getItem(API_KEY_STORAGE_KEY) ??
      import.meta.env.VITE_ANTHROPIC_API_KEY ??
      "",
  );
  // Two decoupled models: the builder runs every attempt, the validator author
  // runs once. A weaker builder vs. a stronger grader is the capability gap that
  // makes genuine bugs surface and heal.
  const [builderModel, setBuilderModel] = useState(DEFAULT_BUILDER_MODEL);
  const [validatorModel, setValidatorModel] = useState(DEFAULT_MODEL);
  const [spec, setSpec] = useState(DEFAULT_SPEC);
  // Environment perturbations (disclosed, off by default so the base run is
  // unperturbed): PORT probe checks process.env.PORT is honored; offline install
  // checks the app pulled in no npm packages.
  const [portProbe, setPortProbe] = useState(false);
  const [offlineProbe, setOfflineProbe] = useState(false);
  const [attempts, setAttempts] = useState<Attempt[]>([]);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewPort, setPreviewPort] = useState<number | null>(null);
  // Representative preview path, derived from the generated validator's probed
  // endpoints — no extra AI call. Render mode (page vs JSON) is decided at
  // runtime from the response Content-Type.
  const [previewPath, setPreviewPath] = useState<string>("/");
  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const [stoppedReason, setStoppedReason] = useState<StoppedReason | null>(null);

  // Batch mode: run the identical spec+validator N times so convergence reads as
  // a distribution, not a single anecdote.
  const [batchRuns, setBatchRuns] = useState(5);
  const [batchResults, setBatchResults] = useState<BatchRun[]>([]);
  const [batchProgress, setBatchProgress] = useState<{ run: number; of: number } | null>(null);
  // Which completed batch run's attempts to show in the log/stats/timeline.
  // null = show the live `attempts` (a single run, or the in-flight batch run).
  const [selectedRunIndex, setSelectedRunIndex] = useState<number | null>(null);

  // Mode A: the deterministic validator generated from the current spec, kept
  // in state so it's visible/regenerable and reused across the run's attempts.
  const [validatorScript, setValidatorScript] = useState<string | null>(null);
  const [validatorSpec, setValidatorSpec] = useState<string | null>(null);
  const [validatorGenModel, setValidatorGenModel] = useState<string | null>(null);
  const [validatorCheckNames, setValidatorCheckNames] = useState<string[]>([]);
  const [validatorUsage, setValidatorUsage] = useState<AttemptUsage | null>(null);
  const [generatingValidator, setGeneratingValidator] = useState(false);
  const [validatorError, setValidatorError] = useState<string | null>(null);

  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    localStorage.setItem(API_KEY_STORAGE_KEY, apiKey);
  }, [apiKey]);

  async function generate(): Promise<string> {
    setGeneratingValidator(true);
    setValidatorError(null);
    const startedAt = performance.now();
    try {
      const gen = await generateValidator(apiKey, validatorModel, spec);
      // Reuse the just-generated validator to pick the preview path — the
      // endpoints it probes are the app's real, representative URLs.
      setPreviewPath(derivePreviewPath(gen.script));
      setValidatorScript(gen.script);
      setValidatorSpec(spec);
      setValidatorGenModel(validatorModel);
      setValidatorCheckNames(gen.checkNames);
      setValidatorUsage({
        inputTokens: gen.inputTokens,
        outputTokens: gen.outputTokens,
        elapsedMs: performance.now() - startedAt,
      });
      return gen.script;
    } finally {
      setGeneratingValidator(false);
    }
  }

  async function handleRegenerate() {
    if (!apiKey.trim()) {
      setValidatorError("Enter your Anthropic API key first.");
      return;
    }
    try {
      await generate();
    } catch (err) {
      setValidatorError((err as Error).message);
    }
  }

  // (Re)generate the validator only when stale — the spec text or the
  // validator-author model changed since the current script was produced.
  async function ensureValidatorScript(): Promise<string> {
    if (
      validatorScript === null ||
      validatorSpec !== spec ||
      validatorGenModel !== validatorModel
    ) {
      return generate();
    }
    return validatorScript;
  }

  async function handleStart() {
    if (!apiKey.trim()) {
      setRunError("Enter your Anthropic API key first.");
      return;
    }
    setRunError(null);
    setAttempts([]);
    setPreviewUrl(null);
    setPreviewPort(null);
    setStoppedReason(null);
    setBatchResults([]);
    setSelectedRunIndex(null);
    setRunning(true);

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      // Phase 1: (re)generate the validator unless we already have one for this
      // exact spec text. Phase 2: run the loop against that fixed validator.
      const script = await ensureValidatorScript();

      const result = await runAgentLoop({
        apiKey,
        model: builderModel,
        spec,
        validatorScript: script,
        maxIterations: MAX_ITERATIONS,
        envPort: portProbe ? PROBE_PORT : null,
        offlineInstall: offlineProbe,
        signal: controller.signal,
        onAttempt: (attempt) => {
          setAttempts((prev) => {
            const next = prev.filter((a) => a.index !== attempt.index);
            next.push(attempt);
            next.sort((a, b) => a.index - b.index);
            return next;
          });
        },
        onPreviewUrl: (url, port) => {
          setPreviewUrl(url);
          setPreviewPort(port);
        },
      });
      setStoppedReason(result.stoppedReason);
    } catch (err) {
      setRunError((err as Error).message);
    } finally {
      setRunning(false);
      abortRef.current = null;
    }
  }

  async function handleBatch() {
    if (!apiKey.trim()) {
      setRunError("Enter your Anthropic API key first.");
      return;
    }
    setRunError(null);
    setAttempts([]);
    setPreviewUrl(null);
    setPreviewPort(null);
    setStoppedReason(null);
    setBatchResults([]);
    setSelectedRunIndex(null);
    setBatchProgress({ run: 0, of: batchRuns });
    setRunning(true);

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const script = await ensureValidatorScript();

      const results = await runBatch({
        apiKey,
        model: builderModel,
        spec,
        validatorScript: script,
        maxIterations: MAX_ITERATIONS,
        envPort: portProbe ? PROBE_PORT : null,
        offlineInstall: offlineProbe,
        runs: batchRuns,
        signal: controller.signal,
        onRunStart: (runIndex) => {
          setBatchProgress({ run: runIndex, of: batchRuns });
          setAttempts([]); // show only the currently-executing run's live attempts
        },
        onAttempt: (_runIndex, attempt) => {
          setAttempts((prev) => {
            const next = prev.filter((a) => a.index !== attempt.index);
            next.push(attempt);
            next.sort((a, b) => a.index - b.index);
            return next;
          });
        },
        onRunComplete: (run) => {
          setBatchResults((prev) => [...prev, run]);
        },
      });
      // Land on the last completed run so the stats/timeline show real data
      // instead of the leftover live attempts.
      if (results.length > 0) setSelectedRunIndex(results[results.length - 1].index);
    } catch (err) {
      setRunError((err as Error).message);
    } finally {
      setRunning(false);
      setBatchProgress(null);
      abortRef.current = null;
    }
  }

  function handleStop() {
    abortRef.current?.abort();
  }

  const finished = !running && stoppedReason !== null;

  // The log/stats/timeline show a picked batch run when one is selected,
  // otherwise the live attempts (single run, or the in-flight batch run).
  const selectedRun =
    selectedRunIndex !== null
      ? batchResults.find((r) => r.index === selectedRunIndex)
      : undefined;
  const displayAttempts = selectedRun ? selectedRun.attempts : attempts;

  return (
    <div className="app">
      <header className="app__header">
        <h1>Self-Healing App Builder</h1>
        <p className="app__subtitle">
          Claude writes a small app, runs it for real in a WebContainer, and
          patches it against its own errors — no backend involved.
        </p>
      </header>

      <div className="app__config">
        <label className="field">
          <span>Anthropic API key</span>
          <input
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder="sk-ant-..."
            disabled={running}
          />
        </label>

        <label className="field">
          <span>Builder model</span>
          <select
            value={builderModel}
            onChange={(e) => setBuilderModel(e.target.value)}
            disabled={running}
          >
            {MODELS.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </label>

        <label className="field">
          <span>Validator model</span>
          <select
            value={validatorModel}
            onChange={(e) => setValidatorModel(e.target.value)}
            disabled={running || generatingValidator}
          >
            {MODELS.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </label>

        <p className="app__hint">
          The builder writes the app every attempt; the validator author writes
          the grader once.
        </p>

        <label className="field field--spec">
          <span>Spec</span>
          <div className="spec-presets">
            {SPEC_PRESETS.map((preset) => (
              <button
                key={preset.name}
                type="button"
                onClick={() => setSpec(preset.spec)}
                disabled={running}
                aria-pressed={spec === preset.spec}
                className={`spec-preset${spec === preset.spec ? " spec-preset--active" : ""}`}
              >
                {preset.name}
              </button>
            ))}
          </div>
          <textarea
            value={spec}
            onChange={(e) => setSpec(e.target.value)}
            rows={8}
            disabled={running}
          />
        </label>

        <label className="app__probe">
          <input
            type="checkbox"
            checked={portProbe}
            onChange={(e) => setPortProbe(e.target.checked)}
            disabled={running}
          />
          <span>
            PORT-honoring probe — launch the app with <code>PORT={PROBE_PORT}</code>{" "}
            and fail startup if it comes up on another port (a genuine, disclosed
            config-bug probe).
          </span>
        </label>

        <label className="app__probe">
          <input
            type="checkbox"
            checked={offlineProbe}
            onChange={(e) => setOfflineProbe(e.target.checked)}
            disabled={running}
          />
          <span>
            Offline-install probe — run <code>npm install --offline</code> so any
            attempt to pull in an npm package fails at the install stage (catches
            a builder ignoring "no npm packages").
          </span>
        </label>

        <div className="app__actions">
          <button onClick={handleStart} disabled={running}>
            {running ? "Running…" : "Build"}
          </button>
          <div className="app__batch-control">
            <button
              onClick={handleBatch}
              disabled={running}
              className="button--secondary"
            >
              Run batch
            </button>
            <input
              type="number"
              min={2}
              max={50}
              value={batchRuns}
              onChange={(e) =>
                setBatchRuns(Math.max(2, Math.min(50, Number(e.target.value) || 2)))
              }
              disabled={running}
              aria-label="Number of batch runs"
            />
            <span>runs</span>
          </div>
          {running && (
            <button onClick={handleStop} className="button--secondary">
              Stop
            </button>
          )}
        </div>

        {batchProgress && batchProgress.run > 0 && (
          <p className="app__done">
            Batch: run {batchProgress.run} / {batchProgress.of}…
          </p>
        )}

        {runError && <p className="app__error">{runError}</p>}
        {finished && stoppedReason === "converged" && (
          <p className="app__done app__done--pass">
            Converged after {attempts.length}{" "}
            {attempts.length === 1 ? "attempt" : "attempts"}.
          </p>
        )}
        {finished && stoppedReason === "no-progress" && (
          <p className="app__done app__done--fail">
            Stopped early after {attempts.length} attempts — no progress
            (identical output or a repeated failure).
          </p>
        )}
        {finished && stoppedReason === "max-iterations" && attempts.length > 0 && (
          <p className="app__done app__done--fail">
            Gave up after {MAX_ITERATIONS} attempts without a passing build.
          </p>
        )}
      </div>

      <section className="app__validator">
        <div className="validator__header">
          <h2>Validator</h2>
          <button
            onClick={handleRegenerate}
            className="button--secondary"
            disabled={running || generatingValidator}
          >
            {generatingValidator ? "Generating…" : "Regenerate"}
          </button>
        </div>
        <p className="validator__hint">
          Generated once from the spec, then run deterministically against every
          attempt. Edit the spec and regenerate to grade a different app.
        </p>
        {validatorError && <p className="app__error">{validatorError}</p>}
        {generatingValidator && !validatorScript && (
          <p className="validator__empty">Generating validator…</p>
        )}
        {!generatingValidator && !validatorScript && !validatorError && (
          <p className="validator__empty">
            No validator yet — generated automatically when you Build.
          </p>
        )}
        {validatorScript && (
          <>
            {validatorCheckNames.length > 0 && (
              <ul className="validator__checks">
                {validatorCheckNames.map((name) => (
                  <li key={name} className="validator__check-chip">
                    {name}
                  </li>
                ))}
              </ul>
            )}
            <details className="validator__script">
              <summary>Validator script</summary>
              <pre>{validatorScript}</pre>
            </details>
            {validatorUsage && (
              <p className="validator__usage">
                {(validatorUsage.elapsedMs / 1000).toFixed(1)}s ·{" "}
                {validatorUsage.inputTokens} in / {validatorUsage.outputTokens}{" "}
                out tokens
              </p>
            )}
          </>
        )}
      </section>

      <main className="app__body">
        <section className="app__log">
          <h2>
            Attempt log
            {selectedRun && (
              <span className="app__viewing"> · run #{selectedRun.index}</span>
            )}
          </h2>
          <AttemptLog attempts={displayAttempts} />
        </section>
        <section className="app__stats">
          <RunStats running={running && !selectedRun} attempts={displayAttempts} />
          <HealingTimeline attempts={displayAttempts} />
          {batchResults.length > 0 && (
            <div className="app__batch">
              <h2>Batch results ({batchResults.length})</h2>
              <div className="app__run-picker" role="group" aria-label="Batch runs">
                {batchResults.map((run) => (
                  <button
                    key={run.index}
                    onClick={() => setSelectedRunIndex(run.index)}
                    aria-pressed={selectedRunIndex === run.index}
                    className={`run-chip run-chip--${
                      run.stoppedReason === "converged" ? "pass" : "fail"
                    }${selectedRunIndex === run.index ? " run-chip--active" : ""}`}
                    title={`${run.stoppedReason} · ${run.attempts.length} attempts`}
                  >
                    #{run.index}
                  </button>
                ))}
              </div>
              <BatchSummary runs={batchResults} />
            </div>
          )}
        </section>
        <section className="app__preview">
          <h2>Live preview</h2>
          <PreviewPane url={previewUrl} port={previewPort} path={previewPath} />
        </section>
      </main>
    </div>
  );
}

export default App;
