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

export interface Attempt {
  index: number;
  status: AttemptStatus;
  files?: GeneratedFile[];
  installLog?: string;
  runLog?: string;
  validation?: { pass: boolean; details: string };
  error?: string;
  usage?: AttemptUsage;
  failureStage?: FailureStage;
}

export type FailureStage = "generation" | "installation" | "startup" | "validation";
