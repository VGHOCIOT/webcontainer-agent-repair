import { useEffect, useRef, useState } from "react";
import "./App.css";
import { AttemptLog } from "./components/AttemptLog";
import { PreviewPane } from "./components/PreviewPane";
import { DEFAULT_MODEL } from "./lib/anthropic";
import { runAgentLoop } from "./lib/agentLoop";
import { DEFAULT_SPEC } from "./lib/spec";
import type { Attempt } from "./lib/types";

const API_KEY_STORAGE_KEY = "webcontainer-agent-repair:anthropic-api-key";
const MODELS = ["claude-sonnet-5", "claude-opus-4-8", "claude-haiku-4-5"];
const MAX_ITERATIONS = 1;

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
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    localStorage.setItem(API_KEY_STORAGE_KEY, apiKey);
  }, [apiKey]);

  const lastAttempt = attempts[attempts.length - 1];
  const finished =
    !running &&
    (lastAttempt?.status === "passed" || attempts.length >= MAX_ITERATIONS);

  async function handleStart() {
    if (!apiKey.trim()) {
      setRunError("Enter your Anthropic API key first.");
      return;
    }
    setRunError(null);
    setAttempts([]);
    setPreviewUrl(null);
    setPreviewPort(null);
    setRunning(true);

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      await runAgentLoop({
        apiKey,
        model,
        spec,
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
        {finished && lastAttempt?.status === "passed" && (
          <p className="app__done app__done--pass">
            Converged after {attempts.length}{" "}
            {attempts.length === 1 ? "attempt" : "attempts"}.
          </p>
        )}
        {finished &&
          lastAttempt?.status !== "passed" &&
          attempts.length > 0 && (
            <p className="app__done app__done--fail">
              Gave up after {MAX_ITERATIONS} attempts without a passing
              build.
            </p>
          )}
      </div>

      <main className="app__body">
        <section className="app__log">
          <h2>Attempt log</h2>
          <AttemptLog attempts={attempts} />
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
