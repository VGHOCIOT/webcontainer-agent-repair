import { WebContainer } from "@webcontainer/api";
import type { FileSystemTree, WebContainerProcess } from "@webcontainer/api";
import type { GeneratedFile } from "./types";

// WebContainer allows exactly ONE instance per page and throws "Only a single
// WebContainer instance can be booted" on a second boot(). A module-level `let`
// isn't enough: a Vite HMR update re-evaluates this module and resets it to
// null while the real instance is still alive in the page, so the next call
// boots again and throws. Persisting the promise on globalThis survives HMR
// (and StrictMode remounts), so boot() runs exactly once per page load.
const BOOT_KEY = "__webcontainerBootPromise__";

type BootStore = typeof globalThis & {
  [BOOT_KEY]?: Promise<WebContainer>;
};

export function getWebContainer(): Promise<WebContainer> {
  const store = globalThis as BootStore;
  if (!store[BOOT_KEY]) {
    store[BOOT_KEY] = WebContainer.boot();
  }
  return store[BOOT_KEY];
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

export interface FileApplyResult {
  written: string[];
  removed: string[];
  unchanged: string[];
}

async function ensureParentDir(
  webcontainer: WebContainer,
  filePath: string,
): Promise<void> {
  const dir = filePath.split("/").slice(0, -1).join("/");
  if (dir) await webcontainer.fs.mkdir(dir, { recursive: true });
}

/**
 * Applies the DELTA between the last attempt's files and this attempt's files
 * to the live container filesystem, instead of re-`mount`-ing the whole tree.
 * Returns what it actually touched so the caller can log/inspect it.
 *
 * Why a delta beats a blind full `mount`: `mount` MERGES and never deletes, so
 * a file attempt 1 wrote and attempt 2 dropped would linger on disk where a
 * stale `require` could still resolve it and mask the bug. Applying the delta
 * removes dropped files, so on-disk state is exactly what the latest generation
 * describes. (See CLAUDE.md on why an unchanged build is never re-run.)
 */
export async function applyGeneratedFiles(
  webcontainer: WebContainer,
  prevFiles: GeneratedFile[] | null,
  nextFiles: GeneratedFile[],
): Promise<FileApplyResult> {
  // First file-writing attempt: nothing on disk yet, so mount the whole tree in
  // one shot (cheaper than a write-per-file walk, and there's no delta to take).
  if (!prevFiles) {
    await webcontainer.mount(buildFileTree(nextFiles));
    return { written: nextFiles.map((f) => f.path), removed: [], unchanged: [] };
  }

  const prevByPath = new Map(prevFiles.map((f) => [f.path, f.contents]));
  const nextByPath = new Map(nextFiles.map((f) => [f.path, f.contents]));
  const written: string[] = [];
  const unchanged: string[] = [];
  const removed: string[] = [];

  for (const { path, contents } of nextFiles) {
    if (prevByPath.get(path) === contents) {
      unchanged.push(path); // identical bytes — no point writing them again
      continue;
    }
    await ensureParentDir(webcontainer, path);
    await webcontainer.fs.writeFile(path, contents);
    written.push(path);
  }

  for (const { path } of prevFiles) {
    if (!nextByPath.has(path)) {
      await webcontainer.fs.rm(path, { force: true });
      removed.push(path);
    }
  }

  return { written, removed, unchanged };
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

/**
 * Returns the project directory to empty: removes the files a previous run wrote
 * plus what `npm install` left behind. `mount` merges and never deletes, so
 * without this every run would start on top of the last one's leftovers — runs
 * are meant to be independent samples, and a stale file or a populated
 * node_modules (which would also let an `--offline` install succeed on a package
 * the new run never fetched) could change how a build behaves.
 */
export async function clearProject(
  webcontainer: WebContainer,
  writtenFiles: GeneratedFile[],
): Promise<void> {
  for (const { path } of writtenFiles) {
    await webcontainer.fs.rm(path, { force: true });
  }
  await webcontainer.fs.rm("node_modules", { recursive: true, force: true });
  await webcontainer.fs.rm("package-lock.json", { force: true });
}

export async function runInstall(
  webcontainer: WebContainer,
  onOutput: (chunk: string) => void,
  offline = false,
): Promise<number> {
  // `--offline` forces npm to use only its cache: a dependency-free app still
  // installs fine, but one that reached for a package it can't fetch fails at
  // the install stage — a genuine, disclosed "no npm packages" probe.
  const args = offline ? ["install", "--offline"] : ["install"];
  return runToCompletion(webcontainer, "npm", args, onOutput);
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
  env?: Record<string, string>,
): Promise<StartResult> {
  const process = await webcontainer.spawn(
    "npm",
    ["run", "start"],
    env ? { env } : undefined,
  );
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
