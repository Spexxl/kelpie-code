import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { stripJsonComments } from "./fs-utils.ts";
import type { ProfileConfig } from "./types.ts";
import { DEFAULT_CONFIG } from "./types.ts";

export function agentDir(): string {
  return process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
}

export function configPath(dir = agentDir()): string {
  return join(dir, "project-profile", "config.json");
}

export function loadConfig(dir = agentDir()): { config: ProfileConfig; issues: string[] } {
  const issues: string[] = [];
  let raw: string | undefined;
  try {
    raw = readFileSync(configPath(dir), "utf8");
  } catch {
    return { config: structuredClone(DEFAULT_CONFIG), issues };
  }
  let parsed: any;
  try {
    parsed = JSON.parse(stripJsonComments(raw));
  } catch (err) {
    issues.push(`config.json is not valid JSON (${(err as Error).message}); using defaults`);
    return { config: structuredClone(DEFAULT_CONFIG), issues };
  }
  const config = structuredClone(DEFAULT_CONFIG);
  const merge = (target: any, source: any, path: string) => {
    if (!source || typeof source !== "object") return;
    for (const [k, v] of Object.entries(source)) {
      if (!(k in target)) {
        issues.push(`unknown config key ${path}${k}`);
        continue;
      }
      const cur = target[k];
      if (Array.isArray(cur)) {
        if (Array.isArray(v)) target[k] = v.map(String);
        else issues.push(`${path}${k} should be an array`);
      } else if (cur && typeof cur === "object") {
        merge(cur, v, `${path}${k}.`);
      } else if (typeof cur === typeof v) {
        target[k] = v;
      } else issues.push(`${path}${k} should be a ${typeof cur}`);
    }
  };
  merge(config, parsed, "");
  return { config, issues };
}

export function writeDefaultConfig(dir = agentDir()): string {
  const p = configPath(dir);
  mkdirSync(join(dir, "project-profile"), { recursive: true });
  const body = `// project-profile configuration. Unknown keys are reported at session start.
// Per-repo data (command overrides, notes, test permission) lives in ./profiles/*.json — use /profile to edit.
${JSON.stringify(DEFAULT_CONFIG, null, 2)}
`;
  writeFileSync(p, body);
  return p;
}
