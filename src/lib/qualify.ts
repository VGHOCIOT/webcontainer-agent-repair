import { runAgentLoop } from "./agentLoop";
import { mutantsFor, referenceFor } from "./referenceApps";
import type { CheckResult, GeneratedFile } from "./types";

// Grader qualification. A grader authored once by a model can simply be wrong,
// and a wrong grader silently turns every convergence number into noise (the
// pilot's Task filter spec "failed" 5/5 on an inverted counter assertion). So
// before a batch, run the freshly authored graders against a known-good
// reference app — through the SAME pipeline a builder's code goes through, with
// the model bypassed (`fixedFiles`). A grader that fails the app the spec
// describes is rejected.
//
// Passing the reference only proves a grader isn't too strict. A grader that
// accepts everything would pass it too, so each reference also has known-BAD
// variants (mutants, see referenceApps.ts), each breaking one stated spec
// requirement. The graders must FAIL every one; a grader that passes a mutant is
// too lenient to be trusted.

export type QualificationStatus =
  | "qualified"
  | "rejected" // a grader check failed on the reference app
  | "too-lenient" // the graders passed a known-broken variant of the app
  | "error" // the reference app itself didn't install/start (a fixture bug)
  | "no-reference"; // custom spec: nothing to qualify against

export interface Qualification {
  status: QualificationStatus;
  checks: CheckResult[];
  failing: CheckResult[];
  // Names of known-bad variants the graders wrongly passed.
  missedMutants: string[];
  message: string;
}

export async function qualifyGraders(opts: {
  spec: string;
  validatorScript: string;
  interactionDriver?: string;
  interactionPath: string;
}): Promise<Qualification> {
  const files = referenceFor(opts.spec);
  if (!files) {
    return {
      status: "no-reference",
      checks: [],
      failing: [],
      missedMutants: [],
      message:
        "No reference app for this spec, so its graders can't be qualified. Results from a custom spec are only as trustworthy as the graders themselves.",
    };
  }

  const run = async (fixedFiles: GeneratedFile[]) => {
    const { attempts, stoppedReason } = await runAgentLoop({
      apiKey: "",
      model: "reference",
      spec: opts.spec,
      validatorScript: opts.validatorScript,
      interactionDriver: opts.interactionDriver,
      interactionPath: opts.interactionPath,
      fixedFiles,
      maxIterations: 1,
      keepServerAlive: false,
      onAttempt: () => {},
      onPreviewUrl: () => {},
    });
    return { attempt: attempts[0], stoppedReason };
  };

  const { attempt, stoppedReason } = await run(files);
  const checks = attempt?.validation?.checks ?? [];
  const failing = checks.filter((c) => !c.pass);

  if (stoppedReason !== "converged") {
    if (attempt?.failureStage === "validation" || failing.length > 0) {
      return {
        status: "rejected",
        checks,
        failing,
        missedMutants: [],
        message:
          failing.length > 0
            ? `The graders failed a known-good reference app on ${failing.length} check(s): ${failing
                .map((c) => c.name)
                .join("; ")}. The grader is wrong, not the app — regenerate it.`
            : `A grader failed a known-good reference app: ${attempt?.error ?? "no checks were produced"}. Regenerate it.`,
      };
    }
    return {
      status: "error",
      checks,
      failing,
      missedMutants: [],
      message: `The reference app itself did not run (${attempt?.error ?? stoppedReason}). This is a fixture bug, not a grader verdict.`,
    };
  }

  // The reference passed. Now the graders must catch each known-broken variant.
  const mutants = mutantsFor(opts.spec);
  const missed: string[] = [];
  for (const mutant of mutants) {
    const m = await run(mutant.files);
    if (m.stoppedReason === "converged") {
      missed.push(mutant.name);
    } else if (m.attempt?.failureStage !== "validation") {
      // Broke on install/startup instead of being graded — the mutant, not the
      // grader, is at fault, so don't let it count as "caught".
      return {
        status: "error",
        checks,
        failing: [],
        missedMutants: [],
        message: `The known-bad variant "${mutant.name}" did not run (${m.attempt?.error ?? m.stoppedReason}). This is a fixture bug, not a grader verdict.`,
      };
    }
  }
  if (missed.length > 0) {
    return {
      status: "too-lenient",
      checks,
      failing: [],
      missedMutants: missed,
      message: `The graders passed ${missed.length} known-broken variant(s) of the app: ${missed.join("; ")}. The grader is too lenient — regenerate it.`,
    };
  }
  return {
    status: "qualified",
    checks,
    failing: [],
    missedMutants: [],
    message: `Graders passed the reference app (${checks.length} checks) and failed all ${mutants.length} known-broken variants.`,
  };
}

// How many times a batch will author-and-qualify graders before giving up.
// Regeneration is non-deterministic, so one rejection is routine (Task filter
// took three tries once); a spec that can't qualify in this many is a real
// problem to look at, not something to loop on.
export const QUALIFY_MAX_TRIES = 3;

/**
 * Which graders to regenerate after a failed qualification. A reference-app
 * failure names the failing checks, and each check carries its layer, so only
 * the grader that produced them is replaced (a good grader isn't thrown away).
 * A too-lenient result can't be pinned on one grader — every check passed — so
 * both are replaced. `error` is a fixture bug and never retried (null).
 */
export function gradersToRegenerate(
  q: Qualification,
): { validator: boolean; driver: boolean } | null {
  if (q.status === "qualified" || q.status === "no-reference" || q.status === "error") return null;
  if (q.status === "rejected" && q.failing.length > 0) {
    return {
      validator: q.failing.some((c) => c.layer !== "frontend"),
      driver: q.failing.some((c) => c.layer === "frontend"),
    };
  }
  return { validator: true, driver: true };
}
