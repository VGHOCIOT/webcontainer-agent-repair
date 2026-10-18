import { computeBatchSummary } from "./stats";
import type { BatchRun, CheckLayer, FailureStage, StoppedReason } from "./types";

// Reproducible, user-initiated export of a batch (the only way data leaves the
// tab — no persisted store). It carries everything needed to compare cells of an
// experiment (spec x builder model): the exact config, the exact grader scripts
// that scored it (plus hashes, so "same grader" is checkable), and per-attempt
// check results tagged by layer. Bulky render-only data (preview snapshots,
// install/run logs) is left out on purpose.

export const EXPORT_SCHEMA_VERSION = 1;

export interface GraderRecord {
  // The script text itself — a validator script, or an interaction-driver body.
  source: string;
  hash: string;
  checkNames: string[];
  authorModel: string;
  usage: { inputTokens: number; outputTokens: number; elapsedMs: number } | null;
}

// Captured when the batch STARTS: the UI state can change before Download is
// pressed, and the export must describe what actually ran.
export interface BatchMeta {
  presetName: string | null;
  spec: string;
  builderModel: string;
  graderModel: string;
  maxIterations: number;
  requestedRuns: number;
  perturbations: { port: boolean; offline: boolean; fuzz: boolean };
  gradeUI: boolean;
  validator: GraderRecord;
  driver: GraderRecord | null;
  // Result of running these exact graders against a known-good reference app
  // before the batch (see qualify.ts). "no-reference" = custom spec, unqualified.
  qualification: { status: string; failingChecks: string[] };
  startedAt: string;
}

export interface ExportedCheck {
  name: string;
  pass: boolean;
  details: string;
  layer?: CheckLayer;
}

export interface ExportedAttempt {
  index: number;
  status: string;
  failureStage?: FailureStage;
  stalled?: boolean;
  error?: string;
  inputTokens: number;
  outputTokens: number;
  elapsedMs: number;
  filesHash: string | null;
  files: { path: string; contents: string }[];
  checks: ExportedCheck[];
}

export interface ExportedRun {
  index: number;
  stoppedReason: StoppedReason;
  attempts: ExportedAttempt[];
}

export interface BatchExport {
  schemaVersion: number;
  exportedAt: string;
  config: Omit<BatchMeta, "validator" | "driver"> & { specHash: string };
  graders: { validator: GraderRecord; driver: GraderRecord | null };
  summary: ReturnType<typeof computeBatchSummary>;
  runs: ExportedRun[];
}

/** Short SHA-256 (first 12 hex chars) — enough to tell two scripts apart. */
export async function shortHash(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 12);
}

export async function buildBatchExport(meta: BatchMeta, runs: BatchRun[]): Promise<BatchExport> {
  const exportedRuns: ExportedRun[] = [];
  for (const run of runs) {
    const attempts: ExportedAttempt[] = [];
    for (const a of run.attempts) {
      attempts.push({
        index: a.index,
        status: a.status,
        failureStage: a.failureStage,
        stalled: a.stalled,
        error: a.error,
        inputTokens: a.usage?.inputTokens ?? 0,
        outputTokens: a.usage?.outputTokens ?? 0,
        elapsedMs: a.usage?.elapsedMs ?? 0,
        filesHash: a.files ? await shortHash(JSON.stringify(a.files)) : null,
        files: a.files ?? [],
        checks: (a.validation?.checks ?? []).map((c) => ({
          name: c.name,
          pass: c.pass,
          details: c.details,
          layer: c.layer,
        })),
      });
    }
    exportedRuns.push({ index: run.index, stoppedReason: run.stoppedReason, attempts });
  }

  const { validator, driver, ...config } = meta;
  return {
    schemaVersion: EXPORT_SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    config: { ...config, specHash: await shortHash(meta.spec) },
    graders: { validator, driver },
    summary: computeBatchSummary(runs),
    runs: exportedRuns,
  };
}

export function downloadJson(filename: string, data: unknown): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export interface ImportedGraders {
  specHash: string;
  graderModel: string;
  validator: GraderRecord;
  driver: GraderRecord | null;
}

/**
 * Parses a previously exported batch and returns its graders, so a later cell of
 * the experiment (e.g. the other builder model) is scored by the IDENTICAL
 * scripts. Throws a readable error on anything that isn't a v1 export.
 */
export function parseGraderImport(text: string): ImportedGraders {
  let data: Partial<BatchExport>;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("That file isn't valid JSON.");
  }
  if (data.schemaVersion !== EXPORT_SCHEMA_VERSION || !data.graders?.validator?.source || !data.config) {
    throw new Error("That file isn't a batch export this version of the app can read.");
  }
  return {
    specHash: data.config.specHash,
    graderModel: data.config.graderModel,
    validator: data.graders.validator,
    driver: data.graders.driver ?? null,
  };
}
