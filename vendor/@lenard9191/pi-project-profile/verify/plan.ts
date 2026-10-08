import { basename, isAbsolute, relative, sep } from "node:path";
import { nearestProjectDir } from "../detect/index.ts";
import { ext } from "../fs-utils.ts";
import type { Check, StoredProfile, Tier } from "../types.ts";

export const TIER_ORDER: Tier[] = ["syntax", "fast", "lint", "test", "build"];

/** Changes to these are never worth a check run on their own. */
const DOC_EXTS = new Set([".md", ".mdx", ".txt", ".rst", ".adoc", ".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp", ".ico", ".pdf", ".woff", ".woff2", ".ttf", ".eot", ".mp3", ".mp4", ".lock", ".log", ".csv", ".snap", ".map"]);
const LOCKFILES = new Set(["package-lock.json", "pnpm-lock.yaml", "yarn.lock", "bun.lock", "bun.lockb", "Cargo.lock", "go.sum", "poetry.lock", "uv.lock", "pdm.lock", "Pipfile.lock", "Gemfile.lock", "composer.lock", "mix.lock", "pubspec.lock", "Package.resolved", "flake.lock"]);

export interface PlannedCheck {
  check: Check;
  /** Files relevant to this check, relative to check.cwd (empty unless the check appends files or can be scoped to them). */
  files: string[];
}

export interface Plan {
  byTier: Map<Tier, PlannedCheck[]>;
  relevantFiles: string[];
  ignoredFiles: string[];
}

export function isIgnoredPath(file: string, ignoreDirs: string[]): boolean {
  const parts = file.split(sep);
  return parts.some((p) => ignoreDirs.includes(p));
}

export function isDocOnly(file: string): boolean {
  const e = ext(file);
  const base = basename(file);
  if (LOCKFILES.has(base)) return true;
  if (DOC_EXTS.has(e)) return true;
  return false;
}

/**
 * Build the check plan for a set of changed files.
 * `profileFor(dir)` resolves the profile for the nearest project dir of each file (memoised by caller).
 */
export function buildPlan(
  changed: string[],
  opts: {
    projectRoot: string;
    gitRoot?: string;
    ignoreDirs: string[];
    profileFor: (dir: string) => StoredProfile | undefined;
    checksFor: (stored: StoredProfile) => Check[];
    /** Checks that must run regardless of which files changed (previous failures), with their file lists. */
    mustRun?: PlannedCheck[];
    /** Run everything unscoped (manual /verify). */
    unscoped?: boolean;
    /** Project dirs an unscoped run covers (default: the project root). */
    roots?: string[];
  },
): Plan {
  const byTier = new Map<Tier, PlannedCheck[]>();
  for (const t of TIER_ORDER) byTier.set(t, []);
  const relevant: string[] = [];
  const ignored: string[] = [];
  for (const f of changed) {
    if (isIgnoredPath(f, opts.ignoreDirs)) {
      ignored.push(f);
      continue;
    }
    relevant.push(f);
  }
  const stop = opts.gitRoot ?? opts.projectRoot;
  // group by project dir
  const groups = new Map<string, string[]>();
  if (opts.unscoped) for (const r of opts.roots ?? [opts.projectRoot]) groups.set(r, []);
  for (const f of relevant) {
    const dir = nearestProjectDir(f, stop);
    if (!groups.has(dir)) groups.set(dir, []);
    groups.get(dir)!.push(f);
  }
  const added = new Map<string, PlannedCheck>();
  const addPlanned = (check: Check, files: string[]) => {
    const key = `${check.cwd}::${check.id}`;
    const existing = added.get(key);
    if (existing) {
      for (const f of files) if (!existing.files.includes(f)) existing.files.push(f);
      return;
    }
    const planned = { check, files: [...files] };
    added.set(key, planned);
    byTier.get(check.tier)!.push(planned);
  };
  let groupCount = 0;
  for (const [dir, files] of groups) {
    if (groupCount++ >= 4) break; // bound work in giant monorepos
    const stored = opts.profileFor(dir);
    if (!stored) continue;
    const sourceFiles = files.filter((f) => !isDocOnly(f));
    for (const check of opts.checksFor(stored)) {
      const matching = check.exts && check.exts.length > 0 ? files.filter((f) => check.exts!.includes(ext(f))) : sourceFiles;
      if (!opts.unscoped && matching.length === 0) continue;
      if (!opts.unscoped && check.tier !== "syntax" && sourceFiles.length === 0 && !(check.exts ?? []).some((e) => e === ".json" || e === ".yml" || e === ".yaml")) continue;
      const rel = matching.map((f) => relative(check.cwd, f)).filter((r) => !r.startsWith("..") && !isAbsolute(r)).map((r) => r.split(sep).join("/"));
      if (check.appendFiles && rel.length === 0) {
        if (!opts.unscoped || !check.unscopedArgs) continue;
        addPlanned(check, [...check.unscopedArgs]);
        continue;
      }
      // Scoped checks (test tier) remember their files too; an unscoped run passes none so the full command runs.
      addPlanned(check, check.appendFiles || (check.scope && !opts.unscoped) ? rel : []);
    }
  }
  // Previously failing checks re-run regardless of which files changed (their file lists merge with fresh ones).
  const must = new Set<string>();
  for (const c of opts.mustRun ?? []) {
    addPlanned(c.check, c.files);
    must.add(`${c.check.cwd}::${c.check.id}`);
  }
  // A workspace-wide root run (turbo, pnpm -r, tsc -b, ...) already covers the packages below it:
  // drop fresh package-level runs of the same tier+label. Must-run entries are never dropped.
  for (const t of TIER_ORDER) {
    const list = byTier.get(t)!;
    const wide = list.filter((p) => p.check.coversWorkspace);
    if (wide.length === 0) continue;
    const covered = (p: PlannedCheck) => !p.check.coversWorkspace && !must.has(`${p.check.cwd}::${p.check.id}`) && wide.some((w) => w.check.label === p.check.label && p.check.cwd.startsWith(w.check.cwd + sep));
    for (const p of list.filter(covered)) added.delete(`${p.check.cwd}::${p.check.id}`);
    byTier.set(t, list.filter((p) => !covered(p)));
  }
  return { byTier, relevantFiles: relevant, ignoredFiles: ignored };
}
