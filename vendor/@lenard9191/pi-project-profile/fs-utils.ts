import { createHash } from "node:crypto";
import { accessSync, constants, existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export function exists(p: string): boolean {
  try {
    return existsSync(p);
  } catch {
    return false;
  }
}

export function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

export function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

export function readText(p: string, maxBytes = 512 * 1024): string | undefined {
  try {
    const st = statSync(p);
    if (!st.isFile()) return undefined;
    const buf = readFileSync(p);
    return buf.subarray(0, maxBytes).toString("utf8");
  } catch {
    return undefined;
  }
}

/** Strip // and /* comments and trailing commas (tsconfig-style JSONC). String-aware. */
export function stripJsonComments(input: string): string {
  let out = "";
  let i = 0;
  while (i < input.length) {
    const c = input[i];
    const n = input[i + 1] ?? "";
    if (c === '"') {
      out += c;
      i++;
      while (i < input.length && input[i] !== '"') {
        if (input[i] === "\\") {
          out += input[i];
          i++;
        }
        out += input[i] ?? "";
        i++;
      }
      out += input[i] ?? "";
      i++;
      continue;
    }
    if (c === "/" && n === "/") {
      while (i < input.length && input[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && n === "*") {
      i += 2;
      while (i < input.length && !(input[i] === "*" && input[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    out += c;
    i++;
  }
  return out.replace(/,(\s*[}\]])/g, "$1");
}

export function readJson<T = any>(p: string): T | undefined {
  const text = readText(p);
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text) as T;
  } catch {
    try {
      return JSON.parse(stripJsonComments(text)) as T;
    } catch {
      return undefined;
    }
  }
}

export function listDir(p: string): string[] {
  try {
    return readdirSync(p).sort();
  } catch {
    return [];
  }
}

export function listDirs(p: string): string[] {
  try {
    return readdirSync(p, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
  } catch {
    return [];
  }
}

export function listFiles(p: string): string[] {
  try {
    return readdirSync(p, { withFileTypes: true })
      .filter((d) => d.isFile())
      .map((d) => d.name)
      .sort();
  } catch {
    return [];
  }
}

/** "mtime:size" fingerprint of a file, or "-" when missing. */
export function fileStamp(p: string): string {
  try {
    const st = statSync(p);
    return `${Math.floor(st.mtimeMs)}:${st.size}`;
  } catch {
    return "-";
  }
}

export function sha1(s: string): string {
  return createHash("sha1").update(s).digest("hex");
}

export function sha1File(p: string): string | undefined {
  try {
    return createHash("sha1").update(readFileSync(p)).digest("hex");
  } catch {
    return undefined;
  }
}

const whichCache = new Map<string, string | undefined>();

export function isWindows(): boolean {
  return process.platform === "win32";
}

/** Candidate file names for an executable: the name itself, plus PATHEXT variants on Windows (`npm` → `npm.cmd`). */
export function executableCandidates(name: string): string[] {
  if (!isWindows()) return [name];
  const exts = (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean);
  const hasExt = exts.some((e) => name.toLowerCase().endsWith(e.toLowerCase()));
  return hasExt ? [name] : [...exts.map((e) => name + e.toLowerCase()), name];
}

/** Resolve an executable on PATH without spawning. Paths are checked directly (never cached: `vendor/bin/*` can appear mid-session). */
export function which(bin: string): string | undefined {
  if (!bin) return undefined;
  if (isAbsolute(bin) || bin.includes(sep) || bin.includes("/")) return executableCandidates(bin).find((c) => isExecutable(c));
  if (whichCache.has(bin)) return whichCache.get(bin);
  let found: string | undefined;
  const dirs = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
  outer: for (const dir of dirs) {
    for (const c of executableCandidates(bin)) {
      const candidate = join(dir, c);
      if (isExecutable(candidate)) {
        found = candidate;
        break outer;
      }
    }
  }
  whichCache.set(bin, found);
  return found;
}

export function clearWhichCache(): void {
  whichCache.clear();
}

export function isExecutable(p: string): boolean {
  try {
    accessSync(p, constants.X_OK);
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

export function realpath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

/** Walk from `start` upward, returning the first dir where predicate holds. */
export function findUp(start: string, predicate: (dir: string) => boolean, stopAt?: string): string | undefined {
  let dir = resolve(start);
  const stop = stopAt ? resolve(stopAt) : undefined;
  for (;;) {
    if (predicate(dir)) return dir;
    if (stop && dir === stop) return undefined;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

export function findGitRoot(start: string): string | undefined {
  return findUp(start, (d) => exists(join(d, ".git")));
}

/** Resolve `node_modules/.bin/<tool>` walking up from dir (stops at root or fs root). On Windows the `.cmd` shim wins over the extension-less shell script. */
export function findNodeBin(dir: string, tool: string, stopAt?: string): string | undefined {
  const names = executableCandidates(tool);
  let found: string | undefined;
  findUp(
    dir,
    (d) => {
      for (const n of names) {
        const p = join(d, "node_modules", ".bin", n);
        if (isExecutable(p)) {
          found = p;
          return true;
        }
      }
      return false;
    },
    stopAt,
  );
  return found;
}

export function hasNodeModules(dir: string, stopAt?: string): boolean {
  return !!findUp(dir, (d) => isDir(join(d, "node_modules")), stopAt);
}

export function tildify(p: string): string {
  const home = homedir();
  return p.startsWith(home + sep) || p === home ? "~" + p.slice(home.length) : p;
}

export function relTo(root: string, p: string): string {
  const r = relative(root, p);
  return r === "" ? "." : r.split(sep).join("/");
}

export function ext(p: string): string {
  const b = basename(p);
  const i = b.lastIndexOf(".");
  return i <= 0 ? "" : b.slice(i).toLowerCase();
}

// Minimal glob expansion for workspace patterns like "packages/*", "apps/**", "libs/*/pkg".
// Only `*` (single segment) and `**` (recursive, bounded depth) are supported. Returns dirs.
export function expandDirGlob(root: string, pattern: string, maxDepth = 4): string[] {
  const cleaned = pattern.replace(/^!\s*/, "").replace(/\/+$/, "");
  if (cleaned.startsWith("!")) return [];
  const segs = cleaned.split("/").filter((s) => s !== "" && s !== ".");
  const results: string[] = [];
  const walk = (dir: string, i: number, depth: number) => {
    if (results.length > 2000) return;
    if (i === segs.length) {
      if (isDir(dir)) results.push(dir);
      return;
    }
    const seg = segs[i]!;
    if (seg === "**") {
      walk(dir, i + 1, depth);
      if (depth >= maxDepth) return;
      for (const d of listDirs(dir)) {
        if (d.startsWith(".") || d === "node_modules") continue;
        walk(join(dir, d), i, depth + 1);
      }
      return;
    }
    if (seg.includes("*")) {
      const re = new RegExp("^" + seg.split("*").map(escapeRe).join(".*") + "$");
      for (const d of listDirs(dir)) {
        if (d.startsWith(".") || d === "node_modules") continue;
        if (re.test(d)) walk(join(dir, d), i + 1, depth + 1);
      }
      return;
    }
    walk(join(dir, seg), i + 1, depth + 1);
  };
  walk(root, 0, 0);
  return results.sort();
}

export function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function uniq<T>(arr: T[]): T[] {
  return Array.from(new Set(arr));
}

export function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "").replace(/\u001b\][^\u0007]*\u0007/g, "");
}

export function clampText(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + "…";
}
