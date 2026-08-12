import { PreviewMessageType } from "@webcontainer/api";
import type { PreviewMessage, WebContainer } from "@webcontainer/api";
import type { CheckResult } from "./types";

// A "server healthy, client throwing" signal. The generated validator and the
// fuzz probe both hit the server over loopback HTTP — they never execute the
// page's client-side JavaScript. An app whose served HTML throws in the browser
// (bad inline script, a fetch that rejects unhandled) can therefore start fine,
// answer the validator correctly, and still be visibly broken in the preview.
//
// WebContainer surfaces exactly those failures: it injects a forwarder into
// every preview page and re-emits the page's uncaught exceptions / unhandled
// rejections to us as `preview-message` events. We buffer them here so an
// attempt can be failed on a client-side throw and the stack fed back like any
// other stage — see the client-error probe in agentLoop.ts.
//
// We deliberately ignore ConsoleError: a stray console.error is common and not
// necessarily a defect, and folding it into pass/fail would make the grader
// noisy. Only an uncaught exception / unhandled rejection fails the attempt.

export interface CapturedPreviewError {
  type: PreviewMessageType;
  message: string;
  stack?: string;
  port: number;
  pathname: string;
  at: number; // performance.now() when we received it
}

// Keep the subscription AND its buffer on globalThis, for the same reason
// getWebContainer() keeps the boot promise there: a Vite HMR update re-evaluates
// this module and would otherwise install a second listener writing to a fresh
// buffer while the collector reads a stale one. One store per page load fixes
// both. Bounded so a long-lived tab can't grow it without limit.
const STORE_KEY = "__previewErrorCapture__";
const MAX_BUFFERED = 200;

interface CaptureStore {
  buffer: CapturedPreviewError[];
  initialized: boolean;
}

function store(): CaptureStore {
  const g = globalThis as typeof globalThis & { [STORE_KEY]?: CaptureStore };
  if (!g[STORE_KEY]) g[STORE_KEY] = { buffer: [], initialized: false };
  return g[STORE_KEY]!;
}

/** Idempotent: subscribes to `preview-message` exactly once per page load. */
export function initPreviewErrorCapture(webcontainer: WebContainer): void {
  const s = store();
  if (s.initialized) return;
  s.initialized = true;

  webcontainer.on("preview-message", (msg: PreviewMessage) => {
    if (
      msg.type !== PreviewMessageType.UncaughtException &&
      msg.type !== PreviewMessageType.UnhandledRejection
    ) {
      return;
    }
    s.buffer.push({
      type: msg.type,
      message: msg.message,
      stack: msg.stack,
      port: msg.port,
      pathname: msg.pathname,
      at: performance.now(),
    });
    if (s.buffer.length > MAX_BUFFERED) s.buffer.splice(0, s.buffer.length - MAX_BUFFERED);
  });
}

/**
 * A timestamp to scope a later collection to "errors from this attempt's page".
 * Take it right before the attempt's preview URL goes live.
 */
export function previewErrorCheckpoint(): number {
  return performance.now();
}

/** Client errors reported for `port` since `since` (a previous checkpoint). */
export function collectPreviewErrors(port: number, since: number): CapturedPreviewError[] {
  return store().buffer.filter((e) => e.port === port && e.at >= since);
}

function label(type: PreviewMessageType): string {
  return type === PreviewMessageType.UnhandledRejection
    ? "unhandled promise rejection"
    : "uncaught exception";
}

/**
 * Turns collected client errors into the shared `{ name, pass, details }` check
 * contract so they merge into the attempt's validation exactly like fuzz checks.
 * No errors → a single passing check (the page loaded clean).
 */
export function previewErrorChecks(errors: CapturedPreviewError[]): CheckResult[] {
  const name = "preview: no uncaught client errors";
  if (errors.length === 0) {
    return [
      {
        name,
        pass: true,
        details: "The preview page loaded without an uncaught exception or unhandled rejection.",
      },
    ];
  }
  const details = errors
    .map((e) => {
      const where = e.pathname || "/";
      const firstStackLine = e.stack?.split("\n").find((l) => l.trim().length > 0)?.trim();
      return `${label(e.type)} on ${where}: ${e.message}${firstStackLine ? `\n  at ${firstStackLine}` : ""}`;
    })
    .join("\n");
  return [{ name, pass: false, details }];
}
