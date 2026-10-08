export type RunOutcome = "completed" | "failed" | "timed_out" | "stopped" | "interrupted";
export interface RunEntry {
    agent: string;
    task: string;
    taskHash?: string;
    ts: number;
    status: "ok" | "error";
    outcome?: RunOutcome;
    duration: number;
    exit?: number;
}
export interface BackgroundRunHistoryEntry {
    agent: string;
    task: string;
    exitCode: number;
    durationMs: number;
    terminal: Pick<NonNullable<Parameters<typeof recordRun>[4]>, "stopped" | "interrupted" | "timedOut" | "processSignal">;
}
/**
 * Census rows for one finished background run. Single-step runs keep the exact
 * foreground shape (agent + task text). Multi-step runs record ONE ROW PER CHILD
 * STEP so `loadRunsForAgent(agent)` sees every child — a composite-only row would
 * stay invisible to per-agent lookups. Per-step prompts are never hashed:
 * multi-step rows hash the mode label only.
 *
 * Fidelity rules:
 * - a row is recorded only for children that actually LAUNCHED (a child
 *   session was dispatched). Status alone cannot decide this: `stopRunner()`,
 *   `timeoutRunner()`, fail-fast skips, and usage-budget skips all relabel
 *   never-launched steps to terminal statuses (`stopped`, `failed`+`timedOut,
 *   `failed`+`skipped) before the run ends — the runner therefore threads an
 *   explicit `launched` fact per step. `pending` and `launched: false` steps
 *   get no row — unrun agents must not accumulate attempts or failures;
 * - run-level terminal flags (stopped/interrupted/timedOut) apply only to steps
 *   that did not reach a terminal state of their own — a child that completed
 *   or failed BEFORE a sibling was interrupted keeps its own outcome, because
 *   recordRun() lets those flags override the exit code;
 * - self-terminal steps carry their own timedOut/stopped flags instead.
 */
export declare function planBackgroundRunHistory(input: {
    steps: readonly unknown[];
    resultMode: string;
    statusSteps: ReadonlyArray<{
        agent?: unknown;
        status?: unknown;
        durationMs?: number;
        timedOut?: boolean;
        stopped?: boolean;
        launched?: boolean;
    }>;
    stepResults?: ReadonlyArray<{
        processSignal?: unknown;
    } | undefined>;
    runDurationMs: number;
    stopped?: boolean;
    interrupted?: boolean;
    timedOut?: boolean;
}): BackgroundRunHistoryEntry[];
export declare function recordRun(agent: string, task: string, exitCode: number, durationMs: number, terminal?: {
    interrupted?: boolean;
    processSignal?: string | null;
    stopped?: boolean;
    timedOut?: boolean;
    turnBudgetExceeded?: boolean;
}): void;
export declare function loadRunsForAgent(agent: string): RunEntry[];
//# sourceMappingURL=run-history.d.ts.map