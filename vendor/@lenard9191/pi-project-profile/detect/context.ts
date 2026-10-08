import { join } from "node:path";
import { exists, fileStamp, isDir, isFile, listDir, listDirs, listFiles, readJson, readText, which } from "../fs-utils.ts";
import type { Check, CommandInfo, DetectedProfile, Tier } from "../types.ts";

/** Order in which command keys are rendered. */
export const COMMAND_ORDER = [
  "install",
  "typecheck",
  "lint",
  "fix",
  "format",
  "test",
  "test:one",
  "e2e",
  "build",
  "generate",
  "dev",
  "run",
  "docs",
  "migrate",
  "clean",
];

export interface DetectOptions {
  /** Global config ignore list. */
  ignoreDirs: string[];
  /** Default timeouts per tier. */
  timeouts: Record<Tier, number>;
}

/**
 * Accumulates detector output for one project directory. Detectors add facts;
 * `finish()` sorts and dedupes so the result is deterministic.
 */
export class Builder {
  readonly root: string;
  readonly opts: DetectOptions;
  languages = new Set<string>();
  stack: string[] = [];
  runtimes: Record<string, string> = {};
  commands: Record<string, CommandInfo> = {};
  checks: Check[] = [];
  conventions: string[] = [];
  notes: string[] = [];
  services: string[] = [];
  monorepo?: { kind: string; packages?: number; tool?: string; dirs?: string[] };
  generated: string[] = [];
  /** Tracked-file extension histogram (git ls-files), set before detectors run. */
  extCounts: Record<string, number> = {};
  fingerprintFiles = new Set<string>();
  private textCache = new Map<string, string | undefined>();

  constructor(root: string, opts: DetectOptions) {
    this.root = root;
    this.opts = opts;
  }

  // ---- fs helpers (relative to root) ----
  path(rel: string): string {
    return join(this.root, rel);
  }
  has(rel: string): boolean {
    const ok = exists(this.path(rel));
    if (ok) this.fingerprintFiles.add(rel);
    return ok;
  }
  hasFile(rel: string): boolean {
    const ok = isFile(this.path(rel));
    if (ok) this.fingerprintFiles.add(rel);
    return ok;
  }
  hasDir(rel: string): boolean {
    return isDir(this.path(rel));
  }
  /** First existing file among candidates. */
  first(rels: string[]): string | undefined {
    return rels.find((r) => this.hasFile(r));
  }
  text(rel: string, maxBytes?: number): string | undefined {
    if (this.textCache.has(rel)) return this.textCache.get(rel);
    const t = readText(this.path(rel), maxBytes);
    if (t !== undefined) this.fingerprintFiles.add(rel);
    this.textCache.set(rel, t);
    return t;
  }
  json<T = any>(rel: string): T | undefined {
    const v = readJson<T>(this.path(rel));
    if (v !== undefined) this.fingerprintFiles.add(rel);
    return v;
  }
  ls(rel = "."): string[] {
    return listDir(this.path(rel));
  }
  dirs(rel = "."): string[] {
    return listDirs(this.path(rel));
  }
  files(rel = "."): string[] {
    return listFiles(this.path(rel));
  }
  /** Files at root matching a regex (top level only). */
  rootFiles(re: RegExp): string[] {
    return this.files().filter((f) => re.test(f));
  }
  which(bin: string): string | undefined {
    return which(bin);
  }

  // ---- facts ----
  lang(name: string): void {
    this.languages.add(name);
  }
  add(token: string | undefined): void {
    if (token && !this.stack.includes(token)) this.stack.push(token);
  }
  runtime(name: string, version: string | undefined): void {
    if (version && !this.runtimes[name]) this.runtimes[name] = version;
  }
  command(key: string, cmd: string, source: string): void {
    if (!this.commands[key]) this.commands[key] = { cmd, source };
  }
  convention(c: string): void {
    if (!this.conventions.includes(c)) this.conventions.push(c);
  }
  note(n: string): void {
    if (!this.notes.includes(n)) this.notes.push(n);
  }
  service(s: string): void {
    if (!this.services.includes(s)) this.services.push(s);
  }
  check(c: Omit<Check, "cwd"> & { cwd?: string }): void {
    if (this.checks.some((x) => x.id === c.id)) return;
    const timeoutMs = c.timeoutMs ?? this.opts.timeouts[c.tier];
    this.checks.push({ ...c, cwd: c.cwd ?? this.root, timeoutMs });
  }
  /** Is there already a project-level check for this tier+label? Incidental single-file-type linters do not count. */
  hasCheckFor(tier: Tier, label: string): boolean {
    return this.checks.some((c) => c.tier === tier && c.label === label && !c.incidental);
  }
  hasCheck(tierOrLabel: string): boolean {
    return this.checks.some((c) => c.tier === tierOrLabel || c.label === tierOrLabel);
  }

  finish(partial: Partial<DetectedProfile>): DetectedProfile {
    const fingerprint: Record<string, string> = {};
    for (const rel of Array.from(this.fingerprintFiles).sort()) fingerprint[rel] = fileStamp(this.path(rel));
    const commands: Record<string, CommandInfo> = {};
    const keys = Object.keys(this.commands).sort((a, b) => {
      const ia = COMMAND_ORDER.indexOf(a);
      const ib = COMMAND_ORDER.indexOf(b);
      return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib) || a.localeCompare(b);
    });
    for (const k of keys) commands[k] = this.commands[k]!;
    return {
      version: 0,
      root: this.root,
      languages: Array.from(this.languages),
      stack: this.stack,
      runtimes: this.runtimes,
      commands,
      checks: this.checks,
      instructionFiles: [],
      conventions: this.conventions,
      layout: [],
      services: this.services,
      notes: this.notes,
      monorepo: this.monorepo,
      generated: this.generated.length ? this.generated : undefined,
      fingerprint,
      ...partial,
    };
  }
}

/** Parse a `.tool-versions` file (asdf/mise) into name → version. */
export function parseToolVersions(text: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!text) return out;
  for (const line of text.split("\n")) {
    const m = line.trim().match(/^([A-Za-z0-9_.-]+)\s+(\S+)/);
    if (m && !line.trim().startsWith("#")) out[m[1]!] = m[2]!;
  }
  return out;
}

/** Very small TOML reader: top-level and [section] scalar keys only. Enough for Cargo/pyproject basics. */
export function tomlSections(text: string | undefined): Map<string, Record<string, string>> {
  const map = new Map<string, Record<string, string>>();
  if (!text) return map;
  let section = "";
  map.set(section, {});
  for (const raw of text.split("\n")) {
    const line = raw.replace(/#.*$/, "").trim();
    if (!line) continue;
    const sec = line.match(/^\[\[?([^\]]+)\]\]?$/);
    if (sec) {
      section = sec[1]!.trim();
      if (!map.has(section)) map.set(section, {});
      continue;
    }
    const kv = line.match(/^([A-Za-z0-9_."-]+)\s*=\s*(.+)$/);
    if (kv) {
      const key = kv[1]!.replace(/"/g, "");
      let val = kv[2]!.trim();
      if (/^".*"$/.test(val) || /^'.*'$/.test(val)) val = val.slice(1, -1);
      map.get(section)![key] = val;
    }
  }
  return map;
}

/** Keys of a TOML table (dependency names), e.g. tomlKeys(text, "dependencies"). */
export function tomlKeys(text: string | undefined, section: string): string[] {
  const s = tomlSections(text).get(section);
  return s ? Object.keys(s) : [];
}

/** Does the TOML contain a table header matching (e.g. "tool.ruff" also matches "tool.ruff.lint")? */
export function tomlHasTable(text: string | undefined, prefix: string): boolean {
  if (!text) return false;
  const re = new RegExp("^\\s*\\[\\[?" + prefix.replace(/\./g, "\\.") + "(\\.[^\\]]*)?\\]\\]?", "m");
  return re.test(text);
}

/** Extract `services:` names from a docker-compose file without a YAML parser. */
export function composeServices(text: string | undefined): string[] {
  if (!text) return [];
  const lines = text.split("\n");
  const out: string[] = [];
  let inServices = false;
  let indent = -1;
  for (const line of lines) {
    if (/^services:\s*(#.*)?$/.test(line)) {
      inServices = true;
      indent = -1;
      continue;
    }
    if (!inServices) continue;
    if (/^\S/.test(line) && line.trim() !== "") {
      break; // next top-level key
    }
    const m = line.match(/^(\s+)([A-Za-z0-9_.-]+):\s*(#.*)?$/);
    if (!m) continue;
    const ind = m[1]!.length;
    if (indent === -1) indent = ind;
    if (ind === indent) out.push(m[2]!);
  }
  return out;
}
