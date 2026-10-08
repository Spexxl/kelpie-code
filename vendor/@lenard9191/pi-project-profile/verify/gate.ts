import { readFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { join } from "node:path";
import { sha1 } from "../fs-utils.ts";
import { availability } from "../profile/render.ts";
import type { Check, CheckRun, GateVerdict, ProfileConfig, Tier } from "../types.ts";
import { checkKey, TIER_POLICY } from "../types.ts";
import { analyzeDiagnostics, diagCount, splitByBaseline, type DiagSet } from "./baseline.ts";
import { classifyFailure } from "./classify.ts";
import type { Plan, PlannedCheck } from "./plan.ts";
import { TIER_ORDER } from "./plan.ts";
import { pruneOutput } from "./prune.ts";
import { resolveArgv } from "./resolve.ts";
import { runCommand, writeLog } from "./run.ts";
import { scopeCheck } from "./scope.ts";

export interface GateHooks {
  /** Decide whether a confirm-tier check may run. Return "allow" | "deny" | "skip" (skip = not now, ask again later). */
  permission: (tier: Tier, checks: PlannedCheck[]) => Promise<"allow" | "deny" | "skip">;
  /** Progress callback (status line). */
  progress?: (text: string) => void;
  /** Check ids disabled for this session (env failures) — consulted and updated. */
  broken: Map<string, string>;
  signal?: AbortSignal;
  /** Stop after the first failing tier (default true). */
  stopOnRed?: boolean;
  /** Diagnostics recorded for this check before the current task; failures matching them are pre-existing. */
  baseline?: (check: Check) => DiagSet | undefined;
}

/** Tools that hold a project-wide lock or saturate the machine on their own: never run two at once. */
const SERIAL_TOOLS = new Set(["cargo", "rustfmt", "gradle", "maven", "mvn", "dotnet", "swift", "mix", "go", "sbt", "stack", "cabal", "zig", "bazel", "dart", "flutter", "xcodebuild"]);

export function defaultConcurrency(configured: number): number {
  if (configured > 0) return Math.floor(configured);
  return Math.max(1, Math.min(4, Math.floor(availableParallelism() / 2)));
}

/**
 * Run items with at most `limit` in flight. Items sharing a lane run one after
 * another in their original order; results come back in input order.
 */
export async function runPool<T, R>(items: T[], limit: number, lane: (item: T) => string | undefined, fn: (item: T) => Promise<R | undefined>): Promise<Array<R | undefined>> {
  const results: Array<R | undefined> = new Array(items.length);
  const lanes: number[][] = [];
  const byKey = new Map<string, number[]>();
  items.forEach((item, i) => {
    const key = lane(item);
    if (key === undefined) {
      lanes.push([i]);
      return;
    }
    let l = byKey.get(key);
    if (!l) {
      l = [];
      byKey.set(key, l);
      lanes.push(l);
    }
    l.push(i);
  });
  let next = 0;
  const worker = async () => {
    for (;;) {
      const l = lanes[next++];
      if (!l) return;
      for (const i of l) results[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, lanes.length)) }, worker));
  return results;
}

/** In-process checks that need no process (JSON parse). */
function runInternal(check: Check, files: string[]): CheckRun | undefined {
  if (check.argv[0] !== "__internal_json__") return undefined;
  const started = Date.now();
  const errors: string[] = [];
  for (const f of files) {
    const base = f.split("/").pop() ?? f;
    if (/^(tsconfig|jsconfig)[^/]*\.json$|\.jsonc$|\.json5$|^\.vscode\//.test(base) || f.includes(".vscode/") || /\.(code-workspace)$/.test(f)) continue;
    try {
      JSON.parse(readFileSync(join(check.cwd, f), "utf8"));
    } catch (err) {
      errors.push(`${f}: ${(err as Error).message}`);
    }
  }
  return { check, status: errors.length ? "fail" : "pass", exitCode: errors.length ? 1 : 0, durationMs: Date.now() - started, summary: errors.slice(0, 20), totalLines: errors.length };
}

export async function runCheck(planned: PlannedCheck, config: ProfileConfig, hooks: GateHooks): Promise<CheckRun> {
  const { files } = planned;
  const internal = runInternal(planned.check, files);
  if (internal) return internal;
  // Narrow test runs to the changed files when the runner supports it; the head stays late-bound.
  const scoped = planned.check.scope && files.length > 0 ? scopeCheck(planned.check, files) : undefined;
  const check: Check = scoped ? { ...planned.check, argv: scoped.argv, cmd: scoped.cmd } : planned.check;
  // Availability of what will actually run: `vitest related` needs node_modules/.bin/vitest, not the package manager.
  const unavailable = availability(check);
  if (unavailable) return { check, status: "env", exitCode: null, durationMs: 0, summary: [], totalLines: 0, reason: unavailable };
  const resolved = resolveArgv(check, check.appendFiles ? files : []);
  if (resolved.missing) return { check, status: "env", exitCode: null, durationMs: 0, summary: [], totalLines: 0, reason: resolved.missing };
  const argv = resolved.argv;
  hooks.progress?.(`${check.label}: ${check.cmd.replace(" <files>", "")}`);
  const result = await runCommand(argv, { cwd: check.cwd, env: check.env, timeoutMs: check.timeoutMs ?? config.verify.fastTimeoutMs, signal: hooks.signal });
  const combined = [result.stdout, result.stderr].filter((s) => s.trim()).join("\n");
  const failed = result.spawnError !== undefined || result.timedOut || (result.code !== 0 && result.code !== null) || result.code === null || (check.failOnOutput && result.stdout.trim() !== "");
  // Project-wide checks only: per-file checks see a different file set every run, so their output is not comparable.
  const baselineable = !check.appendFiles;
  if (!failed) return { check, status: "pass", exitCode: result.code, durationMs: result.durationMs, summary: [], totalLines: 0, diag: baselineable ? new Map() : undefined, scoped: !!scoped };
  const analysis = analyzeDiagnostics(combined, check.cwd);
  const baseline = baselineable ? hooks.baseline?.(planned.check) : undefined;
  const split = baseline ? splitByBaseline(analysis, baseline) : undefined;
  const pruned = pruneOutput(combined, config.verify.maxOutputLines, { drop: split?.preexisting });
  const cls = classifyFailure(result, { diagnosticCount: pruned.diagnosticCount, combined });
  let logPath: string | undefined;
  if (combined.length > 0) {
    try {
      logPath = writeLog(`verify-${check.label}`, `$ ${[...argv].join(" ")}\n(cwd ${check.cwd}, exit ${result.code}, ${result.durationMs}ms${result.timedOut ? ", TIMED OUT" : ""})\n\n${combined}`);
    } catch {
      /* ignore */
    }
  }
  if (cls.kind === "env") {
    const reason = result.timedOut ? `timed out after ${Math.round((check.timeoutMs ?? 0) / 1000)}s` : (cls.reason ?? "environment failure");
    return { check, status: "env", exitCode: result.code, durationMs: result.durationMs, summary: pruned.lines.slice(0, 8), totalLines: pruned.totalLines, logPath, reason, timedOut: result.timedOut };
  }
  const diag = baselineable ? analysis.keys : undefined;
  if (split && split.newKeys.size === 0) {
    // Everything that fails here was already failing before this task.
    return { check, status: "preexisting", exitCode: result.code, durationMs: result.durationMs, summary: [], totalLines: pruned.totalLines, logPath, preexisting: Math.max(1, diagCount(analysis.keys)), diag, scoped: !!scoped };
  }
  let summary = pruned.lines;
  if (check.failOnOutput && pruned.diagnosticCount === 0) summary = [`files need formatting:`, ...result.stdout.trim().split("\n").slice(0, 30)];
  return { check, status: "fail", exitCode: result.code, durationMs: result.durationMs, summary, totalLines: pruned.totalLines, logPath, timedOut: result.timedOut, preexisting: pruned.dropped || undefined, diag, scoped: !!scoped, files: check.appendFiles ? files : undefined };
}

/**
 * Execute a plan tier by tier. Stops at the first red tier (the agent should
 * fix compile errors before tests are meaningful). Env failures are recorded in
 * `hooks.broken` and never block.
 */
export async function runGate(plan: Plan, config: ProfileConfig, hooks: GateHooks): Promise<GateVerdict> {
  const started = Date.now();
  const runs: CheckRun[] = [];
  let red = false;
  for (const tier of TIER_ORDER) {
    const planned = (plan.byTier.get(tier) ?? []).filter((p) => !hooks.broken.has(checkKey(p.check)));
    if (planned.length === 0) continue;
    if (hooks.signal?.aborted) break;
    if (TIER_POLICY[tier] === "confirm") {
      const decision = await hooks.permission(tier, planned);
      if (decision !== "allow") {
        for (const p of planned) runs.push({ check: p.check, status: "skipped", exitCode: null, durationMs: 0, summary: [], totalLines: 0, reason: decision === "deny" ? "not permitted for this repo" : "not confirmed" });
        continue;
      }
    }
    // Read-only tiers run concurrently; tests and builds may share ports, databases or build dirs, so they run one at a time.
    const limit = TIER_POLICY[tier] === "auto" ? defaultConcurrency(config.verify.concurrency) : 1;
    const results = await runPool(planned, limit, (p) => (SERIAL_TOOLS.has(p.check.tool ?? "") ? `serial:${p.check.tool}` : undefined), async (p) => (hooks.signal?.aborted ? undefined : runCheck(p, config, hooks)));
    for (let i = 0; i < planned.length; i++) {
      const run = results[i];
      if (!run) continue;
      runs.push(run);
      if (run.status === "env") hooks.broken.set(checkKey(planned[i]!.check), run.reason ?? "environment failure");
      if (run.status === "fail") red = true;
    }
    if (red && hooks.stopOnRed !== false) break;
  }
  const failing = runs.filter((r) => r.status === "fail");
  const envs = runs.filter((r) => r.status === "env");
  const status: GateVerdict["status"] = failing.length ? "red" : runs.some((r) => r.status === "pass" || r.status === "preexisting") ? "green" : envs.length ? "env" : "skipped";
  const signature = failing.length ? sha1(failing.map((r) => `${r.check.id}\n${r.totalLines}\n${r.summary.join("\n")}`).join("\n---\n")) : undefined;
  return { status, runs, changedFiles: plan.relevantFiles, signature, durationMs: Date.now() - started };
}

export function describeRuns(runs: CheckRun[]): string {
  return runs
    .map((r) => {
      const t = `${(r.durationMs / 1000).toFixed(1)}s`;
      switch (r.status) {
        case "pass":
          return `✓ ${r.check.label} ${t}`;
        case "fail":
          return `✗ ${r.check.label} ${t}`;
        case "env":
          return `⚠ ${r.check.label} (${r.reason})`;
        case "skipped":
          return `– ${r.check.label} (${r.reason})`;
        case "preexisting":
          return `≈ ${r.check.label} ${t} (${r.preexisting} known)`;
      }
    })
    .join(" · ");
}
