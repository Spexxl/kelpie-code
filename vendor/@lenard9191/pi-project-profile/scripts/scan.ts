/**
 * Dev CLI: print the detected profile for one or more directories.
 *
 *   node scripts/scan.ts <dir> [<dir>…] [--json] [--checks]
 */
import { resolve } from "node:path";
import { loadConfig } from "../config.ts";
import { detectProject, findProjectRoot } from "../detect/index.ts";
import { renderPromptSection } from "../profile/render.ts";
import { emptyUserData } from "../profile/store.ts";
import type { StoredProfile } from "../types.ts";

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith("--")));
const dirs = args.filter((a) => !a.startsWith("--"));
if (dirs.length === 0) {
  console.error("usage: scan.ts <dir>… [--json] [--checks]");
  process.exit(2);
}
const { config } = loadConfig();
for (const dir of dirs) {
  const started = Date.now();
  const { root, gitRoot } = findProjectRoot(resolve(dir));
  const detected = detectProject(root, config, gitRoot);
  const ms = Date.now() - started;
  const stored: StoredProfile = { detected, user: emptyUserData(), updatedAt: "" };
  if (flags.has("--json")) {
    console.log(JSON.stringify(detected, null, 2));
    continue;
  }
  console.log(`\n${"=".repeat(100)}\n# ${dir}  (root=${root}, ${ms}ms)\n${"=".repeat(100)}`);
  const section = renderPromptSection(stored, config, { verifyEnabled: true, piLoadedContextFiles: [] });
  console.log(section);
  console.log(`\n[~${Math.round(section.length / 4)} tokens]`);
  if (flags.has("--checks")) {
    console.log("\nChecks:");
    for (const c of detected.checks) console.log(`  ${c.tier.padEnd(6)} ${c.label.padEnd(10)} ${c.cmd.padEnd(60)} cwd=${c.cwd === root ? "." : c.cwd}  src=${c.source}${c.exts ? "  exts=" + c.exts.join(",") : ""}`);
  }
}
