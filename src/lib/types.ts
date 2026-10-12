export interface GeneratedFile {
  path: string;
  contents: string;
}

export type AttemptStatus =
  | "generating"
  | "installing"
  | "starting"
  | "validating"
  | "passed"
  | "failed";

export interface AttemptUsage {
  inputTokens: number;
  outputTokens: number;
  elapsedMs: number;
}

export interface CheckResult {
  name: string;
  pass: boolean;
  details: string;
}

export interface ValidationResult {
  pass: boolean;
  details: string;
  checks: CheckResult[];
}

export interface Attempt {
  index: number;
  status: AttemptStatus;
  files?: GeneratedFile[];
  installLog?: string;
  runLog?: string;
  validation?: ValidationResult;
  error?: string;
  usage?: AttemptUsage;
  failureStage?: FailureStage;
  // True when this attempt produced no progress vs. the previous one —
  // byte-identical files, or the exact same failure. Drives the loop's
  // early-stop guard so a stuck model doesn't burn every iteration.
  stalled?: boolean;
  // Rendered DOM (outerHTML) the interaction driver captured for this attempt,
  // for replaying the visual break->heal. Present only when the app ran far
  // enough for the driver to drive it (a frontend spec past the validator).
  previewSnapshot?: string;
}

export type FailureStage = "generation" | "installation" | "startup" | "validation";

export type StoppedReason =
  | "converged"
  | "max-iterations"
  | "no-progress"
  | "aborted";

// One completed pass of the agent loop within a batch. The batch runner repeats
// the identical spec+validator N times so convergence can be read as a
// distribution, not a single anecdote.
export interface BatchRun {
  index: number;
  attempts: Attempt[];
  stoppedReason: StoppedReason;
}
