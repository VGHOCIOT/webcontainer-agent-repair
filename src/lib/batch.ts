import { runAgentLoop, type RunAgentLoopOptions } from "./agentLoop";
import type { Attempt, BatchRun } from "./types";

export interface RunBatchOptions
  extends Omit<RunAgentLoopOptions, "onAttempt" | "onPreviewUrl" | "keepServerAlive"> {
  runs: number;
  onRunStart?: (runIndex: number) => void;
  onAttempt?: (runIndex: number, attempt: Attempt) => void;
  onRunComplete?: (run: BatchRun) => void;
}

/**
 * Runs the identical spec+validator through the agent loop `runs` times, so
 * convergence can be read as a distribution rather than a single anecdote.
 *
 * Sequential by necessity: there is one shared WebContainer and one port, so
 * runs cannot overlap. `keepServerAlive: false` makes each run tear its server
 * down on convergence, otherwise the next run's startup collides on the port.
 */
export async function runBatch({
  runs,
  onRunStart,
  onAttempt,
  onRunComplete,
  signal,
  ...loopOptions
}: RunBatchOptions): Promise<BatchRun[]> {
  const results: BatchRun[] = [];

  for (let r = 1; r <= runs; r++) {
    if (signal?.aborted) break;
    onRunStart?.(r);

    const { attempts, stoppedReason } = await runAgentLoop({
      ...loopOptions,
      signal,
      keepServerAlive: false,
      onAttempt: (attempt) => onAttempt?.(r, attempt),
      onPreviewUrl: () => {}, // no live preview in batch mode
    });

    const run: BatchRun = { index: r, attempts, stoppedReason };
    results.push(run);
    onRunComplete?.(run);
  }

  return results;
}
