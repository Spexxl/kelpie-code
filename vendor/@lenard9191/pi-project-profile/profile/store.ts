import { mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DETECTOR_VERSION, detectProject } from "../detect/index.ts";
import { fileStamp, sha1 } from "../fs-utils.ts";
import type { DetectedProfile, ProfileConfig, StoredProfile, UserData } from "../types.ts";

export function profilesDir(agentDir: string): string {
  return join(agentDir, "project-profile", "profiles");
}

export function profilePath(agentDir: string, root: string): string {
  return join(profilesDir(agentDir), `${sha1(root).slice(0, 16)}.json`);
}

export function emptyUserData(): UserData {
  return { overrides: {}, notes: [], permissions: {} };
}

export function loadStored(agentDir: string, root: string): StoredProfile | undefined {
  try {
    const raw = readFileSync(profilePath(agentDir, root), "utf8");
    const parsed = JSON.parse(raw) as StoredProfile;
    if (!parsed || typeof parsed !== "object" || !parsed.detected) return undefined;
    parsed.user = { ...emptyUserData(), ...(parsed.user ?? {}) };
    return parsed;
  } catch {
    return undefined;
  }
}

export function saveStored(agentDir: string, stored: StoredProfile): void {
  const p = profilePath(agentDir, stored.detected.root);
  mkdirSync(profilesDir(agentDir), { recursive: true });
  const tmp = `${p}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(stored, null, 2));
  renameSync(tmp, p);
}

export function deleteStored(agentDir: string, root: string): boolean {
  try {
    unlinkSync(profilePath(agentDir, root));
    return true;
  } catch {
    return false;
  }
}

/** True when any fingerprinted file changed (mtime/size) since detection. */
export function isStale(detected: DetectedProfile, root: string): boolean {
  if (detected.version !== DETECTOR_VERSION) return true;
  if (detected.root !== root) return true;
  for (const [rel, stamp] of Object.entries(detected.fingerprint)) {
    if (fileStamp(join(root, rel)) !== stamp) return true;
  }
  return false;
}

/**
 * Load the profile for a root, re-detecting when the cache is missing or stale.
 * User data (overrides, notes, permissions) always survives re-detection.
 */
export function loadOrDetect(agentDir: string, root: string, config: ProfileConfig, gitRoot: string | undefined, force = false): { stored: StoredProfile; refreshed: boolean } {
  const existing = loadStored(agentDir, root);
  if (existing && !force && !isStale(existing.detected, root)) return { stored: existing, refreshed: false };
  const detected = detectProject(root, config, gitRoot);
  const stored: StoredProfile = { detected, user: existing?.user ?? emptyUserData(), updatedAt: new Date().toISOString() };
  try {
    saveStored(agentDir, stored);
  } catch {
    // cache dir not writable: still usable in-memory
  }
  return { stored, refreshed: true };
}

export function updateUser(agentDir: string, stored: StoredProfile, mutate: (u: UserData) => void): void {
  mutate(stored.user);
  stored.updatedAt = new Date().toISOString();
  saveStored(agentDir, stored);
}

/** Remove cached profiles for roots that no longer exist (best effort, cheap). */
export function pruneProfiles(agentDir: string, maxAgeDays = 120): void {
  try {
    const dir = profilesDir(agentDir);
    const cutoff = Date.now() - maxAgeDays * 86_400_000;
    for (const f of readdirSync(dir)) {
      const p = join(dir, f);
      try {
        if (statSync(p).mtimeMs < cutoff) unlinkSync(p);
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* ignore */
  }
}
