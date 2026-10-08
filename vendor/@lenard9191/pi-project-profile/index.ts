/**
 * project-profile — a global, project-agnostic Pi extension.
 *
 *  v1  Profile: detect stack / commands / conventions / instruction files for the
 *      current project at session start, cache it under ~/.pi/agent/project-profile
 *      (never inside the repo) and inject a static <project_profile> section into
 *      the system prompt. `/profile` inspects and corrects it.
 *
 *  v2  Verify: when the agent finishes a run that changed files, run the project's
 *      own read-only checks (typecheck/lint) automatically, tests/builds only after
 *      a one-time per-repo confirmation, never installs or migrations. Red results
 *      are pruned and sent back to the agent for a bounded number of repair rounds;
 *      environment failures go to the user instead. `/verify` and the `run_checks`
 *      tool run the same machinery on demand.
 */
import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, SessionBoundaryDraft } from "@earendil-works/pi-coding-agent";
import { Box, Markdown, Text } from "@earendil-works/pi-tui";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { basename, isAbsolute, join, relative, sep } from "node:path";
import { agentDir, configPath, loadConfig, writeDefaultConfig } from "./config.ts";
import { findProjectRoot, nearestProjectDir } from "./detect/index.ts";
import { exists, ext, readText, realpath, tildify, uniq } from "./fs-utils.ts";
import { availability, effectiveChecks, effectiveCommands, renderPromptSection, renderReport, tierAllowed } from "./profile/render.ts";
import { deleteStored, loadOrDetect, profilePath, pruneProfiles, updateUser } from "./profile/store.ts";
import { checkKey, type Check, type GateVerdict, type ProfileConfig, type StoredProfile, type Tier } from "./types.ts";
import { collectChanges, displayPath, newTracker, peekChanges, snapshotStart, toolPath, type ChangeTracker } from "./verify/changes.ts";
import { describeRuns, runGate, type GateHooks } from "./verify/gate.ts";
import { buildPlan, isIgnoredPath, TIER_ORDER, type PlannedCheck } from "./verify/plan.ts";
import { logDir, pruneLogs } from "./verify/run.ts";
import { diagCount } from "./verify/baseline.ts";
import { collectFindings, formatFinding, headContent, isWeakening, mustFix, readForDiff, SKIP, type Before, type Finding } from "./verify/findings.ts";
import { fixHint } from "./verify/hints.ts";
import { doctorReport } from "./profile/doctor.ts";
import { discoverRules, generatedPatterns, generatedReason, matchingRules, nestedInstructionFiles, readInstruction, renderInjection, type InjectionPart, type ScopedRule } from "./profile/scoped.ts";
import { appendFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname } from "node:path";
import { spawnSync } from "node:child_process";

const VERIFY_MSG = "project-profile/verify";
const DEBUG = !!process.env.PI_PROJECT_PROFILE_DEBUG;
function debug(event: string, data: Record<string, unknown> = {}): void {
  if (!DEBUG) return;
  try {
    appendFileSync(join(logDir(), "debug.jsonl"), JSON.stringify({ t: new Date().toISOString(), pid: process.pid, event, ...data }) + "\n");
  } catch {
    /* ignore */
  }
}
const REPORT_ENTRY = "project-profile/report";
const STATUS_KEY = "verify";
/** Project dirs whose checks get a baseline run per session (bounds the background work in monorepos). */
const MAX_BASELINES = 4;

interface PromptState {
  seq: number;
  repairRound: number;
  pendingRepair: boolean;
  finalized: boolean;
  lastSignature?: string;
  mustRun: PlannedCheck[];
  /** Content of files right before the agent's first write to them in this prompt (null = did not exist). */
  orig: Map<string, Before>;
  /** Every file changed during this prompt (absolute). */
  files: Set<string>;
  /** Git status when the prompt started (files dirty then are never attributed to the agent). */
  startSnapshot?: Map<string, string>;
  /** Diff-guard findings already shown in this prompt. */
  reported: Set<string>;
  /** The diff guard already used its one follow-up turn. */
  findingsContinued: boolean;
  /** Mutation tool calls so far in this prompt (a baseline that finishes after one is discarded). */
  mutations: number;
}

function newPrompt(seq: number): PromptState {
  return { seq, repairRound: 0, pendingRepair: false, finalized: false, mustRun: [], orig: new Map(), files: new Set(), reported: new Set(), findingsContinued: false, mutations: 0 };
}

interface SessionState {
  config: ProfileConfig;
  root: string;
  gitRoot?: string;
  stored?: StoredProfile;
  profiles: Map<string, StoredProfile>;
  tracker: ChangeTracker;
  /** Files written by tools during the current turn (verify.perTurn). */
  turnFiles: Set<string>;
  /** A shell tool ran during the current turn: files may have changed outside tool tracking. */
  turnBash: boolean;
  broken: Map<string, string>;
  notifiedBroken: Set<string>;
  askedThisSession: Set<Tier>;
  prompt: PromptState;
  gateRunning: boolean;
  abort: AbortController;
  renderedSection?: string;
  renderedKey?: string;
  lastVerdict?: string;
  supersededIds: Set<string>;
  /** Last full-run diagnostics per check (id@cwd): the source of the pre-existing-failure baseline. */
  lastDiag: Map<string, Map<string, number>>;
  /** lastDiag frozen when the current prompt started. */
  promptBaseline: Map<string, Map<string, number>>;
  /** Checks whose pre-existing failures were already reported to the user this session. */
  notifiedKnown: Set<string>;
  /** Baseline runs (project-wide auto checks on the untouched tree) per project dir, started by the agent's first read there. */
  baselines: Map<string, { promise: Promise<void>; done: boolean; abort: AbortController }>;
  /** Status line text outside of check runs. */
  idleStatus?: string;
  /** Glob-scoped / always-on rule files (.cursor/rules, .github/instructions, .windsurf/rules). */
  rules: ScopedRule[];
  /** Instruction files (abs paths and "#"+content hashes) already delivered this session. */
  injected: Set<string>;
  /** linguist-generated patterns (relative to the git root, else the project root). */
  genPatterns: string[];
  /** Generated files already warned about this session. */
  generatedWarned: Set<string>;
  mode: string;
  hasUI: boolean;
}


export default function projectProfile(pi: ExtensionAPI) {
  let s: SessionState | undefined;

  // ------------------------------------------------------------------ helpers
  const dir = agentDir();

  function verifyEnabled(): boolean {
    if (!s) return false;
    if (s.stored?.user.verify !== undefined) return s.stored.user.verify;
    if (!s.config.verify.enabled) return false;
    if (!s.hasUI && !s.config.verify.headless) return false;
    return true;
  }

  function profileFor(root: string): StoredProfile | undefined {
    if (!s) return undefined;
    if (root === s.root) return s.stored;
    const cached = s.profiles.get(root);
    if (cached) return cached;
    try {
      const { stored } = loadOrDetect(dir, root, s.config, s.gitRoot);
      s.profiles.set(root, stored);
      return stored;
    } catch {
      return undefined;
    }
  }

  function setStatus(ctx: ExtensionContext, text: string | undefined) {
    try {
      ctx.ui.setStatus(STATUS_KEY, text);
    } catch {
      /* no UI */
    }
  }

  function notify(ctx: ExtensionContext, msg: string, type: "info" | "warning" | "error" = "info") {
    try {
      ctx.ui.notify(msg, type);
    } catch {
      /* no UI */
    }
  }

  function makeHooks(ctx: ExtensionContext, signal: AbortSignal, opts: { interactive: boolean; baseline?: boolean }): GateHooks {
    return {
      broken: s!.broken,
      baseline: opts.baseline === false ? undefined : (check) => s!.promptBaseline.get(checkKey(check)),
      signal,
      progress: (t) => setStatus(ctx, `⏳ ${t}`),
      permission: async (tier, planned) => {
        const st = s!;
        const stored = st.stored;
        if (!stored) return "skip";
        const cur = tierAllowed(tier, stored, st.config);
        if (cur !== "ask") return cur;
        if (!ctx.hasUI || !opts.interactive) return "skip";
        if (st.askedThisSession.has(tier)) return "skip";
        const cmds = uniq(planned.map((p) => p.check.cmd.replace(" <files>", "")));
        const name = stored.detected.name ?? basename(st.root);
        setStatus(ctx, `? ${tier} permission`);
        const label = tier === "test" ? "tests" : "builds";
        let choice: string | undefined;
        try {
          choice = await ctx.ui.select(`project-profile: run ${label} in ${name} after the agent's changes?`, [`Yes, always for this repo — ${cmds.join(" · ")}`, "Not now (ask again next session)", `Never for this repo`], { timeout: 90_000 });
        } catch {
          choice = undefined;
        }
        if (choice?.startsWith("Yes")) {
          updateUser(dir, stored, (u) => {
            u.permissions[tier === "test" ? "tests" : "build"] = "allow";
          });
          invalidateSection();
          return "allow";
        }
        if (choice?.startsWith("Never")) {
          updateUser(dir, stored, (u) => {
            u.permissions[tier === "test" ? "tests" : "build"] = "deny";
          });
          invalidateSection();
          return "deny";
        }
        st.askedThisSession.add(tier);
        return "skip";
      },
    };
  }

  function invalidateSection() {
    if (s) {
      s.renderedSection = undefined;
      s.renderedKey = undefined;
    }
  }

  function reportEnvFailures(ctx: ExtensionContext, verdict: GateVerdict) {
    for (const r of verdict.runs) {
      if (r.status !== "env") continue;
      const key = checkKey(r.check);
      if (s!.notifiedBroken.has(key)) continue;
      s!.notifiedBroken.add(key);
      const cmd = r.check.cmd.replace(" <files>", "");
      const log = r.logPath ? ` · log: ${tildify(r.logPath)}` : "";
      notify(ctx, `verify: ${r.check.label} (\`${cmd}\`) disabled this session — ${r.reason}${log}`, "warning");
      pi.sendMessage(
        { customType: VERIFY_MSG, content: `[verification] ${r.check.label} (\`${cmd}\`) could not run and is disabled for this session — ${r.reason}${log}. Nothing verified ${r.check.label} for you: do not assume it passes.`, display: true, details: { seq: -1, kind: "env", headline: `${r.check.label} unavailable: ${r.reason}` } },
        { triggerTurn: false },
      );
    }
  }

  /** Remember full-run diagnostics of project-wide checks (scoped runs only cover part of the output). */
  function recordDiag(verdict: GateVerdict) {
    for (const r of verdict.runs) {
      if (!r.diag || r.scoped) continue;
      if (r.status === "pass" || r.status === "fail" || r.status === "preexisting") s!.lastDiag.set(checkKey(r.check), r.diag);
    }
  }

  /**
   * Pre-existing failures must not cost repair rounds in the first prompt either: run a project dir's project-wide
   * auto checks once on the untouched tree, in the background, and record their diagnostics as the baseline. The agent
   * reads before it writes, so its first read in a project dir is the trigger; the run is discarded when anything
   * changed before it finished, because its output could then include the agent's own work.
   */
  function startBaseline(ctx: ExtensionContext, projectDir: string): void {
    const st = s!;
    if (st.baselines.has(projectDir) || st.baselines.size >= MAX_BASELINES) return;
    if (!verifyEnabled() || !ctx.isProjectTrusted() || st.prompt.mutations > 0) return;
    const stored = profileFor(projectDir);
    if (!stored) return;
    // Workspace-wide runs (turbo, pnpm -r) fan out over every package: too much background work for a guess.
    const eligible = (c: Check) => (c.tier === "fast" || c.tier === "lint") && !c.appendFiles && !c.coversWorkspace && !st.lastDiag.has(checkKey(c));
    const plan = buildPlan([], { projectRoot: projectDir, gitRoot: st.gitRoot, ignoreDirs: st.config.ignoreDirs, profileFor, checksFor: (p) => effectiveChecks(p).filter(eligible), unscoped: true });
    if (TIER_ORDER.every((t) => (plan.byTier.get(t)?.length ?? 0) === 0)) return;
    const seq = st.prompt.seq;
    const abort = new AbortController();
    st.abort.signal.addEventListener("abort", () => abort.abort(), { once: true });
    const entry = { promise: Promise.resolve(), done: false, abort };
    entry.promise = (async () => {
      const hooks = makeHooks(ctx, abort.signal, { interactive: false, baseline: false });
      hooks.stopOnRed = false;
      hooks.broken = new Map(); // an aborted or discarded run must not disable checks for the session
      hooks.progress = (t) => setStatus(ctx, `\u23f3 baseline ${t}`);
      const verdict = await runGate(plan, st.config, hooks);
      const peeked = st.gitRoot && !abort.signal.aborted ? await peekChanges(st.tracker) : undefined;
      const changed = abort.signal.aborted || st.prompt.mutations > 0 || st.prompt.seq !== seq || (st.gitRoot ? (peeked ?? ["?"]).length > 0 : st.tracker.bashRan);
      debug("baseline", { seq, dir: displayPath(st.root, projectDir) || ".", discarded: changed, status: verdict.status, ms: verdict.durationMs, runs: verdict.runs.map((r) => ({ id: r.check.id, status: r.status, code: r.exitCode, lines: r.diag ? diagCount(r.diag) : undefined })) });
      if (changed) {
        st.baselines.delete(projectDir); // a later read may try again on a quiet tree
        return;
      }
      for (const [k, v] of hooks.broken) st.broken.set(k, v);
      reportEnvFailures(ctx, verdict);
      recordDiag(verdict);
      for (const r of verdict.runs) {
        if (!r.diag || r.scoped) continue;
        const key = checkKey(r.check);
        st.promptBaseline.set(key, r.diag);
        if (r.status !== "fail" || st.notifiedKnown.has(key)) continue;
        st.notifiedKnown.add(key);
        notify(ctx, `verify: ${r.check.label}${whereOf(r.check.cwd)} already fails on the untouched tree (${diagCount(r.diag)} diagnostic${diagCount(r.diag) === 1 ? "" : "s"}) \u2014 only new failures are sent to the agent`, "info");
      }
    })()
      .catch((err: Error) => debug("baseline-error", { dir: projectDir, error: err.message }))
      .finally(() => {
        entry.done = true;
        if (!st.gateRunning) setStatus(ctx, st.idleStatus);
      });
    st.baselines.set(projectDir, entry);
  }

  /** The tree is about to be checked for real: a baseline still running would be discarded anyway, so stop it now. */
  async function stopBaselines(): Promise<void> {
    const pending = Array.from(s!.baselines.values()).filter((b) => !b.done);
    for (const b of pending) b.abort.abort();
    await Promise.all(pending.map((b) => b.promise));
  }

  function baselinePending(): boolean {
    return Array.from(s!.baselines.values()).some((b) => !b.done);
  }

  /** Fix hint for a failing run; project-wide checks get the agent's changed files under their cwd so the hint stays file-scoped. */
  function hintFor(r: GateVerdict["runs"][number], changed: string[] = []): string | undefined {
    const prof = profileFor(r.check.cwd) ?? s!.stored;
    const own = changed.filter((f) => f.startsWith(r.check.cwd + sep) && (!r.check.exts?.length || r.check.exts.includes(ext(f)))).map((f) => relative(r.check.cwd, f).split(sep).join("/"));
    return fixHint(r.check, r.files ?? own, prof ? effectiveCommands(prof) : {});
  }

  /** A project script rewrites everything it covers, not only the agent's files: say so. */
  function hintLine(hint: string, then: string): string {
    const wide = /^(npm|pnpm|yarn|bun) (run )?\S+$/.test(hint) || /^(make|just|task) \S+$/.test(hint);
    return wide ? `Auto-fix available: \`${hint}\` — it rewrites every file the script covers: run it, check \`git status\`, revert files outside your change${then}` : `Auto-fix available: \`${hint}\`${then}`;
  }

  /** Content of a file when the prompt started: captured before the first tool write, else git HEAD for files that were clean then. */
  function beforeContent(abs: string): Before {
    const st = s!;
    if (st.prompt.orig.has(abs)) return st.prompt.orig.get(abs)!;
    if (!st.gitRoot || !st.prompt.startSnapshot) return SKIP;
    const rel = relative(st.gitRoot, abs).split(sep).join("/");
    if (rel.startsWith("..") || st.prompt.startSnapshot.has(rel)) return SKIP; // outside the repo, or already dirty when the task began
    return headContent(st.gitRoot, rel);
  }

  function gitIgnored(abs: string): boolean | undefined {
    const g = s!.gitRoot;
    if (!g) return undefined;
    const r = spawnSync("git", ["check-ignore", "-q", "--", relative(g, abs).split(sep).join("/")], { cwd: g, timeout: 5000 });
    return r.status === 0 ? true : r.status === 1 ? false : undefined;
  }

  /** New diff-guard findings for everything this prompt changed so far. */
  function freshFindings(): Finding[] {
    const st = s!;
    if (!st.config.verify.guard || st.prompt.files.size === 0) return [];
    const all = collectFindings({ root: st.root, gitRoot: st.gitRoot, files: Array.from(st.prompt.files).sort(), before: beforeContent, ignored: gitIgnored });
    const fresh = all.filter((f) => !st.prompt.reported.has(f.key));
    for (const f of fresh) st.prompt.reported.add(f.key);
    return fresh;
  }

  function summarizeKinds(fs: Finding[]): string {
    const n = (k: Finding["kind"][]) => fs.filter((f) => k.includes(f.kind)).reduce((a, f) => a + Math.max(1, f.lines.length), 0);
    const parts: string[] = [];
    const add = (count: number, one: string, many: string) => count && parts.push(count === 1 ? one : `${count} ${many}`);
    add(n(["secret"]), "a possible secret", "possible secrets");
    add(n(["env-file"]), "an unignored .env file", "unignored .env files");
    add(n(["lockfile"]), "a stale lockfile", "stale lockfiles");
    add(n(["focus"]), "a focused test (.only)", "focused tests");
    add(n(["suppression"]), "a check suppression", "check suppressions");
    add(n(["skip"]), "a skipped test", "skipped tests");
    add(n(["stub"]), "a stub", "stubs");
    add(n(["loosen"]), "a loosened check config", "loosened check configs");
    add(n(["deleted-test", "removed-tests"]), "removed tests", "removals of tests");
    return parts.join(", ");
  }

  /** Report findings: secrets/lockfile/.only always get one follow-up turn; weakening only when it happened while checks were failing. */
  function findingsDraft(ctx: ExtensionContext, found: Finding[], failing: boolean): { draft: SessionBoundaryDraft; cont: boolean } | undefined {
    const st = s!;
    if (found.length === 0) return undefined;
    const fix = found.some(mustFix);
    const gamed = failing && found.some(isWeakening);
    const cont = (fix || gamed) && !st.prompt.findingsContinued;
    if (cont) st.prompt.findingsContinued = true;
    const summary = summarizeKinds(found);
    const secrets = found.filter((f) => f.kind === "secret" || f.kind === "env-file");
    notify(ctx, `verify: this task added ${summary}${secrets.length ? ` — check ${uniq(secrets.map((f) => f.file)).join(", ")} before committing` : ""}`, secrets.length ? "warning" : "info");
    debug("findings", { seq: st.prompt.seq, cont, found: found.map((f) => ({ kind: f.kind, file: f.file, lines: f.lines })) });
    const lines = ["[verification] review of this task's changes:", ...found.map(formatFinding), ""];
    if (gamed) lines.push("You added these while verification was failing. Remove them and fix the underlying problem; if one is genuinely needed, keep it and justify it in your final message to the user.");
    else if (cont) {
      const todo: string[] = [];
      if (found.some((f) => f.kind === "lockfile")) todo.push("run the lockfile command shown");
      if (found.some((f) => f.kind === "focus")) todo.push("remove the `.only`/focus marker");
      if (found.some((f) => f.kind === "secret")) todo.push("move credentials into environment variables or untracked config");
      lines.push(`Before finishing: ${todo.join("; ")} — unless the user explicitly asked for it, in which case say so in your final message.`);
    }
    else lines.push("(Shown to the user. No automatic follow-up.)");
    return { draft: { type: "custom_message", customType: VERIFY_MSG, content: lines.join("\n"), display: true, details: { seq: st.prompt.seq, kind: "finding", headline: `review: ${summary}` } }, cont };
  }

  /** Assemble a boundary result: earlier handlers' entries + ours (+ findings), continuing when any part asks to. */
  function boundary(prior: SessionBoundaryDraft[], drafts: SessionBoundaryDraft[], cont: boolean, f?: { draft: SessionBoundaryDraft; cont: boolean }) {
    if (f) {
      drafts.push(f.draft);
      cont = cont || f.cont;
    }
    if (drafts.length === 0) return undefined;
    return cont ? { entries: [...prior, ...drafts], continue: true } : { entries: [...prior, ...drafts] };
  }

  function whereOf(cwd: string): string {
    return cwd === s!.root ? "" : ` in ${displayPath(s!.root, cwd)}`;
  }

  /** Failures that pre-date the task: the user hears about them once per session; the agent gets a one-line note, never a repair round. */
  function knownNote(ctx: ExtensionContext, verdict: GateVerdict): SessionBoundaryDraft | undefined {
    const known = verdict.runs.filter((r) => r.status === "preexisting");
    if (known.length === 0) return undefined;
    const parts = known.map((r) => `${r.check.label}${whereOf(r.check.cwd)} (${r.preexisting} known)`);
    for (const r of known) {
      const key = checkKey(r.check);
      if (s!.notifiedKnown.has(key)) continue;
      s!.notifiedKnown.add(key);
      notify(ctx, `verify: ${r.check.label}${whereOf(r.check.cwd)} still reports ${r.preexisting} failure${r.preexisting === 1 ? "" : "s"} that existed before this task — not sent to the agent`, "info");
    }
    return { type: "custom_message", customType: VERIFY_MSG, content: `[verification] no new failures from this task. Already failing before it and left alone: ${parts.join(", ")}. Mention it if you report on verification; do not try to fix it unless the user asks.`, display: true, details: { seq: s!.prompt.seq, kind: "info", headline: `no new failures · known: ${parts.join(", ")}` } };
  }

  function failureMessage(verdict: GateVerdict, round: number, max: number): string {
    const st = s!;
    const failing = verdict.runs.filter((r) => r.status === "fail");
    const passed = verdict.runs.filter((r) => r.status === "pass").map((r) => r.check.label);
    const lines: string[] = [];
    for (const r of failing) {
      const where = r.check.cwd === st.root ? "" : ` (in ${displayPath(st.root, r.check.cwd)})`;
      lines.push(`[verification] ✗ ${r.check.label} — \`${r.check.cmd.replace(" <files>", "")}\` exited ${r.exitCode ?? "?"} in ${(r.durationMs / 1000).toFixed(1)}s${where} — repair round ${round} of ${max}`);
      lines.push("```");
      lines.push(...r.summary);
      lines.push("```");
      const shown = r.summary.length;
      if (r.totalLines > shown) lines.push(`(${r.totalLines - shown} more lines${r.logPath ? `; full log: ${r.logPath}` : ""})`);
      else if (r.logPath) lines.push(`(full log: ${r.logPath})`);
      const hint = hintFor(r, verdict.changedFiles);
      if (hint) lines.push(hintLine(hint, " — run it, then end your turn (verification re-runs)."));
      if (r.preexisting) lines.push(`(${r.preexisting} other diagnostic line${r.preexisting === 1 ? "" : "s"} of this check already failed before this task and ${r.preexisting === 1 ? "is" : "are"} hidden — leave ${r.preexisting === 1 ? "it" : "them"} alone unless asked.)`);
    }
    if (passed.length) lines.push(`Passed: ${uniq(passed).join(", ")}.`);
    const changed = verdict.changedFiles.map((f) => displayPath(st.root, f));
    if (changed.length) lines.push(`Files changed this run: ${changed.slice(0, 12).join(", ")}${changed.length > 12 ? ` (+${changed.length - 12})` : ""}.`);
    lines.push("");
    lines.push("Fix the underlying cause in the code, then end your turn; verification re-runs automatically. Do not skip, disable, or loosen the check, do not add ignore/suppress comments to silence it, and do not claim success while it fails. If the failure is pre-existing and unrelated to your change, say so explicitly and stop.");
    return lines.join("\n");
  }

  function giveUpMessage(verdict: GateVerdict, reason: string, summarize: boolean): string {
    const failing = verdict.runs.filter((r) => r.status === "fail").map((r) => `${r.check.label} (\`${r.check.cmd.replace(" <files>", "")}\`)`);
    const head = `[verification] automatic repair stopped: ${reason}. Still failing: ${failing.join(", ")}.`;
    if (!summarize) return `${head} The user has been notified. Do not claim the task is complete.`;
    return `${head}\nDo not make further code changes now. Reply with a short summary for the user: what is failing, what you tried, your best hypothesis, and what you recommend next. Do not claim the task is complete.`;
  }

  /** Replace earlier failure / per-turn messages from this prompt with a one-liner to save context. */
  function supersedeDrafts(ctx: ExtensionContext, kinds: string[] = ["failure", "perturn"]): SessionBoundaryDraft[] {
    const st = s!;
    const drafts: SessionBoundaryDraft[] = [];
    try {
      for (const entry of ctx.sessionManager.getBranch()) {
        if (entry.type !== "custom_message" || entry.customType !== VERIFY_MSG) continue;
        const det = entry.details as { seq?: number; kind?: string } | undefined;
        if (det?.seq !== st.prompt.seq || !kinds.includes(det.kind ?? "")) continue;
        if (st.supersededIds.has(entry.id)) continue;
        st.supersededIds.add(entry.id);
        drafts.push({ type: "context_edit", targetId: entry.id, replacement: { content: [{ type: "text", text: "[verification] an earlier check failure in this task was superseded by a later verification run." }] } });
      }
    } catch {
      /* ignore */
    }
    return drafts;
  }

  async function buildGatePlan(files: string[], opts: { unscoped: boolean; mustRun?: PlannedCheck[]; roots?: string[] }) {
    const st = s!;
    return buildPlan(files, {
      projectRoot: st.root,
      gitRoot: st.gitRoot,
      ignoreDirs: st.config.ignoreDirs,
      profileFor,
      checksFor: (stored) => effectiveChecks(stored),
      mustRun: opts.mustRun,
      unscoped: opts.unscoped,
      roots: opts.roots,
    });
  }

  function verdictLine(v: GateVerdict): string {
    const icon = v.status === "green" ? "✓" : v.status === "red" ? "✗" : v.status === "env" ? "⚠" : "–";
    return `${icon} ${describeRuns(v.runs)}`;
  }

  /** Short footer text: "✓ typecheck·test 1.5s" / "✗ lint" / "⚠ typecheck unavailable". */
  function statusText(v: GateVerdict): string {
    const labels = (status: string) => uniq(v.runs.filter((r) => r.status === status && r.check.tier !== "syntax").map((r) => r.check.label));
    const secs = `${(v.durationMs / 1000).toFixed(1)}s`;
    if (v.status === "red") return `✗ ${labels("fail").join("·")}`;
    const known = v.runs.reduce((n, r) => n + (r.status === "preexisting" ? (r.preexisting ?? 0) : 0), 0);
    if (v.status === "green") return `✓ ${uniq([...labels("pass"), ...labels("preexisting")]).join("·") || "syntax"} ${secs}${known ? ` (${known} known)` : ""}`;
    if (v.status === "env") return `⚠ ${labels("env").join("·")} unavailable`;
    return "– nothing to verify";
  }

  // ------------------------------------------------------------------ renderers
  pi.registerMessageRenderer(VERIFY_MSG, (message, { expanded, outputPad }, theme) => {
    const details = message.details as { kind?: string; headline?: string } | undefined;
    const kind = details?.kind ?? "info";
    const color = kind === "failure" ? "error" : kind === "giveup" || kind === "perturn" || kind === "finding" || kind === "env" ? "warning" : "success";
    const head = `${theme.fg(color, "[verify]")} ${details?.headline ?? ""}`;
    const box = new Box(outputPad, 1, (t) => theme.bg("customMessageBg", t));
    box.addChild(new Text(head, 0, 0));
    if (expanded) {
      const body = typeof message.content === "string" ? message.content : message.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
      box.addChild(new Markdown(body, 0, 0, getMarkdownTheme()));
    } else box.addChild(new Text(theme.fg("dim", "  (ctrl+o to expand)"), 0, 0));
    return box;
  });

  pi.registerEntryRenderer<{ markdown: string }>(REPORT_ENTRY, (entry, { expanded }, theme) => {
    const box = new Box(1, 1, (t) => theme.bg("customMessageBg", t));
    const md = entry.data?.markdown ?? "";
    box.addChild(new Markdown(expanded ? md : md.split("\n").slice(0, 14).join("\n") + (md.split("\n").length > 14 ? "\n\n_(ctrl+o to expand)_" : ""), 0, 0, getMarkdownTheme()));
    return box;
  });

  function showReport(markdown: string) {
    pi.appendEntry(REPORT_ENTRY, { markdown });
  }

  // ------------------------------------------------------------------ session lifecycle
  pi.on("session_start", async (_event, ctx) => {
    const { config, issues } = loadConfig(dir);
    const { root, gitRoot } = findProjectRoot(ctx.cwd);
    s = {
      config,
      root,
      gitRoot,
      profiles: new Map(),
      tracker: newTracker(gitRoot),
      turnFiles: new Set(),
      turnBash: false,
      broken: new Map(),
      notifiedBroken: new Set(),
      askedThisSession: new Set(),
      prompt: newPrompt(0),
      gateRunning: false,
      abort: new AbortController(),
      supersededIds: new Set(),
      lastDiag: new Map(),
      promptBaseline: new Map(),
      notifiedKnown: new Set(),
      baselines: new Map(),
      rules: discoverRules(uniq([root, gitRoot ?? root])),
      injected: new Set(),
      genPatterns: generatedPatterns(readText(join(gitRoot ?? root, ".gitattributes"))),
      generatedWarned: new Set(),
      mode: ctx.mode,
      hasUI: ctx.hasUI,
    };
    for (const i of issues) notify(ctx, `project-profile config: ${i}`, "warning");
    pruneLogs();
    pruneProfiles(dir);
    // The home directory is not a project: profiling it would put its private layout into the prompt and run nothing useful.
    if (root === realpath(homedir())) {
      setStatus(ctx, "no project (home directory)");
      return;
    }
    try {
      const { stored, refreshed } = loadOrDetect(dir, root, config, gitRoot);
      s.stored = stored;
      debug("session_start", { cwd: ctx.cwd, root, gitRoot, refreshed, mode: ctx.mode, hasUI: ctx.hasUI, checks: effectiveChecks(stored).map((c) => `${c.tier}:${c.cmd}`) });
      const checks = effectiveChecks(stored);
      const auto = checks.filter((c) => (c.tier === "fast" || c.tier === "lint") && !availability(c)).length;
      const langs = stored.detected.languages.slice(0, 3).join("/") || "unknown stack";
      const trusted = ctx.isProjectTrusted();
      s.idleStatus = !trusted ? `${langs} · verify off (untrusted project)` : verifyEnabled() ? `${langs} · ${auto} auto-check${auto === 1 ? "" : "s"}` : `${langs} · verify off`;
      setStatus(ctx, s.idleStatus);
      if (refreshed && ctx.hasUI && ctx.mode === "tui") {
        const cmds = Object.entries(stored.detected.commands)
          .filter(([k]) => ["typecheck", "lint", "test", "build"].includes(k))
          .map(([k, v]) => `${k} \`${v.cmd}\``);
        notify(ctx, `project-profile: ${stored.detected.name ?? basename(root)} — ${langs}${cmds.length ? " · " + cmds.join(" · ") : ""} (/profile for details)`, "info");
      }
    } catch (err) {
      notify(ctx, `project-profile: detection failed — ${(err as Error).message}`, "warning");
    }
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    s?.abort.abort();
    setStatus(ctx, undefined);
  });

  // ------------------------------------------------------------------ prompt injection + per-prompt reset
  pi.on("before_agent_start", async (event, ctx) => {
    if (!s) return;
    // new user prompt → new repair budget
    s.prompt = newPrompt(s.prompt.seq + 1);
    s.turnFiles.clear();
    s.turnBash = false;
    // Failures recorded before this prompt are pre-existing for the whole prompt.
    s.promptBaseline = new Map(s.lastDiag);
    if (verifyEnabled()) {
      await snapshotStart(s.tracker);
      s.prompt.startSnapshot = s.tracker.snapshot ? new Map(s.tracker.snapshot) : undefined;
      if (s.stored) startBaseline(ctx, s.root);
    }
    if (!s.config.profile.inject || !s.stored) return;
    const loaded = event.systemPromptOptions.contextFiles.map((f) => f.path);
    const key = `${s.stored.updatedAt}|${verifyEnabled()}|${loaded.join(",")}`;
    if (s.renderedKey !== key || !s.renderedSection) {
      s.renderedSection = renderPromptSection(s.stored, s.config, { verifyEnabled: verifyEnabled(), piLoadedContextFiles: loaded });
      s.renderedKey = key;
    }
    event.systemPromptOptions.sections["project_profile"] = s.renderedSection;
  });

  // ------------------------------------------------------------------ change tracking
  const isMutationTool = (name: string) => name === "write" || name === "edit" || (/edit|write|patch|apply|replace|insert|move|rename|delete|create/i.test(name) && !/read|grep|find|search|list|ls|describe|status/i.test(name));
  pi.on("tool_call", async (event, ctx) => {
    if (!s || !isMutationTool(event.toolName)) return;
    s.prompt.mutations++;
    if (!s.config.verify.guard) return;
    const input = event.input as Record<string, unknown>;
    const p = toolPath(ctx.cwd, input.path ?? input.file ?? input.filePath);
    if (p && !s.prompt.orig.has(p)) s.prompt.orig.set(p, readForDiff(p));
  });

  pi.on("tool_result", async (event, ctx) => {
    if (!s) return;
    const st = s;
    const name = event.toolName;
    const track = (path: unknown) => {
      const p = toolPath(ctx.cwd, path);
      if (!p) return;
      st.tracker.tracked.add(p);
      st.turnFiles.add(p);
    };
    if (name === "write" || name === "edit") {
      if (!event.isError) track(event.input.path);
      return;
    }
    const shell = () => {
      st.tracker.bashRan = true;
      st.turnBash = true;
    };
    if (name === "bash" || name === "powershell" || name === "hypa_shell" || name === "interactive_shell") shell();
    else if (/edit|write|patch|apply|replace|insert|move|rename|delete|create/i.test(name) && !/read|grep|find|search|list|ls|describe|status/i.test(name)) {
      // third-party mutation tools (hashline editors etc.): path arg if present, else assume unknown changes
      if (typeof event.input.path === "string") track(event.input.path);
      else if (typeof event.input.file === "string") track(event.input.file);
      else shell();
    }
  });

  // ------------------------------------------------------------------ notes on tool results: scoped instructions, generated files
  pi.on("tool_result", async (event, ctx) => {
    if (!s || event.isError || event.toolName === "bash" || event.toolName === "powershell") return;
    const st = s;
    const input = event.input as Record<string, unknown>;
    const given = toolPath(ctx.cwd, input.path ?? input.file ?? input.filePath);
    if (!given) return;
    const abs = realpath(given);
    const top = st.gitRoot ?? st.root;
    if (!(abs === top || abs.startsWith(top + sep))) return;
    const display = (p: string) => relative(top, p).split(sep).join("/") || ".";
    const notes: string[] = [];
    const mutation = isMutationTool(event.toolName);
    // A read is the earliest sign of where the agent will write: baseline that project's checks while the tree is untouched.
    if (!mutation && st.stored && !isIgnoredPath(abs, st.config.ignoreDirs)) startBaseline(ctx, nearestProjectDir(abs, top));
    // Generated files: hand edits are overwritten on regeneration.
    if (mutation && st.config.verify.guard && !st.generatedWarned.has(abs)) {
      const orig = st.prompt.orig.get(given) ?? st.prompt.orig.get(abs);
      const head = typeof orig === "string" && orig !== SKIP ? orig.slice(0, 2000) : readText(abs, 2000);
      const reason = generatedReason(display(abs), head, st.genPatterns);
      if (reason) {
        st.generatedWarned.add(abs);
        const prof = profileFor(dirname(abs)) ?? st.stored;
        const gen = prof ? effectiveCommands(prof)["generate"]?.cmd : undefined;
        notes.push(`[project-profile] ${display(abs)} is a generated file (${reason}): hand edits are overwritten the next time it is regenerated. Change the source it is generated from and regenerate${gen ? ` (\`${gen}\`)` : ""}, unless the user explicitly asked for a hand edit.`);
        debug("generated", { file: display(abs), reason });
      }
    }
    // Instructions that apply here but that π did not load (nested AGENTS.md, glob-scoped rules).
    if (st.config.profile.scopedInstructions) {
      let isDirectory = false;
      try {
        isDirectory = statSync(abs).isDirectory();
      } catch {
        /* new file */
      }
      const targetDir = isDirectory ? abs : dirname(abs);
      const maxFile = st.config.profile.maxInstructionFileChars;
      let budget = st.config.profile.maxInstructionTotalChars;
      const parts: InjectionPart[] = [];
      const deliver = (file: string, scope?: string) => {
        if (st.injected.has(file)) return;
        st.injected.add(file);
        const part = readInstruction(file, display(file), maxFile, scope);
        if (part.hash) {
          if (st.injected.has("#" + part.hash)) return; // same content already delivered (CLAUDE.md → AGENTS.md symlinks)
          st.injected.add("#" + part.hash);
        }
        if (part.content !== undefined) {
          if (part.content.length > budget) {
            part.note = `${Math.round(part.content.length / 1024) || 1} KB — read it before changing files here`;
            delete part.content;
          } else budget -= part.content.length;
        }
        parts.push(part);
      };
      for (const f of nestedInstructionFiles(targetDir, realpath(ctx.cwd), top)) deliver(f);
      if (!isDirectory) for (const r of matchingRules(abs, st.rules)) deliver(r.abs, r.always ? "all files" : r.patterns.join(", "));
      if (parts.length) {
        notes.push(renderInjection(display(abs), parts));
        debug("scoped", { target: display(abs), files: parts.map((p) => p.path) });
      }
    }
    if (notes.length === 0) return;
    return { content: [...event.content, { type: "text" as const, text: notes.join("\n\n") }] };
  });

  // Compaction may summarise delivered instructions away: deliver again on the next touch.
  pi.on("session_compact", async () => {
    if (!s) return;
    s.injected.clear();
    s.generatedWarned.clear();
  });

  // ------------------------------------------------------------------ the gate
  pi.on("agent_before_settle", async (event, ctx) => {
    if (!s || !s.stored || !verifyEnabled()) return;
    if (event.outcome !== "completed") return;
    if (s.gateRunning) return;
    if (!ctx.isProjectTrusted()) return;
    const st = s;
    st.gateRunning = true;
    try {
      const { files, unknownChanges, gitDetected } = await collectChanges(st.tracker);
      for (const f of files) st.prompt.files.add(f);
      const found = files.length ? freshFindings() : [];
      debug("settle", { seq: st.prompt.seq, round: st.prompt.repairRound, files, gitDetected, unknownChanges, pendingRepair: st.prompt.pendingRepair, finalized: st.prompt.finalized });
      if (files.length === 0 && !unknownChanges) {
        if (st.prompt.pendingRepair && !st.prompt.finalized) {
          // The agent ended its turn without changing anything: no progress.
          st.prompt.pendingRepair = false;
          st.prompt.finalized = true;
          setStatus(ctx, "✗ unresolved");
          notify(ctx, "verify: agent made no changes after the last failure — stopping automatic repair", "warning");
          return { entries: [...event.entries, { type: "custom_message", customType: VERIFY_MSG, content: "[verification] the previous check failure is still unresolved and no files were changed in the last turn; automatic repair stopped. If you explained that the failure is not caused by this task, nothing more is needed; otherwise do not claim the task is complete.", display: true, details: { seq: st.prompt.seq, kind: "giveup", headline: "no changes since last failure — stopped" } }] };
        }
        return;
      }
      const plan = await buildGatePlan(files, { unscoped: unknownChanges && files.length === 0, mustRun: st.prompt.mustRun });
      const total = TIER_ORDER.reduce((n, t) => n + (plan.byTier.get(t)?.length ?? 0), 0);
      if (total === 0) return boundary(event.entries, [], false, findingsDraft(ctx, found, st.prompt.repairRound > 0));
      await stopBaselines();
      const hooks = makeHooks(ctx, st.abort.signal, { interactive: true });
      setStatus(ctx, "⏳ verifying…");
      const verdict = await runGate(plan, st.config, hooks);
      recordDiag(verdict);
      st.lastVerdict = verdictLine(verdict);
      debug("verdict", { seq: st.prompt.seq, status: verdict.status, ms: verdict.durationMs, runs: verdict.runs.map((r) => ({ id: r.check.id, status: r.status, code: r.exitCode, ms: r.durationMs, reason: r.reason, lines: r.summary.length, known: r.preexisting })) });
      reportEnvFailures(ctx, verdict);
      const max = st.config.verify.maxRepairRounds;
      if (verdict.status === "green") {
        setStatus(ctx, statusText(verdict));
        const drafts = supersedeDrafts(ctx);
        if (st.prompt.pendingRepair) {
          notify(ctx, `verify: checks pass after ${st.prompt.repairRound} repair round${st.prompt.repairRound === 1 ? "" : "s"} (${describeRuns(verdict.runs)})`, "info");
          drafts.push({ type: "custom_message", customType: VERIFY_MSG, content: `[verification] ✓ all checks pass now: ${describeRuns(verdict.runs)}.`, display: true, details: { seq: st.prompt.seq, kind: "pass", headline: `passed — ${describeRuns(verdict.runs)}` } });
        }
        const known = knownNote(ctx, verdict);
        if (known) drafts.push(known);
        const failedEarlier = st.prompt.repairRound > 0;
        st.prompt.pendingRepair = false;
        st.prompt.mustRun = [];
        // Boundary results replace the draft chain: always carry earlier handlers' entries.
        return boundary(event.entries, drafts, false, findingsDraft(ctx, found, failedEarlier));
      }
      if (verdict.status === "red") {
        const failingPlanned: PlannedCheck[] = [];
        for (const t of TIER_ORDER) for (const p of plan.byTier.get(t) ?? []) if (verdict.runs.some((r) => r.status === "fail" && r.check.id === p.check.id && r.check.cwd === p.check.cwd)) failingPlanned.push(p);
        const failingLabels = uniq(verdict.runs.filter((r) => r.status === "fail").map((r) => r.check.label)).join(", ");
        setStatus(ctx, `✗ ${failingLabels}`);
        if (st.prompt.finalized) {
          notify(ctx, `verify: still failing (${failingLabels}); automatic repair already stopped for this prompt`, "warning");
          return boundary(event.entries, [], false, findingsDraft(ctx, found, true));
        }
        const drafts = supersedeDrafts(ctx);
        const round = st.prompt.repairRound + 1;
        let stopReason: string | undefined;
        if (round > max) stopReason = `${max} repair rounds exhausted`;
        else if (st.prompt.lastSignature && st.prompt.lastSignature === verdict.signature) stopReason = "the same failure repeated with no progress";
        if (stopReason) {
          debug("giveup", { seq: st.prompt.seq, stopReason });
          st.prompt.finalized = true;
          st.prompt.pendingRepair = false;
          st.prompt.mustRun = [];
          notify(ctx, `verify: ${stopReason} — ${failingLabels} still failing; see the transcript`, "warning");
          const summarize = st.config.verify.summarizeOnGiveUp;
          drafts.push({ type: "custom_message", customType: VERIFY_MSG, content: giveUpMessage(verdict, stopReason, summarize), display: true, details: { seq: st.prompt.seq, kind: "giveup", headline: `stopped — ${stopReason} (${failingLabels})` } });
          return boundary(event.entries, drafts, summarize, findingsDraft(ctx, found, true));
        }
        st.prompt.repairRound = round;
        st.prompt.lastSignature = verdict.signature;
        st.prompt.pendingRepair = true;
        st.prompt.mustRun = failingPlanned;
        debug("repair", { seq: st.prompt.seq, round, failing: failingLabels });
        notify(ctx, `verify: ${failingLabels} failed — sending the agent back (round ${round}/${max})`, "info");
        drafts.push({ type: "custom_message", customType: VERIFY_MSG, content: failureMessage(verdict, round, max), display: true, details: { seq: st.prompt.seq, kind: "failure", headline: `${failingLabels} failed — round ${round}/${max}` } });
        return boundary(event.entries, drafts, true, findingsDraft(ctx, found, true));
      }
      // env / skipped
      setStatus(ctx, verdict.status === "env" ? "⚠ checks unavailable" : "– nothing to verify");
      return boundary(event.entries, [], false, findingsDraft(ctx, found, st.prompt.repairRound > 0));
    } catch (err) {
      notify(ctx, `verify: internal error — ${(err as Error).message}`, "error");
      return;
    } finally {
      st.gateRunning = false;
    }
  });

  // ------------------------------------------------------------------ optional per-turn fast check
  function perTurnMessage(verdict: GateVerdict): string {
    const st = s!;
    const lines: string[] = [];
    for (const r of verdict.runs.filter((x) => x.status === "fail")) {
      const where = r.check.cwd === st.root ? "" : ` (in ${displayPath(st.root, r.check.cwd)})`;
      lines.push(`[verification] fast check after this turn: ✗ ${r.check.label} — \`${r.check.cmd.replace(" <files>", "")}\` exited ${r.exitCode ?? "?"}${where}`);
      lines.push("```");
      lines.push(...r.summary.slice(0, Math.max(8, Math.floor(st.config.verify.maxOutputLines / 2))));
      lines.push("```");
      if (r.totalLines > r.summary.length && r.logPath) lines.push(`(full log: ${r.logPath})`);
      const hint = hintFor(r, verdict.changedFiles);
      if (hint) lines.push(hintLine(hint, ""));
    }
    lines.push("Informational: you are mid-task, so failures from work still in progress are expected. Address them as you continue; the full verification runs when you finish and will send a repair request if anything still fails.");
    return lines.join("\n");
  }

  pi.on("turn_end", async (event, ctx) => {
    if (!s || !s.stored || !s.config.verify.perTurn || !verifyEnabled()) return;
    const st = s;
    const files = new Set(st.turnFiles);
    const bash = st.turnBash;
    st.turnFiles.clear();
    st.turnBash = false;
    if (event.outcome !== "completed" || st.gateRunning || baselinePending() || !ctx.isProjectTrusted()) return;
    if (files.size === 0 && !bash) return;
    st.gateRunning = true;
    try {
      // Shell tools may have edited files: peek at git (everything changed since the prompt started) without moving the settle snapshot.
      if (bash) for (const f of (await peekChanges(st.tracker)) ?? []) files.add(f);
      if (files.size === 0) return;
      const plan = await buildGatePlan(Array.from(files).sort(), { unscoped: false });
      for (const t of TIER_ORDER) if (t !== "syntax" && t !== "fast") plan.byTier.set(t, []);
      if ((plan.byTier.get("syntax")?.length ?? 0) + (plan.byTier.get("fast")?.length ?? 0) === 0) return;
      const hooks = makeHooks(ctx, st.abort.signal, { interactive: false });
      setStatus(ctx, "⏳ fast check…");
      const verdict = await runGate(plan, st.config, hooks);
      recordDiag(verdict);
      debug("perturn", { seq: st.prompt.seq, turn: event.turnIndex, files: Array.from(files).sort(), bash, status: verdict.status, ms: verdict.durationMs, runs: verdict.runs.map((r) => ({ id: r.check.id, status: r.status, code: r.exitCode })) });
      reportEnvFailures(ctx, verdict);
      if (verdict.status !== "red") {
        setStatus(ctx, statusText(verdict));
        return;
      }
      const failingLabels = uniq(verdict.runs.filter((r) => r.status === "fail").map((r) => r.check.label)).join(", ");
      setStatus(ctx, `✗ ${failingLabels} (mid-task)`);
      const drafts = supersedeDrafts(ctx, ["perturn"]);
      drafts.push({ type: "custom_message", customType: VERIFY_MSG, content: perTurnMessage(verdict), display: true, details: { seq: st.prompt.seq, kind: "perturn", headline: `${failingLabels} failing after this turn (fast check, informational)` } });
      // Never `continue` here: the agent is still working and gets the note with its next model request.
      return { entries: [...event.entries, ...drafts] };
    } catch (err) {
      notify(ctx, `verify: per-turn check error — ${(err as Error).message}`, "warning");
      return;
    } finally {
      st.gateRunning = false;
    }
  });

  // ------------------------------------------------------------------ manual verification (command + tool)
  async function manualVerify(ctx: ExtensionContext, opts: { tiers?: Tier[]; files?: string[]; interactive: boolean; baseline: boolean }): Promise<GateVerdict | undefined> {
    if (!s || !s.stored) return undefined;
    const st = s;
    if (st.gateRunning) {
      notify(ctx, "verify: a verification run is already in progress", "warning");
      return undefined;
    }
    st.gateRunning = true;
    try {
      const files = (opts.files ?? []).map((f) => (isAbsolute(f) ? f : join(ctx.cwd, f))).map(realpath);
      let plan = await buildGatePlan(files, { unscoped: files.length === 0 });
      const planned = () => TIER_ORDER.reduce((n, t) => n + (plan.byTier.get(t)?.length ?? 0), 0);
      // An umbrella root (no manifest) has nothing to run itself: one nested project is unambiguous, so run that one.
      const nested = st.stored?.detected.monorepo?.dirs ?? [];
      if (files.length === 0 && planned() === 0 && nested.length === 1) plan = await buildGatePlan([], { unscoped: true, roots: [join(st.root, nested[0]!)] });
      if (opts.tiers) for (const t of TIER_ORDER) if (!opts.tiers.includes(t)) plan.byTier.set(t, []);
      await stopBaselines();
      const hooks = makeHooks(ctx, st.abort.signal, { interactive: opts.interactive, baseline: opts.baseline });
      hooks.stopOnRed = false;
      setStatus(ctx, "⏳ verifying…");
      const verdict = await runGate(plan, st.config, hooks);
      recordDiag(verdict);
      st.lastVerdict = verdictLine(verdict);
      reportEnvFailures(ctx, verdict);
      setStatus(ctx, statusText(verdict));
      return verdict;
    } finally {
      st.gateRunning = false;
    }
  }

  function verdictReport(verdict: GateVerdict): string {
    const out: string[] = [];
    for (const r of verdict.runs) {
      const icon = r.status === "pass" ? "✓" : r.status === "fail" ? "✗" : r.status === "env" ? "⚠" : r.status === "preexisting" ? "≈" : "–";
      out.push(`${icon} **${r.check.label}** \`${r.check.cmd.replace(" <files>", "")}\` — ${r.status}${r.reason ? ` (${r.reason})` : ""} · ${(r.durationMs / 1000).toFixed(1)}s${r.check.cwd !== s!.root ? ` · ${displayPath(s!.root, r.check.cwd)}` : ""}`);
      if (r.summary.length) out.push("```\n" + r.summary.join("\n") + "\n```" + (r.logPath ? `\n(full log: ${r.logPath})` : ""));
    }
    if (verdict.runs.length === 0) out.push(noChecksNote());
    return out.join("\n");
  }

  /** Why an unscoped run had nothing to do, and what would: name the nested projects of an umbrella root. */
  function noChecksNote(): string {
    const dirs = s!.stored?.detected.monorepo?.dirs ?? [];
    if (dirs.length > 1) return `(no checks at ${basename(s!.root)} itself; nested projects: ${dirs.join(", ")} \u2014 pass files inside one of them, or run from inside it)`;
    return "(no applicable checks)";
  }

  pi.registerCommand("verify", {
    description: "Run the project's checks now: /verify [fast|lint|test|build|all] [file…]",
    getArgumentCompletions: (prefix) => ["fast", "lint", "test", "build", "all", "cancel"].filter((x) => x.startsWith(prefix)).map((x) => ({ value: x, label: x })),
    handler: async (args, ctx) => {
      if (!s) return;
      const parts = args.trim().split(/\s+/).filter(Boolean);
      if (parts[0] === "cancel") {
        s.abort.abort();
        s.abort = new AbortController();
        notify(ctx, "verify: cancelled", "info");
        return;
      }
      let tiers: Tier[] | undefined;
      if (parts[0] && ["fast", "lint", "test", "build"].includes(parts[0])) tiers = ["syntax", parts.shift() as Tier];
      else if (parts[0] === "all") {
        parts.shift();
        tiers = undefined;
      } else if (!parts[0]) tiers = ["syntax", "fast", "lint"];
      const files = parts;
      const verdict = await manualVerify(ctx, { tiers, files, interactive: true, baseline: false });
      if (!verdict) return;
      const md = `## /verify — ${verdict.status} (${(verdict.durationMs / 1000).toFixed(1)}s)\n\n${verdictReport(verdict)}`;
      showReport(md);
      if (verdict.status === "red") {
        // make the failure visible to the model on its next turn without triggering one
        pi.sendMessage({ customType: VERIFY_MSG, content: `[verification] manual /verify found failures:\n${verdictReport(verdict)}`, display: false, details: { seq: -1, kind: "failure", headline: "manual /verify failed" } }, { triggerTurn: false });
      }
    },
  });

  const RUN_CHECKS_OUTPUT = Type.Object({
    status: Type.Union([Type.Literal("green"), Type.Literal("red"), Type.Literal("env"), Type.Literal("skipped")]),
    runs: Type.Array(
      Type.Object({
        id: Type.String(),
        label: Type.String(),
        status: Type.Union([Type.Literal("pass"), Type.Literal("fail"), Type.Literal("env"), Type.Literal("skipped"), Type.Literal("preexisting")]),
        exitCode: Type.Union([Type.Number(), Type.Null()]),
        durationMs: Type.Number(),
        summary: Type.Array(Type.String(), { description: "Pruned diagnostic lines of a failing run." }),
      }),
    ),
  });
  pi.registerTool({
    name: "run_checks",
    label: "Run project checks",
    // runs the project's own commands, which may write caches or build output, so not read-only; repeating it changes nothing further
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    outputSchema: RUN_CHECKS_OUTPUT,
    description: "Run this project's own verification checks (typecheck/lint automatically; tests/build only if the user has allowed them for this repo). Returns pruned diagnostics. Use it after substantial changes instead of guessing commands.",
    promptSnippet: "Run the project's typecheck/lint/tests and get pruned diagnostics",
    promptGuidelines: ["Prefer run_checks over ad-hoc test/lint commands when you want to verify your changes; it knows the project's tooling."],
    parameters: Type.Object({
      tier: Type.Optional(Type.Union([Type.Literal("fast"), Type.Literal("lint"), Type.Literal("test"), Type.Literal("build"), Type.Literal("all")], { description: "Which tier to run. Default: fast+lint. 'all' includes tests/build when permitted." })),
      files: Type.Optional(Type.Array(Type.String(), { description: "Limit per-file checks to these paths (relative to cwd). Omit to run project-wide." })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const tiers: Tier[] | undefined = params.tier === "all" ? undefined : params.tier ? ["syntax", params.tier] : ["syntax", "fast", "lint"];
      const verdict = await manualVerify(ctx, { tiers, files: params.files, interactive: true, baseline: true });
      if (!verdict) return { content: [{ type: "text", text: "verification unavailable (no profile or a run is already in progress)" }], details: undefined, isError: true };
      const text = `verification: ${verdict.status} (${(verdict.durationMs / 1000).toFixed(1)}s)\n${verdictReport(verdict).replace(/\*\*/g, "")}`;
      const data = { status: verdict.status, runs: verdict.runs.map((r) => ({ id: r.check.id, label: r.check.label, status: r.status, exitCode: r.exitCode, durationMs: r.durationMs, summary: r.summary })) };
      return { content: [{ type: "text", text }], structuredContent: data, details: data };
    },
  });

  // ------------------------------------------------------------------ /profile
  const SUBS = ["show", "refresh", "doctor", "set", "note", "notes", "tests", "build", "verify", "forget", "config", "path", "help"];
  pi.registerCommand("profile", {
    description: "Project profile: /profile [show|refresh|doctor|set <key> <cmd|->|note <text>|notes clear|tests allow|deny|ask|build allow|deny|ask|verify on|off|forget|config|path]",
    getArgumentCompletions: (prefix) => SUBS.filter((x) => x.startsWith(prefix)).map((x) => ({ value: x, label: x })),
    handler: async (args, ctx) => {
      if (!s) return;
      const st = s;
      const [sub = "show", ...rest] = args.trim().split(/\s+/).filter(Boolean);
      const restStr = args.trim().slice(args.trim().indexOf(sub) + sub.length).trim();
      const requireStored = () => {
        if (!st.stored) {
          notify(ctx, "project-profile: no profile for this directory", "warning");
          return undefined;
        }
        return st.stored;
      };
      switch (sub) {
        case "show": {
          const stored = requireStored();
          if (!stored) return;
          showReport(renderReport(stored, st.config, { verifyEnabled: verifyEnabled(), cachePath: profilePath(dir, st.root), brokenChecks: st.broken, lastVerdict: st.lastVerdict }));
          return;
        }
        case "doctor": {
          const stored = requireStored();
          if (!stored) return;
          showReport(doctorReport(stored, effectiveChecks(stored), st.broken));
          return;
        }
        case "refresh": {
          const { stored } = loadOrDetect(dir, st.root, st.config, st.gitRoot, true);
          st.stored = stored;
          st.profiles.clear();
          st.broken.clear();
          st.notifiedBroken.clear();
          invalidateSection();
          notify(ctx, `project-profile: re-detected (${stored.detected.languages.join("/") || "unknown"}, ${effectiveChecks(stored).length} checks)`, "info");
          showReport(renderReport(stored, st.config, { verifyEnabled: verifyEnabled(), cachePath: profilePath(dir, st.root), brokenChecks: st.broken }));
          return;
        }
        case "set": {
          const stored = requireStored();
          if (!stored) return;
          const key = rest[0];
          const cmd = restStr.slice(key?.length ?? 0).trim();
          if (!key || !cmd) {
            notify(ctx, "usage: /profile set <typecheck|lint|format|test|build|dev|…> <command>   (use - to disable)", "warning");
            return;
          }
          updateUser(dir, stored, (u) => {
            if (cmd === "-") u.overrides[key] = null;
            else u.overrides[key] = cmd;
          });
          invalidateSection();
          notify(ctx, cmd === "-" ? `project-profile: ${key} disabled for this repo` : `project-profile: ${key} = \`${cmd}\` (runs via sh -c from ${tildify(st.root)})`, "info");
          return;
        }
        case "note": {
          const stored = requireStored();
          if (!stored) return;
          if (!restStr) {
            notify(ctx, "usage: /profile note <text>", "warning");
            return;
          }
          updateUser(dir, stored, (u) => {
            u.notes.push(restStr);
          });
          invalidateSection();
          notify(ctx, `project-profile: note saved (${stored.user.notes.length} total)`, "info");
          return;
        }
        case "notes": {
          const stored = requireStored();
          if (!stored) return;
          if (rest[0] === "clear") {
            updateUser(dir, stored, (u) => {
              u.notes = [];
            });
            invalidateSection();
            notify(ctx, "project-profile: notes cleared", "info");
          } else notify(ctx, stored.user.notes.length ? stored.user.notes.map((n, i) => `${i + 1}. ${n}`).join("\n") : "no notes", "info");
          return;
        }
        case "tests":
        case "build": {
          const stored = requireStored();
          if (!stored) return;
          const v = rest[0];
          if (!v || !["allow", "deny", "ask"].includes(v)) {
            notify(ctx, `usage: /profile ${sub} allow|deny|ask`, "warning");
            return;
          }
          updateUser(dir, stored, (u) => {
            if (v === "ask") delete u.permissions[sub];
            else u.permissions[sub] = v as "allow" | "deny";
          });
          st.askedThisSession.delete(sub === "tests" ? "test" : "build");
          invalidateSection();
          notify(ctx, `project-profile: ${sub} → ${v}`, "info");
          return;
        }
        case "verify": {
          const stored = requireStored();
          if (!stored) return;
          const v = rest[0];
          if (!v || !["on", "off", "default"].includes(v)) {
            notify(ctx, `verify is ${verifyEnabled() ? "on" : "off"} — usage: /profile verify on|off|default`, "info");
            return;
          }
          updateUser(dir, stored, (u) => {
            if (v === "default") delete u.verify;
            else u.verify = v === "on";
          });
          invalidateSection();
          notify(ctx, `project-profile: verify ${v} for this repo`, "info");
          return;
        }
        case "forget": {
          const ok = deleteStored(dir, st.root);
          st.stored = undefined;
          const { stored } = loadOrDetect(dir, st.root, st.config, st.gitRoot, true);
          st.stored = stored;
          invalidateSection();
          notify(ctx, ok ? "project-profile: cache and user data removed; re-detected fresh" : "project-profile: nothing cached; re-detected", "info");
          return;
        }
        case "config": {
          const p = configPath(dir);
          try {
            const { issues } = loadConfig(dir);
            const present = exists(p);
            const created = present ? p : writeDefaultConfig(dir);
            notify(ctx, `${present ? "config" : "created default config"}: ${tildify(created)}${issues.length ? ` — issues: ${issues.join("; ")}` : ""}`, "info");
          } catch (err) {
            notify(ctx, `project-profile: ${(err as Error).message}`, "error");
          }
          return;
        }
        case "path": {
          notify(ctx, `root ${tildify(st.root)}${st.gitRoot ? ` · git ${tildify(st.gitRoot)}` : ""} · cache ${tildify(profilePath(dir, st.root))} · config ${tildify(configPath(dir))}`, "info");
          return;
        }
        default:
          notify(ctx, "usage: /profile [show|refresh|doctor|set <key> <cmd|->|note <text>|notes clear|tests allow|deny|ask|build allow|deny|ask|verify on|off|forget|config|path]", "info");
      }
    },
  });
}
