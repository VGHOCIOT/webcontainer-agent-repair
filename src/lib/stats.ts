import type { FailureStage, Attempt } from "./types";
import { last } from "./utils"

export type CellState = "pass" | "fail" | "absent";

export interface HealingTimeline {
    // Check names in first-seen order across all attempts.
    checkNames: string[];
    // One row per attempt that reached validation-or-later, in attempt order.
    rows: { index: number; cells: Record<string, CellState> }[];
    // A check that passed in one validated attempt and failed in a later one.
    regressions: { checkName: string; atAttempt: number }[];
    regressionCount: number;
}

/**
 * Turns the per-check validation results into a check×attempt grid and flags
 * regressions (pass -> fail between consecutive validated attempts). This is
 * the loop behavior CLAUDE.md cares about: not just did it converge, but which
 * checks healed and which ones a "fix" broke.
 */
export function computeHealingTimeline(attempts: Attempt[]): HealingTimeline {
    // Only attempts that actually ran the validator carry per-check data.
    const validated = attempts.filter((a) => a.validation !== undefined);

    const checkNames: string[] = [];
    for (const attempt of validated) {
        for (const check of attempt.validation!.checks) {
            if (!checkNames.includes(check.name)) checkNames.push(check.name);
        }
    }

    const rows = validated.map((attempt) => {
        const cells: Record<string, CellState> = {};
        const byName = new Map(
            attempt.validation!.checks.map((c) => [c.name, c.pass] as const),
        );
        for (const name of checkNames) {
            cells[name] = byName.has(name) ? (byName.get(name) ? "pass" : "fail") : "absent";
        }
        return { index: attempt.index, cells };
    });

    const regressions: { checkName: string; atAttempt: number }[] = [];
    for (const name of checkNames) {
        let prevPassed = false;
        let seen = false;
        for (const row of rows) {
            const state = row.cells[name];
            if (state === "absent") continue;
            const passed = state === "pass";
            if (seen && prevPassed && !passed) {
                regressions.push({ checkName: name, atAttempt: row.index });
            }
            prevPassed = passed;
            seen = true;
        }
    }

    return { checkNames, rows, regressions, regressionCount: regressions.length };
}

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