import type Anthropic from "@anthropic-ai/sdk";
import { generateCode } from "./anthropic";
import { buildRetryPrompt, buildEscalatedRetryPrompt } from "./spec";
import { validateApp, aggregateChecks } from "./validate";
import { runFuzz } from "./fuzz";
import {
  applyGeneratedFiles,
  getWebContainer,
  runInstall,
  runStart,
} from "./webcontainer";
import {
  collectPreviewErrors,
  initPreviewErrorCapture,
  previewErrorChecks,
  previewErrorCheckpoint,
} from "./previewErrors";
import { drivePreview, registerInteractionDriver } from "./previewDriver";
import type {
  Attempt,
  CheckResult,
  FailureStage,
  GeneratedFile,
  StoppedReason,
} from "./types";
import type { WebContainerProcess } from "@webcontainer/api";

const MAX_STALLS = 2;

// A post-startup check producer: given the running app, returns per-check
// results honoring the shared { name, pass, details } contract. The loop runs a
// list of these after the loopback validator passes and merges their output —
// see where `checkProbes` is built in runAgentLoop.
interface ProbeContext {
  port: number;
  url: string; // the preview tunnel URL (for browser-side probes)
  previewCheckpoint: number; // performance.now() from just before the preview went live
}
interface CheckProbe {
  id: string;
  run: (ctx: ProbeContext) => Promise<CheckResult[]>;
}

// How long to let the live preview iframe load and run its client JS before
// collecting any uncaught client errors. Only paid when the client-error probe
// is on (see `clientErrors` below); a value this size comfortably covers React
// render latency + the iframe fetching and executing the page's inline script.
const PREVIEW_SETTLE_MS = 2_000;

function truncate(text: string, maxChars = 4000): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n…(truncated, ${text.length - maxChars} more chars)`;
}

// Order-independent fingerprint of a generation's files. Two attempts with the
// same fingerprint wrote byte-identical code — a sure sign the model is spinning.
function filesSignature(files: GeneratedFile[]): string {
  return JSON.stringify(
    [...files]
      .sort((a, b) => a.path.localeCompare(b.path))
      .map((f) => [f.path, f.contents]),
  );
}

export interface RunAgentLoopOptions {
  apiKey: string;
  model: string;
  spec: string;
  validatorScript: string;
  maxIterations: number;
  // Environment perturbation: when set, the app is launched with PORT set to
  // this non-default value. An app that honors process.env.PORT comes up on it;
  // one that hardcoded a port comes up elsewhere and fails the startup stage.
  // A genuine, disclosed config-bug probe — not a seeded code bug.
  envPort?: number | null;
  // Environment perturbation: run `npm install --offline`. A dependency-free app
  // installs fine; one that reached for a package fails at the install stage.
  // Catches a builder that ignored a "no npm packages" spec.
  offlineInstall?: boolean;
  // Environment perturbation: after the generated validator passes, run a static
  // black-box fuzz probe (concurrency + malformed input) against the live
  // server. Its checks are merged into the attempt's validation, so a happy-path-
  // correct app that 500s under hostile input still fails and gets fed back.
  fuzz?: boolean;
  // Endpoint the fuzz probe targets (the app's representative path). Defaults to
  // "/". Ignored unless `fuzz` is set.
  fuzzPath?: string;
  // Interaction-level grader. When set, this per-spec driver script is injected
  // into the preview (see previewDriver.ts): after the loopback validator
  // passes, the loop loads the app in its OWN hidden iframe, the driver performs
  // real DOM interactions (type, click, toggle) and asserts on the result, and
  // its checks merge into validation. This is the ONLY grader that can see
  // frontend behavior the served HTML doesn't reveal, so a genuine UI bug fails
  // the attempt and feeds back. Because it owns its iframe (not the visible
  // PreviewPane), it runs in BOTH Build and batch — a frontend spec must be
  // UI-graded in batch too, or "converged" would mean only the server was right.
  interactionDriver?: string;
  // Path the interaction driver loads the app at (its representative page).
  // Defaults to `fuzzPath` then "/". Ignored unless `interactionDriver` is set.
  interactionPath?: string;
  // Environment perturbation: after the generated validator passes, give the
  // live preview iframe a moment to load and then fail the attempt if the page
  // threw an uncaught exception / unhandled rejection in the BROWSER. Catches a
  // "server healthy, client throwing" bug the loopback validator can't see.
  // Timing-dependent on a live preview iframe, so it's meaningful for the
  // interactive Build path — NOT batch, where no preview is rendered (see the
  // note where it's consumed).
  clientErrors?: boolean;
  // Interactive runs leave the converged server listening so its preview stays
  // live. Batch runs must set this false: an orphaned server keeps holding the
  // port and the next run's startup then fails with EADDRINUSE, corrupting the
  // convergence data.
  keepServerAlive?: boolean;
  onAttempt: (attempt: Attempt) => void;
  onPreviewUrl: (url: string | null, port: number | null) => void;
  signal?: AbortSignal;
}

export interface RunAgentLoopResult {
  attempts: Attempt[];
  stoppedReason: StoppedReason;
}

/**
 * Write -> run -> observe -> fix loop. Each iteration asks Claude for code,
 * runs it for real inside the WebContainer, and (if it's not obviously
 * broken) validates it against the per-spec validator generated up front.
 * Whatever actually happened — install failure, crash, wrong response — is fed
 * back verbatim as the next prompt, capped at `maxIterations`. A no-progress
 * guard cuts the loop short when the model returns identical code or reproduces
 * the identical failure, so a stuck run can't burn the whole iteration budget.
 */
// The server from the most recent run, which can outlive it (a converged run keeps
// its server up for the preview; an aborted run can leave one behind). A new run
// kills it first, or the fresh app hits EADDRINUSE and exits 1 before listening.
let liveServer: WebContainerProcess | null = null;

export async function runAgentLoop({
  apiKey,
  model,
  spec,
  validatorScript,
  maxIterations,
  envPort,
  offlineInstall,
  fuzz,
  fuzzPath,
  clientErrors,
  interactionDriver,
  interactionPath,
  keepServerAlive = true,
  onAttempt,
  onPreviewUrl,
  signal,
}: RunAgentLoopOptions): Promise<RunAgentLoopResult> {
  const webcontainer = await getWebContainer();
  if (liveServer) {
    liveServer.kill();
    liveServer = null;
  }
  if (clientErrors) initPreviewErrorCapture(webcontainer);
  // Register the interaction driver once — setPreviewScript applies to every
  // subsequent preview load for the session, so it need not be re-set per attempt.
  if (interactionDriver) await registerInteractionDriver(webcontainer, interactionDriver);

  // Post-startup check probes, in run order. Each returns CheckResult[] honoring
  // the shared { name, pass, details } contract; once the loopback validator
  // passes, the loop runs these against the live server and short-circuits on
  // the first failure. This is the single place checks are composed — the
  // frontend grader (interaction driver) and the opt-in perturbations
  // (fuzz, client-errors) are uniform here, so adding a check is one push, not
  // another bespoke stage. (PORT/offline are stage modifiers on install/startup,
  // not post-validation check producers, so they live elsewhere.)
  // The interaction driver also captures a snapshot of the rendered DOM; the
  // probe returns only checks (uniform pipeline), so it stashes the snapshot
  // here for the loop to attach to the attempt. Reset each attempt.
  const snapshotHolder: { value?: string } = {};

  const checkProbes: CheckProbe[] = [];
  if (interactionDriver) {
    checkProbes.push({
      id: "interaction",
      run: async (ctx) => {
        const { checks, snapshot } = await drivePreview(
          ctx.url,
          interactionPath ?? fuzzPath ?? "/",
        );
        if (snapshot) snapshotHolder.value = snapshot;
        return checks;
      },
    });
  }
  if (fuzz) {
    checkProbes.push({
      id: "fuzz",
      run: (ctx) => runFuzz(webcontainer, ctx.port, fuzzPath ?? "/"),
    });
  }
  if (clientErrors) {
    checkProbes.push({
      id: "client-errors",
      run: async (ctx) => {
        // Let the preview iframe load + run its client JS, then read what threw.
        await new Promise((resolve) => setTimeout(resolve, PREVIEW_SETTLE_MS));
        return previewErrorChecks(collectPreviewErrors(ctx.port, ctx.previewCheckpoint));
      },
    });
  }

  const messages: Anthropic.MessageParam[] = [{ role: "user", content: spec }];
  const attempts: Attempt[] = [];
  let previousProcess: WebContainerProcess | null = null;
  // The files applied to disk on the previous attempt, so each attempt writes
  // only its DELTA (and removes files it dropped) instead of re-mounting the
  // whole tree. null until the first file-writing attempt.
  let prevFiles: GeneratedFile[] | null = null;

  let prevFilesSig: string | null = null;
  let prevFailureSig: string | null = null;
  let consecutiveStalls = 0;
  let stoppedReason: StoppedReason = "max-iterations";

  for (let i = 1; i <= maxIterations; i++) {
    if (signal?.aborted) {
      stoppedReason = "aborted";
      break;
    }

    let attempt: Attempt = { index: i, status: "generating" };
    onAttempt(attempt);

    const startedAt = performance.now();
    let gen: Awaited<ReturnType<typeof generateCode>>;
    try {
      gen = await generateCode(apiKey, model, messages);
    } catch (err) {
      attempt = {
        ...attempt,
        status: "failed",
        error: (err as Error).message,
        usage: { inputTokens: 0, outputTokens: 0, elapsedMs: performance.now() - startedAt },
      };
      onAttempt(attempt);
      attempts.push(attempt);
      throw err; // an API-level failure (bad key, network) won't fix itself on retry
    }
    const usage = {
      inputTokens: gen.inputTokens,
      outputTokens: gen.outputTokens,
      elapsedMs: 0, // filled in once we know the attempt's final outcome
    };
    messages.push({ role: "assistant", content: gen.rawText });

    const filesSig = filesSignature(gen.files);

    // Each terminal failure sets `attempt`'s stage-specific fields and `failure`,
    // then breaks to the shared handling below. Success returns straight out.
    let failure: { stage: FailureStage; report: string; failingChecks?: string[] } | null = null;

    runAttempt: {
      if (gen.files.length === 0) {
        attempt = {
          ...attempt,
          error: "Claude's response contained no file blocks to write.",
        };
        failure = {
          stage: "generation",
          report:
            "Your last response contained no ```file:path``` blocks, so nothing could be written to disk. Respond with ONLY file blocks, no prose.",
        };
        break runAttempt;
      }

      attempt = { ...attempt, files: gen.files, status: "installing" };
      onAttempt(attempt);

      // Apply just this attempt's file delta — the previous build stays on disk
      // and only what changed is written (and dropped files removed).
      await applyGeneratedFiles(webcontainer, prevFiles, gen.files);
      prevFiles = gen.files;

      if (previousProcess) {
        previousProcess.kill();
        previousProcess = null;
      }

      let installLog = "";
      const installExitCode = await runInstall(
        webcontainer,
        (chunk) => {
          installLog += chunk;
        },
        offlineInstall,
      );

      if (installExitCode !== 0) {
        attempt = {
          ...attempt,
          installLog,
          error: `npm install exited with code ${installExitCode}`,
        };
        failure = {
          stage: "installation",
          report: `\`npm install\` failed (exit code ${installExitCode}):\n\n${truncate(installLog)}`,
        };
        break runAttempt;
      }

      attempt = { ...attempt, installLog, status: "starting" };
      onAttempt(attempt);

      let runLog = "";
      const start = await runStart(
        webcontainer,
        (chunk) => {
          runLog += chunk;
        },
        undefined,
        envPort != null ? { PORT: String(envPort) } : undefined,
      );
      previousProcess = start.process;
      liveServer = start.process;

      if (!start.url) {
        const reason = start.timedOut
          ? `the server never started listening within the timeout`
          : `the process exited on its own (code ${start.exitCode}) before it started listening`;
        attempt = {
          ...attempt,
          runLog,
          error: `Server never came up: ${reason}`,
        };
        failure = {
          stage: "startup",
          report: `The app was installed but never started serving requests (${reason}). Captured output:\n\n${truncate(runLog)}`,
        };
        break runAttempt;
      }

      if (envPort != null && start.port !== envPort) {
        attempt = {
          ...attempt,
          runLog,
          error: `Server ignored process.env.PORT: expected to listen on ${envPort}, came up on ${start.port}`,
        };
        failure = {
          stage: "startup",
          report: `The app was started with the environment variable PORT=${envPort}, but it began listening on port ${start.port} instead — it is not honoring process.env.PORT (likely a hardcoded port). Read the port from process.env.PORT and only fall back to a default when it is unset. Captured output:\n\n${truncate(runLog)}`,
        };
        start.process.kill();
        previousProcess = null;
        break runAttempt;
      }

      attempt = { ...attempt, runLog, status: "validating" };
      onAttempt(attempt);
      // Checkpoint before the preview goes live so a later collection only sees
      // client errors from THIS attempt's page, not a prior attempt's.
      const previewAt = previewErrorCheckpoint();
      onPreviewUrl(start.url, start.port);

      let validation = await validateApp(webcontainer, start.port!, validatorScript);

      // The loopback validator only sees served HTML/JSON. Once it's satisfied,
      // run the post-startup check probes against the live server — the frontend
      // grader (drives the real UI) and any opt-in perturbations — merging each
      // probe's checks and short-circuiting on the first failure, so a genuine
      // bug invisible to every server-side check still fails the attempt and
      // feeds back. All probes are composed uniformly (see `checkProbes` above).
      snapshotHolder.value = undefined;
      if (validation.pass && checkProbes.length > 0) {
        const ctx: ProbeContext = {
          port: start.port!,
          url: start.url,
          previewCheckpoint: previewAt,
        };
        for (const probe of checkProbes) {
          const checks = await probe.run(ctx);
          validation = aggregateChecks([...validation.checks, ...checks]);
          if (!validation.pass) break;
        }
      }
      // Carry the rendered snapshot (if the driver ran) onto the attempt, on
      // both the pass and fail paths below — a failing interaction check is
      // exactly the "broken UI" frame worth replaying.
      if (snapshotHolder.value) {
        attempt = { ...attempt, previewSnapshot: snapshotHolder.value };
      }

      if (validation.pass) {
        usage.elapsedMs = performance.now() - startedAt;
        attempt = { ...attempt, status: "passed", validation, usage };
        onAttempt(attempt);
        attempts.push(attempt);
        if (!keepServerAlive) {
          start.process.kill(); // free the port for the next batch run
          previousProcess = null;
          onPreviewUrl(null, null);
        }
        return { attempts, stoppedReason: "converged" }; // else leave server up for preview
      }

      attempt = { ...attempt, validation, error: validation.details };
      failure = {
        stage: "validation",
        report: `The server started, but its behavior is wrong:\n\n${validation.details}\n\nRelevant server output:\n\n${truncate(runLog, 2000)}`,
        failingChecks: validation.checks.filter((c) => !c.pass).map((c) => c.name),
      };

      start.process.kill();
      previousProcess = null;
      onPreviewUrl(null, null);
    }

    // ---- shared failure handling + no-progress guard ----
    // Unreachable when null (the success path returns), but narrows the type.
    if (!failure) continue;
    const failureSig =
      failure.stage === "validation"
        ? `validation::${[...(failure.failingChecks ?? [])].sort().join(",")}`
        : `${failure.stage}::${attempt.error ?? ""}`;

    const filesRepeat = prevFilesSig !== null && filesSig === prevFilesSig;
    const failureRepeat = prevFailureSig !== null && failureSig === prevFailureSig;
    const stalled = filesRepeat || failureRepeat;

    usage.elapsedMs = performance.now() - startedAt;
    attempt = {
      ...attempt,
      status: "failed",
      failureStage: failure.stage,
      usage,
      stalled,
    };
    onAttempt(attempt);
    attempts.push(attempt);

    prevFilesSig = filesSig;
    prevFailureSig = failureSig;
    consecutiveStalls = stalled ? consecutiveStalls + 1 : 0;

    if (consecutiveStalls >= MAX_STALLS) {
      stoppedReason = "no-progress";
      break;
    }

    const stallReason = filesRepeat
      ? "Your last attempt produced byte-identical code to the one before it."
      : "Your last attempt reproduced the exact same failure as the one before it.";
    messages.push({
      role: "user",
      content: stalled
        ? buildEscalatedRetryPrompt(spec, failure.report, stallReason)
        : buildRetryPrompt(spec, failure.report),
    });
  }

  return { attempts, stoppedReason };
}
