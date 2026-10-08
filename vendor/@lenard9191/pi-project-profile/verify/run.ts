import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isWindows, stripAnsi } from "../fs-utils.ts";

export interface RunResult {
  code: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  spawnError?: string;
  durationMs: number;
  truncated: boolean;
}

export interface RunOptions {
  cwd: string;
  env?: Record<string, string>;
  timeoutMs: number;
  signal?: AbortSignal;
  /** Cap on captured bytes per stream (older output is dropped, tail kept). */
  maxBytes?: number;
}

/** Quote one argument for cmd.exe when a Windows shell is unavoidable (.cmd shims, `sh -c` strings). */
export function quoteForCmd(arg: string): string {
  if (arg === "") return '""';
  if (!/[\s"&|<>^%()]/.test(arg)) return arg;
  return `"${arg.replace(/"/g, '\\"')}"`;
}

/**
 * Windows has no `sh` and cannot spawn `.cmd`/`.bat` shims without a shell
 * (Node refuses since CVE-2024-27980). Translate the portable argv into
 * something cmd.exe can run; POSIX argv is returned unchanged.
 */
export function platformArgv(argv: string[], win = isWindows()): { file: string; args: string[]; shell: boolean } {
  const [head = "", ...rest] = argv;
  if (!win) return { file: head, args: rest, shell: false };
  if (head === "sh" && rest[0] === "-c" && typeof rest[1] === "string") return { file: rest[1], args: rest.slice(2).map(quoteForCmd), shell: true };
  if (/\.(cmd|bat)$/i.test(head)) return { file: quoteForCmd(head), args: rest.map(quoteForCmd), shell: true };
  return { file: head, args: rest, shell: false };
}

/**
 * Spawn a check in its own process group with a hard timeout. No TTY, no
 * stdin, colours disabled. On timeout/abort the whole group is killed
 * (POSIX); Windows has no process groups, so only the direct child is killed.
 */
export function runCommand(argv: string[], opts: RunOptions): Promise<RunResult> {
  const started = Date.now();
  const maxBytes = opts.maxBytes ?? 2 * 1024 * 1024;
  const win = isWindows();
  return new Promise((resolve) => {
    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      NO_COLOR: "1",
      FORCE_COLOR: "0",
      TERM: "dumb",
      CLICOLOR: "0",
      PY_COLORS: "0",
      CARGO_TERM_COLOR: "never",
      GIT_TERMINAL_PROMPT: "0",
      ...(opts.env ?? {}),
    };
    let proc;
    try {
      const { file, args, shell } = platformArgv(argv, win);
      proc = spawn(file, args, { cwd: opts.cwd, env, stdio: ["ignore", "pipe", "pipe"], detached: !win, shell, windowsHide: true });
    } catch (err) {
      resolve({ code: null, signal: null, stdout: "", stderr: "", timedOut: false, spawnError: (err as Error).message, durationMs: Date.now() - started, truncated: false });
      return;
    }
    let stdout = "";
    let stderr = "";
    let truncated = false;
    let timedOut = false;
    let done = false;
    const append = (cur: string, chunk: Buffer): string => {
      let next = cur + chunk.toString("utf8");
      if (next.length > maxBytes) {
        next = next.slice(next.length - maxBytes);
        truncated = true;
      }
      return next;
    };
    proc.stdout?.on("data", (d: Buffer) => (stdout = append(stdout, d)));
    proc.stderr?.on("data", (d: Buffer) => (stderr = append(stderr, d)));
    const killGroup = (sig: NodeJS.Signals) => {
      try {
        if (!win && proc.pid) process.kill(-proc.pid, sig);
        else proc.kill(sig);
      } catch {
        try {
          proc.kill(sig);
        } catch {
          /* already gone */
        }
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup("SIGTERM");
      setTimeout(() => killGroup("SIGKILL"), 4000).unref();
    }, opts.timeoutMs);
    const onAbort = () => {
      killGroup("SIGTERM");
      setTimeout(() => killGroup("SIGKILL"), 2000).unref();
    };
    if (opts.signal) {
      if (opts.signal.aborted) onAbort();
      else opts.signal.addEventListener("abort", onAbort, { once: true });
    }
    const finish = (code: number | null, signal: NodeJS.Signals | null, spawnError?: string) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      resolve({ code, signal, stdout: stripAnsi(stdout), stderr: stripAnsi(stderr), timedOut, spawnError, durationMs: Date.now() - started, truncated });
    };
    proc.on("error", (err) => finish(null, null, err.message));
    proc.on("close", (code, signal) => finish(code, signal));
  });
}

/** Where full logs go. Pruned at session start. */
export function logDir(): string {
  const d = join(tmpdir(), "pi-project-profile");
  mkdirSync(d, { recursive: true });
  return d;
}

export function writeLog(name: string, content: string): string {
  const p = join(logDir(), `${name}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.log`);
  writeFileSync(p, content);
  return p;
}

export function pruneLogs(maxAgeMs = 24 * 3600 * 1000, keep = 40): void {
  try {
    const d = logDir();
    const files = readdirSync(d)
      .map((f) => ({ f, p: join(d, f), m: statSync(join(d, f)).mtimeMs }))
      .sort((a, b) => b.m - a.m);
    const now = Date.now();
    files.forEach((x, i) => {
      if (i >= keep || now - x.m > maxAgeMs) {
        try {
          unlinkSync(x.p);
        } catch {
          /* ignore */
        }
      }
    });
  } catch {
    /* ignore */
  }
}

export function readLogTail(p: string, maxChars = 4000): string {
  try {
    const s = readFileSync(p, "utf8");
    return s.length > maxChars ? s.slice(-maxChars) : s;
  } catch {
    return "";
  }
}
