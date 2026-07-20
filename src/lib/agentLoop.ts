import type Anthropic from "@anthropic-ai/sdk";
import { generateCode } from "./anthropic";
import { buildRetryPrompt, buildEscalatedRetryPrompt } from "./spec";
import { validateApp } from "./validate";
import {
  buildFileTree,
  getWebContainer,
  runInstall,
  runStart,
} from "./webcontainer";
import type {
  Attempt,
  FailureStage,
  GeneratedFile,
  StoppedReason,
} from "./types";
import type { WebContainerProcess } from "@webcontainer/api";

const MAX_STALLS = 2;

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
export async function runAgentLoop({
  apiKey,
  model,
  spec,
  validatorScript,
  maxIterations,
  envPort,
  offlineInstall,
  keepServerAlive = true,
  onAttempt,
  onPreviewUrl,
  signal,
}: RunAgentLoopOptions): Promise<RunAgentLoopResult> {
  const webcontainer = await getWebContainer();
  const messages: Anthropic.MessageParam[] = [{ role: "user", content: spec }];
  const attempts: Attempt[] = [];
  let previousProcess: WebContainerProcess | null = null;

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

      await webcontainer.mount(buildFileTree(gen.files));

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
      onPreviewUrl(start.url, start.port);

      const validation = await validateApp(webcontainer, start.port!, validatorScript);

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
