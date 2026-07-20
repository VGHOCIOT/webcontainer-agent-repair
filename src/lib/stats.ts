import type { FailureStage, Attempt, BatchRun, StoppedReason } from "./types";
import { last } from "./utils"

export type CellState = "pass" | "fail" | "absent";

export interface TimelineRow {
    index: number;
    cells: Record<string, CellState>;
    // Whether this attempt reached the validator (only then do its cells carry
    // real pass/fail; otherwise every cell is "absent").
    reachedValidation: boolean;
    // "passed" when the whole attempt converged, "failed" otherwise, or an
    // in-progress status while the loop is still running the attempt.
    status: string;
    // Set for a failed attempt — the stage it died at (install/startup/etc.).
    failureStage?: FailureStage;
    // Per-attempt cost, folded into the timeline so each column shows what it
    // healed AND what it cost — the CLAUDE.md triad in one grid.
    inputTokens: number;
    outputTokens: number;
    elapsedMs: number;
}

export interface HealingTimeline {
    // Check names in first-seen order across all validated attempts.
    checkNames: string[];
    // One row per attempt, in attempt order — including attempts that failed
    // before validation, so the grid tells the complete per-run story.
    rows: TimelineRow[];
    // A check that passed in one validated attempt and failed in a later one.
    regressions: { checkName: string; atAttempt: number }[];
    regressionCount: number;
}

/**
 * Turns the per-check validation results into a check×attempt grid and flags
 * regressions (pass -> fail between consecutive validated attempts). This is
 * the loop behavior CLAUDE.md cares about: not just did it converge, but which
 * checks healed, which ones a "fix" broke, and — via the per-row cost — what
 * each attempt spent getting there.
 */
export function computeHealingTimeline(attempts: Attempt[]): HealingTimeline {
    // Check names come only from attempts that actually ran the validator.
    const checkNames: string[] = [];
    for (const attempt of attempts) {
        if (!attempt.validation) continue;
        for (const check of attempt.validation.checks) {
            if (!checkNames.includes(check.name)) checkNames.push(check.name);
        }
    }

    const rows: TimelineRow[] = attempts.map((attempt) => {
        const cells: Record<string, CellState> = {};
        const byName = new Map(
            (attempt.validation?.checks ?? []).map((c) => [c.name, c.pass] as const),
        );
        for (const name of checkNames) {
            cells[name] = byName.has(name)
                ? (byName.get(name) ? "pass" : "fail")
                : "absent";
        }
        return {
            index: attempt.index,
            cells,
            reachedValidation: attempt.validation !== undefined,
            status: attempt.status,
            failureStage: attempt.failureStage,
            inputTokens: attempt.usage?.inputTokens ?? 0,
            outputTokens: attempt.usage?.outputTokens ?? 0,
            elapsedMs: attempt.usage?.elapsedMs ?? 0,
        };
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

export interface BatchSummary {
    runs: number;
    converged: number;
    convergenceRate: number; // 0..1
    stoppedReasons: Record<StoppedReason, number>;
    // Attempts-to-converge, one entry per converged run (an unconverged run has
    // no convergence point, so it's excluded rather than counted as its cap).
    iterationsToConverge: number[];
    meanIterations: number | null;
    medianIterations: number | null;
    maxIterations: number | null;
    // Summed across every failed attempt of every run — which stage the loop
    // spends its retries on.
    failuresByStage: Record<FailureStage, number>;
    // How often each check was failing on a run's first validated attempt —
    // i.e. which bug classes the builder introduces before any healing.
    firstFailingChecks: { name: string; count: number }[];
    // Total pass->fail regressions across all runs (a "fix" that broke a check).
    totalRegressions: number;
    totalInputTokens: number;
    totalOutputTokens: number;
    totalElapsedMs: number;
}

function median(sorted: number[]): number | null {
    if (sorted.length === 0) return null;
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0
        ? (sorted[mid - 1] + sorted[mid]) / 2
        : sorted[mid];
}

/**
 * Aggregates N loop runs into the distribution CLAUDE.md actually wants
 * published: not "it worked", but how often and in how many iterations it
 * converges, which bug classes recur, which "fixes" regressed, and the token/
 * time cost — turning a single run's anecdote into a finding.
 */
export function computeBatchSummary(runs: BatchRun[]): BatchSummary {
    const stoppedReasons: Record<StoppedReason, number> = {
        converged: 0,
        "max-iterations": 0,
        "no-progress": 0,
        aborted: 0,
    };
    const failuresByStage: Record<FailureStage, number> = {
        generation: 0,
        installation: 0,
        startup: 0,
        validation: 0,
    };
    const iterationsToConverge: number[] = [];
    const firstFailingCounts = new Map<string, number>();
    let totalRegressions = 0;
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let totalElapsedMs = 0;

    for (const run of runs) {
        stoppedReasons[run.stoppedReason]++;

        const runStats = computeRunStats(run.attempts);
        totalInputTokens += runStats.totalInputTokens;
        totalOutputTokens += runStats.totalOutputTokens;
        totalElapsedMs += runStats.totalElapsedMs;
        for (const stage of Object.keys(failuresByStage) as FailureStage[]) {
            failuresByStage[stage] += runStats.failuresByStage[stage];
        }

        if (run.stoppedReason === "converged") {
            iterationsToConverge.push(run.attempts.length);
        }

        totalRegressions += computeHealingTimeline(run.attempts).regressionCount;

        // First attempt that actually reached the validator — its failing checks
        // are the bugs the builder started with, before any healing.
        const firstValidated = run.attempts.find((a) => a.validation !== undefined);
        if (firstValidated) {
            for (const check of firstValidated.validation!.checks) {
                if (!check.pass) {
                    firstFailingCounts.set(check.name, (firstFailingCounts.get(check.name) ?? 0) + 1);
                }
            }
        }
    }

    const converged = stoppedReasons.converged;
    const sortedIters = [...iterationsToConverge].sort((a, b) => a - b);
    const firstFailingChecks = [...firstFailingCounts.entries()]
        .map(([name, count]) => ({ name, count }))
        .sort((a, b) => b.count - a.count);

    return {
        runs: runs.length,
        converged,
        convergenceRate: runs.length === 0 ? 0 : converged / runs.length,
        stoppedReasons,
        iterationsToConverge,
        meanIterations:
            iterationsToConverge.length === 0
                ? null
                : iterationsToConverge.reduce((a, b) => a + b, 0) / iterationsToConverge.length,
        medianIterations: median(sortedIters),
        maxIterations: sortedIters.length === 0 ? null : sortedIters[sortedIters.length - 1],
        failuresByStage,
        firstFailingChecks,
        totalRegressions,
        totalInputTokens,
        totalOutputTokens,
        totalElapsedMs,
    };
}