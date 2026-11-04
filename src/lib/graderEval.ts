import { generateDriver, DRIVER_SYSTEM_PROMPT } from "./driverGen";
import { shortHash } from "./exportResults";
import { qualifyGraders, type QualificationStatus } from "./qualify";
import { generateValidator, VALIDATOR_SYSTEM_PROMPT } from "./validatorGen";

// Grader-robustness eval. Not an experiment on the builder: it measures how often
// freshly authored graders (validator + interaction driver) are TRUSTWORTHY, so a
// change to the grader-authoring prompts can be judged on data instead of anecdote.
// For each spec it authors a grader pair, qualifies it ONCE (no retry — a rejection
// is the data point, unlike the batch gate which regenerates), and records the
// verdict. Qualification runs the graders against the spec's reference app, its
// known-good variants (a different DOM strategy) and its known-bad mutants; the
// builder model is never called, so the only API spend is grader authoring.

export interface EvalSpec {
  name: string;
  spec: string;
  // Whether the spec has a UI for the interaction driver to grade.
  frontend: boolean;
  driverPath: string;
}

export type EvalStatus = QualificationStatus | "authoring-error";

export interface EvalSample {
  specName: string;
  sample: number;
  status: EvalStatus;
  message: string;
  failingChecks: string[];
  missedMutants: string[];
  validator: { source: string; hash: string };
  driver: { source: string; hash: string } | null;
  inputTokens: number;
  outputTokens: number;
  elapsedMs: number;
}

export interface GraderEvalExport {
  schemaVersion: 1;
  exportedAt: string;
  graderModel: string;
  samplesPerSpec: number;
  // Hashes of the authoring prompts under test, so two exports are comparable
  // only when these differ for the reason you intend.
  promptHashes: { validator: string; driver: string };
  qualifiedRate: number;
  samples: EvalSample[];
}

export async function runGraderEval(opts: {
  apiKey: string;
  model: string;
  specs: EvalSpec[];
  samples: number;
  signal?: AbortSignal;
  onSample: (s: EvalSample) => void;
  onProgress?: (specName: string, sample: number) => void;
}): Promise<EvalSample[]> {
  const out: EvalSample[] = [];
  for (const spec of opts.specs) {
    for (let n = 1; n <= opts.samples; n++) {
      if (opts.signal?.aborted) return out;
      opts.onProgress?.(spec.name, n);
      const startedAt = performance.now();
      let sample: EvalSample;
      try {
        // The two graders are independent authoring calls, so author them together.
        const [v, d] = await Promise.all([
          generateValidator(opts.apiKey, opts.model, spec.spec),
          spec.frontend ? generateDriver(opts.apiKey, opts.model, spec.spec) : Promise.resolve(null),
        ]);
        const q = await qualifyGraders({
          spec: spec.spec,
          validatorScript: v.script,
          interactionDriver: d?.driverBody,
          interactionPath: spec.driverPath,
        });
        sample = {
          specName: spec.name,
          sample: n,
          status: q.status,
          message: q.message,
          failingChecks: q.failing.map((c) => `${c.name}: ${c.details}`),
          missedMutants: q.missedMutants,
          validator: { source: v.script, hash: await shortHash(v.script) },
          driver: d ? { source: d.driverBody, hash: await shortHash(d.driverBody) } : null,
          inputTokens: v.inputTokens + (d?.inputTokens ?? 0),
          outputTokens: v.outputTokens + (d?.outputTokens ?? 0),
          elapsedMs: performance.now() - startedAt,
        };
      } catch (err) {
        sample = {
          specName: spec.name,
          sample: n,
          status: "authoring-error",
          message: (err as Error).message,
          failingChecks: [],
          missedMutants: [],
          validator: { source: "", hash: "" },
          driver: null,
          inputTokens: 0,
          outputTokens: 0,
          elapsedMs: performance.now() - startedAt,
        };
      }
      out.push(sample);
      opts.onSample(sample);
    }
  }
  return out;
}

/** Share of samples that qualified. A spec with no reference (custom) never counts. */
export function qualifiedRate(samples: EvalSample[]): number {
  return samples.length === 0 ? 0 : samples.filter((s) => s.status === "qualified").length / samples.length;
}

export async function buildEvalExport(
  model: string,
  samplesPerSpec: number,
  samples: EvalSample[],
): Promise<GraderEvalExport> {
  return {
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    graderModel: model,
    samplesPerSpec,
    promptHashes: {
      validator: await shortHash(VALIDATOR_SYSTEM_PROMPT),
      driver: await shortHash(DRIVER_SYSTEM_PROMPT),
    },
    qualifiedRate: qualifiedRate(samples),
    samples,
  };
}
