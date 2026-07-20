import { useEffect, useRef, useState } from "react";
import "./App.css";
import { AttemptLog } from "./components/AttemptLog";
import { PreviewPane } from "./components/PreviewPane";
import { RunStats } from "./components/RunStats";
import { HealingTimeline } from "./components/HealingTimeline";
import { DEFAULT_MODEL } from "./lib/anthropic";
import { runAgentLoop } from "./lib/agentLoop";
import { generateValidator } from "./lib/validatorGen";
import { DEFAULT_SPEC } from "./lib/spec";
import type { Attempt, AttemptUsage, StoppedReason } from "./lib/types";

const API_KEY_STORAGE_KEY = "webcontainer-agent-repair:anthropic-api-key";
const MODELS = ["claude-sonnet-5", "claude-opus-4-8", "claude-haiku-4-5"];
const MAX_ITERATIONS = 6;

function App() {
  const [apiKey, setApiKey] = useState(
    () =>
      localStorage.getItem(API_KEY_STORAGE_KEY) ??
      import.meta.env.VITE_ANTHROPIC_API_KEY ??
      "",
  );
  const [model, setModel] = useState(DEFAULT_MODEL);
  const [spec, setSpec] = useState(DEFAULT_SPEC);
  const [attempts, setAttempts] = useState<Attempt[]>([]);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewPort, setPreviewPort] = useState<number | null>(null);
  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const [stoppedReason, setStoppedReason] = useState<StoppedReason | null>(null);

  // Mode A: the deterministic validator generated from the current spec, kept
  // in state so it's visible/regenerable and reused across the run's attempts.
  const [validatorScript, setValidatorScript] = useState<string | null>(null);
  const [validatorSpec, setValidatorSpec] = useState<string | null>(null);
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
      const gen = await generateValidator(apiKey, model, spec);
      setValidatorScript(gen.script);
      setValidatorSpec(spec);
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
    setRunning(true);

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      // Phase 1: (re)generate the validator unless we already have one for this
      // exact spec text. Phase 2: run the loop against that fixed validator.
      let script = validatorScript;
      if (script === null || validatorSpec !== spec) {
        script = await generate();
      }

      const result = await runAgentLoop({
        apiKey,
        model,
        spec,
        validatorScript: script,
        maxIterations: MAX_ITERATIONS,
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

  function handleStop() {
    abortRef.current?.abort();
  }

  const finished = !running && stoppedReason !== null;

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
          <span>Model</span>
          <select
            value={model}
            onChange={(e) => setModel(e.target.value)}
            disabled={running}
          >
            {MODELS.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </label>

        <label className="field field--spec">
          <span>Spec</span>
          <textarea
            value={spec}
            onChange={(e) => setSpec(e.target.value)}
            rows={8}
            disabled={running}
          />
        </label>

        <div className="app__actions">
          <button onClick={handleStart} disabled={running}>
            {running ? "Running…" : "Build"}
          </button>
          {running && (
            <button onClick={handleStop} className="button--secondary">
              Stop
            </button>
          )}
        </div>

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
          <h2>Attempt log</h2>
          <AttemptLog attempts={attempts} />
        </section>
        <section className="app__stats">
          <RunStats running={running} attempts={attempts} />
          <HealingTimeline attempts={attempts} />
        </section>
        <section className="app__preview">
          <h2>Live preview</h2>
          <PreviewPane url={previewUrl} port={previewPort} />
        </section>
      </main>
    </div>
  );
}

export default App;
