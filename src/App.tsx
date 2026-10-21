import { useEffect, useRef, useState } from "react";
import "./App.css";
import { AttemptLog } from "./components/AttemptLog";
import { PreviewPane } from "./components/PreviewPane";
import { RunStats } from "./components/RunStats";
import { HealingTimeline } from "./components/HealingTimeline";
import { PreviewReplay } from "./components/PreviewReplay";
import { AttemptDiff } from "./components/AttemptDiff";
import { ThemeToggle } from "./components/ThemeToggle";
import { DEFAULT_MODEL, DEFAULT_BUILDER_MODEL } from "./lib/anthropic";
import { runAgentLoop } from "./lib/agentLoop";
import { runBatch } from "./lib/batch";
import { getWebContainer } from "./lib/webcontainer";
import { validateApp } from "./lib/validate";
import { generateValidator } from "./lib/validatorGen";
import { derivePreviewPath } from "./lib/preview";
import { DEFAULT_SPEC, FRONTEND_SPEC } from "./lib/spec";
import { TASKS_SPEC, FILTER_SPEC, SEARCH_SPEC } from "./lib/interactive";
import { generateDriver } from "./lib/driverGen";
import { qualifyGraders, type Qualification } from "./lib/qualify";
import { BatchSummary } from "./components/BatchSummary";
import {
  buildBatchExport,
  downloadJson,
  parseGraderImport,
  shortHash,
  type BatchMeta,
  type GraderRecord,
} from "./lib/exportResults";
import type { Attempt, AttemptUsage, BatchRun, StoppedReason, ValidationResult } from "./lib/types";

const API_KEY_STORAGE_KEY = "webcontainer-agent-repair:anthropic-api-key";
const MODELS = ["claude-sonnet-5", "claude-opus-4-8", "claude-haiku-4-5"];
const MAX_ITERATIONS = 6;
// Built-in spec presets. The REST endpoint keeps the preview as raw JSON; the
// frontend app renders a real little UI in the preview pane.
// `frontend` marks a spec that has a UI worth grading in the browser: for those
// the interaction driver is authored + run automatically (it's a grader, not an
// opt-in perturbation). `driverPath` is the page it drives (the app's HTML root,
// NOT the validator's first probed endpoint, which may be a JSON API). The
// driver itself is model-authored from the spec at run time (see driverGen).
const SPEC_PRESETS: {
  name: string;
  spec: string;
  frontend?: boolean;
  driverPath?: string;
}[] = [
  { name: "REST endpoint", spec: DEFAULT_SPEC },
  { name: "Frontend app", spec: FRONTEND_SPEC, frontend: true, driverPath: "/" },
  { name: "Interactive tasks", spec: TASKS_SPEC, frontend: true, driverPath: "/" },
  { name: "Task filter", spec: FILTER_SPEC, frontend: true, driverPath: "/" },
  { name: "Live search", spec: SEARCH_SPEC, frontend: true, driverPath: "/" },
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
  const [fuzzProbe, setFuzzProbe] = useState(false);
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

  // The frontend grader: a model-authored interaction driver (driverGen), kept
  // in state so it's visible/regenerable and reused across a run's attempts —
  // exactly like the loopback validator, but graded in the browser. Authored by
  // the same strong `validatorModel` (both are grader-side).
  const [driverBody, setDriverBody] = useState<string | null>(null);
  const [driverSpec, setDriverSpec] = useState<string | null>(null);
  const [driverGenModel, setDriverGenModel] = useState<string | null>(null);
  const [driverCheckNames, setDriverCheckNames] = useState<string[]>([]);
  const [driverUsage, setDriverUsage] = useState<AttemptUsage | null>(null);
  const [generatingDriver, setGeneratingDriver] = useState(false);
  const [driverError, setDriverError] = useState<string | null>(null);

  const abortRef = useRef<AbortController | null>(null);

  // Provenance of the graders currently in state (check names + authoring usage
  // + author model), kept in refs because handleBatch reads them in the same
  // tick the graders are (re)generated — state would still be stale there.
  const validatorInfoRef = useRef<Omit<GraderRecord, "source" | "hash"> | null>(null);
  const driverInfoRef = useRef<Omit<GraderRecord, "source" | "hash"> | null>(null);
  // What the most recent batch actually ran with, captured at batch start so the
  // exported JSON describes the run even if the UI is changed before Download.
  const [batchMeta, setBatchMeta] = useState<BatchMeta | null>(null);
  const [importMessage, setImportMessage] = useState<string | null>(null);
  const importInputRef = useRef<HTMLInputElement | null>(null);
  // Outcome of running the current graders against the spec's reference app.
  // Cleared whenever the graders change, since it describes specific scripts.
  const [qualification, setQualification] = useState<Qualification | null>(null);

  // Re-grade state: run the CURRENT validator against the still-running converged
  // build (no re-mount — the server is already up), so an edited/regenerated
  // grader can be re-applied to the same app. Answers "does this build still pass
  // under the stricter validator?" — the grader is the variable, not the code.
  const [regrading, setRegrading] = useState(false);
  const [regradeResult, setRegradeResult] = useState<ValidationResult | null>(null);

  useEffect(() => {
    localStorage.setItem(API_KEY_STORAGE_KEY, apiKey);
  }, [apiKey]);

  const activePreset = SPEC_PRESETS.find((p) => p.spec === spec);
  // Grade the UI in the browser when the spec is a known frontend preset. For a
  // custom (unmatched) spec we can't know, so we attempt it — the model-authored
  // driver self-guards with a `no-interactive-ui` pass if there's nothing to drive.
  const gradeUI = activePreset ? activePreset.frontend === true : true;

  async function generate(): Promise<string> {
    setGeneratingValidator(true);
    setValidatorError(null);
    const startedAt = performance.now();
    try {
      const gen = await generateValidator(apiKey, validatorModel, spec);
      // Reuse the just-generated validator to pick the preview path — the
      // endpoints it probes are the app's real, representative URLs.
      setQualification(null);
      setPreviewPath(derivePreviewPath(gen.script));
      setValidatorScript(gen.script);
      setValidatorSpec(spec);
      setValidatorGenModel(validatorModel);
      setValidatorCheckNames(gen.checkNames);
      const usage = {
        inputTokens: gen.inputTokens,
        outputTokens: gen.outputTokens,
        elapsedMs: performance.now() - startedAt,
      };
      setValidatorUsage(usage);
      validatorInfoRef.current = { checkNames: gen.checkNames, authorModel: validatorModel, usage };
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

  async function generateDriverScript(): Promise<string> {
    setGeneratingDriver(true);
    setDriverError(null);
    const startedAt = performance.now();
    try {
      const gen = await generateDriver(apiKey, validatorModel, spec);
      setQualification(null);
      setDriverBody(gen.driverBody);
      setDriverSpec(spec);
      setDriverGenModel(validatorModel);
      setDriverCheckNames(gen.checkNames);
      const usage = {
        inputTokens: gen.inputTokens,
        outputTokens: gen.outputTokens,
        elapsedMs: performance.now() - startedAt,
      };
      setDriverUsage(usage);
      driverInfoRef.current = { checkNames: gen.checkNames, authorModel: validatorModel, usage };
      return gen.driverBody;
    } finally {
      setGeneratingDriver(false);
    }
  }

  async function ensureDriverScript(): Promise<string> {
    if (
      driverBody === null ||
      driverSpec !== spec ||
      driverGenModel !== validatorModel
    ) {
      return generateDriverScript();
    }
    return driverBody;
  }

  async function handleRegenerateDriver() {
    if (!apiKey.trim()) {
      setDriverError("Enter your Anthropic API key first.");
      return;
    }
    try {
      await generateDriverScript();
    } catch (err) {
      setDriverError((err as Error).message);
    }
  }

  // Load the graders from a previous batch export so this run is scored by the
  // IDENTICAL scripts (e.g. the other builder model's cell of the experiment).
  // Refuses an export authored for a different spec text.
  async function handleImportGraders(file: File) {
    setImportMessage(null);
    try {
      const imp = parseGraderImport(await file.text());
      if (imp.specHash !== (await shortHash(spec))) {
        throw new Error(
          "Those graders were authored for a different spec than the one currently selected.",
        );
      }
      setQualification(null);
      setPreviewPath(derivePreviewPath(imp.validator.source));
      setValidatorScript(imp.validator.source);
      setValidatorSpec(spec);
      setValidatorGenModel(imp.graderModel);
      setValidatorCheckNames(imp.validator.checkNames);
      setValidatorUsage(imp.validator.usage);
      validatorInfoRef.current = {
        checkNames: imp.validator.checkNames,
        authorModel: imp.validator.authorModel,
        usage: imp.validator.usage,
      };
      if (imp.driver) {
        setDriverBody(imp.driver.source);
        setDriverSpec(spec);
        setDriverGenModel(imp.graderModel);
        setDriverCheckNames(imp.driver.checkNames);
        setDriverUsage(imp.driver.usage);
        driverInfoRef.current = {
          checkNames: imp.driver.checkNames,
          authorModel: imp.driver.authorModel,
          usage: imp.driver.usage,
        };
      }
      // Pin the grader-model picker to the author so ensure*() sees them as fresh.
      setValidatorModel(imp.graderModel);
      setImportMessage(
        `Imported validator ${imp.validator.hash}${imp.driver ? ` and driver ${imp.driver.hash}` : ""}.`,
      );
    } catch (err) {
      setImportMessage((err as Error).message);
    }
  }

  // Run the given graders against the spec's reference app. Called by the batch
  // gate; the result is kept in state so it shows in the Graders section.
  async function runQualification(script: string, driver: string | undefined) {
    const q = await qualifyGraders({
      spec,
      validatorScript: script,
      interactionDriver: driver,
      interactionPath: activePreset?.driverPath ?? "/",
    });
    setQualification(q);
    return q;
  }

  async function handleDownloadBatch() {
    if (!batchMeta || batchResults.length === 0) return;
    const data = await buildBatchExport(batchMeta, batchResults);
    const slug = (batchMeta.presetName ?? "custom").toLowerCase().replace(/[^a-z0-9]+/g, "-");
    downloadJson(`batch-${slug}-${batchMeta.builderModel}-${data.config.specHash}.json`, data);
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
    setRegradeResult(null);
    setRunning(true);

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      // Phase 1: (re)generate the graders unless we already have them for this
      // exact spec text — the loopback validator always, the interaction driver
      // only when interaction grading is on. Phase 2: run the loop against them.
      const script = await ensureValidatorScript();
      const driver = gradeUI ? await ensureDriverScript() : undefined;

      const result = await runAgentLoop({
        apiKey,
        model: builderModel,
        spec,
        validatorScript: script,
        maxIterations: MAX_ITERATIONS,
        envPort: portProbe ? PROBE_PORT : null,
        offlineInstall: offlineProbe,
        fuzz: fuzzProbe,
        fuzzPath: previewPath,
        interactionDriver: driver,
        interactionPath: activePreset?.driverPath ?? "/",
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

  // Re-run the current validator against the live converged server. No re-mount:
  // the app is already listening on `previewPort`, so this only re-grades it —
  // useful right after you Regenerate/edit the validator to see whether the same
  // build still passes the changed grader.
  async function handleRegrade() {
    if (running || regrading) return;
    if (previewPort == null) {
      setRunError("No live build to re-grade — Build one first.");
      return;
    }
    if (!validatorScript) {
      setRunError("No validator to re-grade against — Regenerate first.");
      return;
    }
    setRunError(null);
    setRegradeResult(null);
    setRegrading(true);
    try {
      const webcontainer = await getWebContainer();
      const validation = await validateApp(webcontainer, previewPort, validatorScript);
      setRegradeResult(validation);
    } catch (err) {
      setRunError((err as Error).message);
    } finally {
      setRegrading(false);
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
    setRegradeResult(null);
    setBatchProgress({ run: 0, of: batchRuns });
    setRunning(true);

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const script = await ensureValidatorScript();
      // Batch must grade the UI too — the interaction driver runs in its own
      // hidden iframe (not the visible preview), so it works here, and without
      // it a frontend spec's "converged" would mean only the server was right.
      const driver = gradeUI ? await ensureDriverScript() : undefined;

      // Gate: the graders must pass the known-good reference app before they're
      // allowed to score a builder. A custom spec has no reference and proceeds,
      // recorded as unqualified in the export.
      const q = await runQualification(script, driver);
      if (q.status !== "qualified" && q.status !== "no-reference") {
        setRunError(`Batch not started — grader qualification ${q.status}. ${q.message}`);
        return;
      }

      const record = async (
        source: string,
        info: Omit<GraderRecord, "source" | "hash"> | null,
      ): Promise<GraderRecord> => ({
        source,
        hash: await shortHash(source),
        checkNames: info?.checkNames ?? [],
        authorModel: info?.authorModel ?? validatorModel,
        usage: info?.usage ?? null,
      });
      setBatchMeta({
        presetName: activePreset?.name ?? null,
        spec,
        builderModel,
        graderModel: validatorModel,
        maxIterations: MAX_ITERATIONS,
        requestedRuns: batchRuns,
        perturbations: {
          port: portProbe,
          offline: offlineProbe,
          fuzz: fuzzProbe,
        },
        gradeUI,
        validator: await record(script, validatorInfoRef.current),
        driver: driver ? await record(driver, driverInfoRef.current) : null,
        qualification: {
          status: q.status,
          failingChecks: [
            ...q.failing.map((c) => c.name),
            ...q.missedMutants.map((m) => `passed known-bad variant: ${m}`),
          ],
        },
        startedAt: new Date().toISOString(),
      });

      const results = await runBatch({
        apiKey,
        model: builderModel,
        spec,
        validatorScript: script,
        maxIterations: MAX_ITERATIONS,
        envPort: portProbe ? PROBE_PORT : null,
        offlineInstall: offlineProbe,
        fuzz: fuzzProbe,
        fuzzPath: previewPath,
        interactionDriver: driver,
        interactionPath: activePreset?.driverPath ?? "/",
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
        <div>
          <h1>Self-Healing App Builder</h1>
          <p className="app__subtitle">
            Claude writes a small app, runs it for real in a WebContainer, and
            patches it against its own errors — no backend involved.
          </p>
        </div>
        <ThemeToggle />
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
          <span>Grader model</span>
          <select
            value={validatorModel}
            onChange={(e) => setValidatorModel(e.target.value)}
            disabled={running || generatingValidator || generatingDriver}
          >
            {MODELS.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </label>

        <p className="app__hint">
          The builder writes the app every attempt; the grader model authors both
          graders once — the loopback validator and the interaction driver.
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

        <label className="app__probe">
          <input
            type="checkbox"
            checked={fuzzProbe}
            onChange={(e) => setFuzzProbe(e.target.checked)}
            disabled={running}
          />
          <span>
            Fuzz probe — after the validator passes, hit the live server with
            concurrent load and malformed input; a 5xx or a crash under fuzzing
            fails the attempt (surfaces unhandled-input bugs the happy path hides).
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

      <section className="graders">
        <div className="graders__intro">
          <h2>Graders</h2>
          <p>
            How each attempt is judged — both authored once from the spec by the
            grader model, then run deterministically every attempt. The validator
            grades the server over loopback HTTP; the interaction driver grades
            the rendered UI in the browser.
          </p>
          <input
            ref={importInputRef}
            type="file"
            accept="application/json,.json"
            hidden
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = ""; // allow re-importing the same file
              if (file) void handleImportGraders(file);
            }}
          />
          <button
            onClick={() => importInputRef.current?.click()}
            className="button--secondary"
            disabled={running || generatingValidator || generatingDriver}
            title="Reuse the graders from a previous batch export so two runs are scored identically"
          >
            Import graders
          </button>
          {qualification && (
            <div
              className={`app__regrade-result app__regrade-result--${
                qualification.status === "qualified" ? "pass" : "fail"
              }`}
            >
              <strong>{qualification.status}:</strong> {qualification.message}
            </div>
          )}
          {importMessage && <p className="panel__hint">{importMessage}</p>}
        </div>
        <div className="graders__grid">
          <div className="panel">
            <div className="panel__header">
              <div className="panel__title">
                <h3>Validator</h3>
                <span className="panel__where">server · HTTP</span>
              </div>
              <button
                onClick={handleRegenerate}
                className="button--secondary"
                disabled={running || generatingValidator}
              >
                {generatingValidator ? "Generating…" : "Regenerate"}
              </button>
            </div>
            <p className="panel__hint">
              Probes the running server's real responses. Edit the spec and
              regenerate to grade a different app.
            </p>
            {validatorError && <p className="app__error">{validatorError}</p>}
            {generatingValidator && !validatorScript && (
              <p className="panel__empty">Generating validator…</p>
            )}
            {!generatingValidator && !validatorScript && !validatorError && (
              <p className="panel__empty">
                No validator yet — generated automatically when you Build.
              </p>
            )}
            {validatorScript && (
              <>
                {validatorCheckNames.length > 0 && (
                  <ul className="panel__checks">
                    {validatorCheckNames.map((name) => (
                      <li key={name} className="panel__check-chip">
                        {name}
                      </li>
                    ))}
                  </ul>
                )}
                <details className="panel__script">
                  <summary>Validator script</summary>
                  <pre>{validatorScript}</pre>
                </details>
                {validatorUsage && (
                  <p className="panel__usage">
                    {(validatorUsage.elapsedMs / 1000).toFixed(1)}s ·{" "}
                    {validatorUsage.inputTokens} in /{" "}
                    {validatorUsage.outputTokens} out tokens
                  </p>
                )}
              </>
            )}
          </div>

          {gradeUI && (
            <div className="panel">
              <div className="panel__header">
                <div className="panel__title">
                  <h3>Interaction driver</h3>
                  <span className="panel__where">browser · DOM</span>
                </div>
                <button
                  onClick={handleRegenerateDriver}
                  className="button--secondary"
                  disabled={running || generatingDriver}
                >
                  {generatingDriver ? "Generating…" : "Regenerate"}
                </button>
              </div>
              <p className="panel__hint">
                Drives the real UI (type, click, toggle) and asserts on the
                rendered DOM — the layer the loopback validator can't see.
              </p>
              {driverError && <p className="app__error">{driverError}</p>}
              {generatingDriver && !driverBody && (
                <p className="panel__empty">Generating interaction driver…</p>
              )}
              {!generatingDriver && !driverBody && !driverError && (
                <p className="panel__empty">
                  No driver yet — authored automatically when you Build.
                </p>
              )}
              {driverBody && (
                <>
                  {driverCheckNames.length > 0 && (
                    <ul className="panel__checks">
                      {driverCheckNames.map((name) => (
                        <li key={name} className="panel__check-chip">
                          {name}
                        </li>
                      ))}
                    </ul>
                  )}
                  <details className="panel__script">
                    <summary>Driver script</summary>
                    <pre>{driverBody}</pre>
                  </details>
                  {driverUsage && (
                    <p className="panel__usage">
                      {(driverUsage.elapsedMs / 1000).toFixed(1)}s ·{" "}
                      {driverUsage.inputTokens} in / {driverUsage.outputTokens}{" "}
                      out tokens
                    </p>
                  )}
                </>
              )}
            </div>
          )}
        </div>
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
          <PreviewReplay attempts={displayAttempts} />
          <AttemptDiff attempts={displayAttempts} />
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
              <button
                onClick={handleDownloadBatch}
                className="button--secondary"
                disabled={running || !batchMeta}
                title="Download every run, attempt, check (with layer), the grader scripts and the config as JSON"
              >
                Download results (JSON)
              </button>
              <BatchSummary runs={batchResults} />
            </div>
          )}
        </section>
        <section className="app__preview">
          <div className="app__preview-head">
            <h2>Live preview</h2>
            {previewPort != null && (
              <button
                onClick={handleRegrade}
                className="button--secondary"
                disabled={running || regrading || !validatorScript}
                title="Re-run the current validator against the running build (e.g. after editing the validator)"
              >
                {regrading ? "Re-grading…" : "Re-grade"}
              </button>
            )}
          </div>
          {regradeResult && (
            <div
              className={`app__regrade-result app__regrade-result--${
                regradeResult.pass ? "pass" : "fail"
              }`}
            >
              <strong>Re-grade:</strong>{" "}
              {regradeResult.pass
                ? `all ${regradeResult.checks.length} checks passed against the current validator.`
                : `${regradeResult.checks.filter((c) => !c.pass).length} of ${
                    regradeResult.checks.length
                  } checks now fail against the current validator.`}
            </div>
          )}
          <PreviewPane url={previewUrl} port={previewPort} path={previewPath} />
        </section>
      </main>
    </div>
  );
}

export default App;
