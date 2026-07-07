import { WebContainer } from "@webcontainer/api";
import type { FileSystemTree, WebContainerProcess } from "@webcontainer/api";
import type { GeneratedFile } from "./types";

let bootPromise: Promise<WebContainer> | null = null;

export function getWebContainer(): Promise<WebContainer> {
  if (!bootPromise) {
    bootPromise = WebContainer.boot();
  }
  return bootPromise;
}

export function buildFileTree(files: GeneratedFile[]): FileSystemTree {
  const tree: FileSystemTree = {};

  for (const { path, contents } of files) {
    const segments = path.split("/").filter(Boolean);
    let cursor: FileSystemTree = tree;

    segments.forEach((segment, i) => {
      const isLast = i === segments.length - 1;
      if (isLast) {
        cursor[segment] = { file: { contents } };
        return;
      }
      const existing = cursor[segment];
      if (!existing || !("directory" in existing)) {
        cursor[segment] = { directory: {} };
      }
      cursor = (cursor[segment] as { directory: FileSystemTree }).directory;
    });
  }

  return tree;
}

async function runToCompletion(
  webcontainer: WebContainer,
  command: string,
  args: string[],
  onOutput: (chunk: string) => void,
): Promise<number> {
  const process = await webcontainer.spawn(command, args);
  process.output.pipeTo(
    new WritableStream({
      write(chunk) {
        onOutput(chunk);
      },
    }),
  );
  return process.exit;
}

export async function runInstall(
  webcontainer: WebContainer,
  onOutput: (chunk: string) => void,
): Promise<number> {
  return runToCompletion(webcontainer, "npm", ["install"], onOutput);
}

export interface StartResult {
  url: string | null;
  port: number | null;
  exitCode: number | null;
  timedOut: boolean;
  process: WebContainerProcess;
}

/**
 * Starts the app and races "a server started listening" against "the process
 * exited first" (e.g. it crashed on startup) against a timeout, since a
 * generated app can fail in any of those three ways. Caller is responsible
 * for killing `process` once it's done with this attempt's server (a
 * previous attempt's server must be killed before the next one spawns, since
 * a crashed-but-not-yet-reaped process can otherwise linger).
 */
export async function runStart(
  webcontainer: WebContainer,
  onOutput: (chunk: string) => void,
  timeoutMs = 15_000,
): Promise<StartResult> {
  const process = await webcontainer.spawn("npm", ["run", "start"]);
  process.output.pipeTo(
    new WritableStream({
      write(chunk) {
        onOutput(chunk);
      },
    }),
  );

  const serverReady = new Promise<Omit<StartResult, "process">>((resolve) => {
    const unsubscribe = webcontainer.on("server-ready", (port, url) => {
      unsubscribe();
      resolve({ url, port, exitCode: null, timedOut: false });
    });
  });

  const exited = process.exit.then(
    (exitCode): Omit<StartResult, "process"> => ({
      url: null,
      port: null,
      exitCode,
      timedOut: false,
    }),
  );

  const timeout = new Promise<Omit<StartResult, "process">>((resolve) => {
    setTimeout(
      () => resolve({ url: null, port: null, exitCode: null, timedOut: true }),
      timeoutMs,
    );
  });

  const result = await Promise.race([serverReady, exited, timeout]);

  return { ...result, process };
}
