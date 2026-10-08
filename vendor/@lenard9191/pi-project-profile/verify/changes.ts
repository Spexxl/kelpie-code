/**
 * Which files did the agent change since the last verification?
 *
 * Two sources, unioned:
 *  1. write/edit tool calls (exact, cheap)
 *  2. a git working-tree snapshot diff (catches `sed -i`, scripts, custom edit
 *     tools, generated files)
 */
import { spawn } from "node:child_process";
import { realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export type Snapshot = Map<string, string>; // repo-relative path → "status|mtime:size"

export interface ChangeTracker {
  gitRoot?: string;
  tracked: Set<string>; // absolute paths from tools
  bashRan: boolean;
  snapshot?: Snapshot;
}

export function newTracker(gitRoot: string | undefined): ChangeTracker {
  return { gitRoot, tracked: new Set(), bashRan: false };
}

/** Physical path (symlinks resolved; a file that does not exist yet resolves through its directory), so it compares with the realpath'd project root. */
export function physicalPath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    try {
      return join(realpathSync(dirname(p)), basename(p));
    } catch {
      return p;
    }
  }
}

/** Absolute physical path for a tool's path argument, or undefined when it is not a usable string. */
export function toolPath(cwd: string, path: unknown): string | undefined {
  if (typeof path !== "string" || !path) return undefined;
  return physicalPath(isAbsolute(path) ? resolve(path) : resolve(cwd, path));
}

function gitStatus(gitRoot: string, signal?: AbortSignal): Promise<Snapshot | undefined> {
  return new Promise((resolvePromise) => {
    let out = "";
    let proc;
    try {
      proc = spawn("git", ["-c", "core.quotepath=off", "status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames"], { cwd: gitRoot, stdio: ["ignore", "pipe", "ignore"], signal });
    } catch {
      resolvePromise(undefined);
      return;
    }
    const timer = setTimeout(() => {
      try {
        proc.kill("SIGKILL");
      } catch {
        /* ignore */
      }
      resolvePromise(undefined);
    }, 20_000);
    proc.stdout.on("data", (d: Buffer) => {
      out += d.toString("utf8");
      if (out.length > 64 * 1024 * 1024) {
        try {
          proc.kill("SIGKILL");
        } catch {
          /* ignore */
        }
      }
    });
    proc.on("error", () => {
      clearTimeout(timer);
      resolvePromise(undefined);
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        resolvePromise(undefined);
        return;
      }
      const snap: Snapshot = new Map();
      const entries = out.split("\0").filter(Boolean);
      if (entries.length > 20_000) {
        // Absurdly dirty tree (unignored build output?) — snapshotting would be too slow to be useful.
        resolvePromise(undefined);
        return;
      }
      for (const e of entries) {
        const status = e.slice(0, 2);
        const rel = e.slice(3);
        if (!rel) continue;
        let stamp = "-";
        try {
          const st = statSync(join(gitRoot, rel));
          stamp = `${Math.floor(st.mtimeMs)}:${st.size}`;
        } catch {
          /* deleted */
        }
        snap.set(rel, `${status}|${stamp}`);
      }
      resolvePromise(snap);
    });
  });
}

/** Take the "before" snapshot at the start of an agent run. */
export async function snapshotStart(t: ChangeTracker): Promise<void> {
  t.tracked.clear();
  t.bashRan = false;
  t.snapshot = t.gitRoot ? await gitStatus(t.gitRoot) : undefined;
}

/** Paths (absolute) whose git status/stamp differs between two snapshots. */
function diffSnapshots(gitRoot: string, before: Snapshot, now: Snapshot): string[] {
  const out: string[] = [];
  for (const [rel, v] of now) if (before.get(rel) !== v) out.push(join(gitRoot, rel));
  for (const rel of before.keys()) if (!now.has(rel)) out.push(join(gitRoot, rel)); // reverted or deleted
  return out;
}

/** Files changed since the prompt-start snapshot, without touching the tracker (per-turn checks). */
export async function peekChanges(t: ChangeTracker): Promise<string[] | undefined> {
  if (!t.gitRoot || !t.snapshot) return undefined;
  const now = await gitStatus(t.gitRoot);
  return now ? diffSnapshots(t.gitRoot, t.snapshot, now).sort() : undefined;
}

/** Compute changed files (absolute) since the snapshot; also refreshes the snapshot. */
export async function collectChanges(t: ChangeTracker): Promise<{ files: string[]; gitDetected: number; unknownChanges: boolean }> {
  const files = new Set<string>(t.tracked);
  let gitDetected = 0;
  let unknownChanges = false;
  if (t.gitRoot) {
    const now = await gitStatus(t.gitRoot);
    if (now && t.snapshot) {
      for (const f of diffSnapshots(t.gitRoot, t.snapshot, now)) {
        files.add(f);
        gitDetected++;
      }
      t.snapshot = now;
    } else if (!now || !t.snapshot) {
      // git unavailable/too slow: rely on tool tracking; if bash ran we cannot be sure
      unknownChanges = t.bashRan;
      if (now) t.snapshot = now;
    }
  } else {
    unknownChanges = t.bashRan;
  }
  t.tracked.clear();
  t.bashRan = false;
  return { files: Array.from(files).sort(), gitDetected, unknownChanges };
}

/** Repo-relative display path. */
export function displayPath(base: string, file: string): string {
  const r = relative(base, file);
  return r.startsWith("..") ? file : r.split(sep).join("/");
}
