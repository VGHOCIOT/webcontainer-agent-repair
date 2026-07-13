import type { FailureStage, Attempt } from "./types";
import { last } from "./utils"

interface RunStats {
    converged: boolean;
    iterationsToConvergence: number | null;
    totalAttempts: number;
    totalInputTokens: number;
    totalOutputTokens: number;
    totalElapsedMs: number;
    failuresByStage: Record<FailureStage, number>;
    perAttempt: { index: number; status: string; failureStage?: FailureStage, inputTokens: number, outputTokens: number, elapsedMs: number }[];
}

export function computeRunStats(attempts: Attempt[]): RunStats {
    const converged = last(attempts)?.status === "passed";
    const iterationsToConvergence = converged ? attempts.length : null;
    const totals = attempts.reduce(
        (acc, attempt) => {
            acc.totalInputTokens += attempt.usage?.inputTokens ?? 0;
            acc.totalOutputTokens += attempt.usage?.outputTokens ?? 0;
            acc.totalElapsedMs += attempt.usage?.elapsedMs ?? 0;
            return acc;
        },
        {
            totalInputTokens: 0,
            totalOutputTokens: 0,
            totalElapsedMs: 0,
        },
    );
    const failuresByStage: Record<FailureStage, number> = {
        generation: 0,
        installation: 0,
        startup: 0,
        validation: 0,
    };
    for (const attempt of attempts) {
        if (attempt.status === "failed" && attempt.failureStage) {
            failuresByStage[attempt.failureStage]++;
        }
    }
    const perAttempt = attempts.map((attempt) => ({
        index: attempt.index,
        status: attempt.status,
        failureStage: attempt.failureStage,
        inputTokens: attempt.usage?.inputTokens ?? 0,
        outputTokens: attempt.usage?.outputTokens ?? 0,
        elapsedMs: attempt.usage?.elapsedMs ?? 0,
    }));

    return {
        converged,
        iterationsToConvergence,
        totalAttempts: attempts.length,
        totalInputTokens: totals.totalInputTokens,
        totalOutputTokens: totals.totalOutputTokens,
        totalElapsedMs: totals.totalElapsedMs,
        failuresByStage,
        perAttempt,
    };
}