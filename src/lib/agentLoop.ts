import type Anthropic from "@anthropic-ai/sdk";
import { generateCode } from "./anthropic";
import { buildRetryPrompt } from "./spec";
import { validateApp } from "./validate";
import {
  buildFileTree,
  getWebContainer,
  runInstall,
  runStart,
} from "./webcontainer";
import type { Attempt } from "./types";
import type { WebContainerProcess } from "@webcontainer/api";

function truncate(text: string, maxChars = 4000): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n…(truncated, ${text.length - maxChars} more chars)`;
}

export interface RunAgentLoopOptions {
  apiKey: string;
  model: string;
  spec: string;
  maxIterations: number;
  onAttempt: (attempt: Attempt) => void;
  onPreviewUrl: (url: string | null, port: number | null) => void;
  signal?: AbortSignal;
}

/**
 * Write -> run -> observe -> fix loop. Each iteration asks Claude for code,
 * runs it for real inside the WebContainer, and (if it's not obviously
 * broken) hits the endpoint it's supposed to implement. Whatever actually
 * happened — install failure, crash, wrong response — is fed back verbatim
 * as the next prompt, capped at `maxIterations` so a bad loop can't run
 * forever or burn the API budget.
 */
export async function runAgentLoop({
  apiKey,
  model,
  spec,
  maxIterations,
  onAttempt,
  onPreviewUrl,
  signal,
}: RunAgentLoopOptions): Promise<Attempt[]> {
  const webcontainer = await getWebContainer();
  const messages: Anthropic.MessageParam[] = [{ role: "user", content: spec }];
  const attempts: Attempt[] = [];
  let previousProcess: WebContainerProcess | null = null;

  for (let i = 1; i <= maxIterations; i++) {
    if (signal?.aborted) break;

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

    if (gen.files.length === 0) {
      usage.elapsedMs = performance.now() - startedAt;
      attempt = {
        ...attempt,
        status: "failed",
        error: "Claude's response contained no file blocks to write.",
        usage,
        failureStage: "generation",
      };
      onAttempt(attempt);
      attempts.push(attempt);
      messages.push({
        role: "user",
        content: buildRetryPrompt(
          spec,
          "Your last response contained no ```file:path``` blocks, so nothing could be written to disk. Respond with ONLY file blocks, no prose.",
        ),
      });
      continue;
    }

    attempt = { ...attempt, files: gen.files, status: "installing" };
    onAttempt(attempt);

    await webcontainer.mount(buildFileTree(gen.files));

    if (previousProcess) {
      previousProcess.kill();
      previousProcess = null;
    }

    let installLog = "";
    const installExitCode = await runInstall(webcontainer, (chunk) => {
      installLog += chunk;
    });

    if (installExitCode !== 0) {
      usage.elapsedMs = performance.now() - startedAt;
      attempt = {
        ...attempt,
        status: "failed",
        installLog,
        error: `npm install exited with code ${installExitCode}`,
        usage,
        failureStage: "installation",
      };
      onAttempt(attempt);
      attempts.push(attempt);
      messages.push({
        role: "user",
        content: buildRetryPrompt(
          spec,
          `\`npm install\` failed (exit code ${installExitCode}):\n\n${truncate(installLog)}`,
        ),
      });
      continue;
    }

    attempt = { ...attempt, installLog, status: "starting" };
    onAttempt(attempt);

    let runLog = "";
    const start = await runStart(webcontainer, (chunk) => {
      runLog += chunk;
    });
    previousProcess = start.process;

    if (!start.url) {
      usage.elapsedMs = performance.now() - startedAt;
      const reason = start.timedOut
        ? `the server never started listening within the timeout`
        : `the process exited on its own (code ${start.exitCode}) before it started listening`;
      attempt = {
        ...attempt,
        status: "failed",
        runLog,
        error: `Server never came up: ${reason}`,
        usage,
        failureStage: "startup",
      };
      onAttempt(attempt);
      attempts.push(attempt);
      messages.push({
        role: "user",
        content: buildRetryPrompt(
          spec,
          `The app was installed but never started serving requests (${reason}). Captured output:\n\n${truncate(runLog)}`,
        ),
      });
      continue;
    }

    attempt = { ...attempt, runLog, status: "validating" };
    onAttempt(attempt);
    onPreviewUrl(start.url, start.port);

    const validation = await validateApp(webcontainer, start.port!);
    usage.elapsedMs = performance.now() - startedAt;

    if (validation.pass) {
      attempt = { ...attempt, status: "passed", validation, usage };
      onAttempt(attempt);
      attempts.push(attempt);
      return attempts; // success — leave the server running for the preview pane
    }

    attempt = {
      ...attempt,
      status: "failed",
      validation,
      error: validation.details,
      usage,
      failureStage: "validation",
    };
    onAttempt(attempt);
    attempts.push(attempt);

    start.process.kill();
    previousProcess = null;
    onPreviewUrl(null, null);

    messages.push({
      role: "user",
      content: buildRetryPrompt(
        spec,
        `The server started, but its behavior is wrong:\n\n${validation.details}\n\nRelevant server output:\n\n${truncate(runLog, 2000)}`,
      ),
    });
  }

  return attempts;
}
