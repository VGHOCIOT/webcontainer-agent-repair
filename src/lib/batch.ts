import { runAgentLoop, type RunAgentLoopOptions } from "./agentLoop";
import type { Attempt, BatchArm, BatchRun } from "./types";

export interface RunBatchOptions
  extends Omit<
    RunAgentLoopOptions,
    "onAttempt" | "onPreviewUrl" | "keepServerAlive" | "feedback"
  > {
  runs: number;
  // Which arms to run for every run index. Both arms (healing + spec-only
  // control) makes a paired batch: the same spec and graders score both, so the
  // comparison between them comes out of a single invocation instead of
  // depending on two separately-run batches lining up.
  arms: BatchArm[];
  onRunStart?: (runIndex: number, arm: BatchArm) => void;
  onAttempt?: (runIndex: number, arm: BatchArm, attempt: Attempt) => void;
  onRunComplete?: (run: BatchRun) => void;
}

/**
 * Runs the identical spec+validator through the agent loop `runs` times, so
 * convergence can be read as a distribution rather than a single anecdote. When
 * `arms` has more than one arm, every run index runs each of them in turn.
 * Each run starts from a clean project directory (see runAgentLoop), so an
 * arm's result doesn't depend on which ran before it.
 *
 * Sequential by necessity: there is one shared WebContainer and one port, so
 * runs cannot overlap. `keepServerAlive: false` makes each run tear its server
 * down on convergence, otherwise the next run's startup collides on the port.
 */
export async function runBatch({
  runs,
  arms,
  onRunStart,
  onAttempt,
  onRunComplete,
  signal,
  ...loopOptions
}: RunBatchOptions): Promise<BatchRun[]> {
  const results: BatchRun[] = [];

  for (let r = 1; r <= runs; r++) {
    for (const arm of arms) {
      if (signal?.aborted) return results;
      onRunStart?.(r, arm);

      const { attempts, stoppedReason } = await runAgentLoop({
        ...loopOptions,
        feedback: arm === "feedback",
        signal,
        keepServerAlive: false,
        onAttempt: (attempt) => onAttempt?.(r, arm, attempt),
        onPreviewUrl: () => {}, // no live preview in batch mode
      });

      const run: BatchRun = { index: r, arm, attempts, stoppedReason };
      results.push(run);
      onRunComplete?.(run);
    }
  }

  return results;
}
