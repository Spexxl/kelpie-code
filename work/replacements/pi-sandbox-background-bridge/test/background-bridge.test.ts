import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import extension from "../src/extension.ts";

// Benign bridge controls: inspect launch metadata, then run only protected printf.
test("bridge defers startup metadata and preserves runtime credential policy", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-bg-bridge-"));
  const agentDir = join(root, "agent"), cwd = join(root, "project");
  mkdirSync(agentDir); mkdirSync(cwd);
  const oldDir = process.env.PI_CODING_AGENT_DIR, oldMask = process.env.BASH_ENV;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.BASH_ENV = "fixture-host-credential";
  writeFileSync(join(agentDir, "sandbox.json"), JSON.stringify({ enabled: true,
    network: { disabled: true }, filesystem: { denyRead: [], allowWrite: [cwd], denyWrite: [] },
    credentials: { envVars: [{ name: "NODE_OPTIONS", mode: "deny" }, { name: "BASH_ENV", mode: "mask" }] },
  }));
  const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => Promise<unknown>>();
  const eventHandlers = new Map<string, (data: unknown) => void>();
  const api = { events: { on: (name: string, fn: (data: unknown) => void) => eventHandlers.set(name, fn) },
    on: (name: string, fn: (event: unknown, ctx: ExtensionContext) => Promise<unknown>) => handlers.set(name, fn),
    registerTool() {}, registerFlag() {}, registerCommand() {}, registerShortcut() {}, getFlag: () => false,
  } as unknown as ExtensionAPI;
  const errors: string[] = [];
  const ctx = { cwd, hasUI: false, isProjectTrusted: () => true,
    ui: { notify(message: string, kind: string) { if (kind === "error") errors.push(message); }, setStatus() {}, theme: { fg: (_: string, s: string) => s } },
  } as unknown as ExtensionContext;
  extension(api);
  const service = () => {
    let value: any;
    eventHandlers.get("pi-sandbox:background-service:v1")!({ provide: (candidate: unknown) => { value = candidate; } });
    return value;
  };
  try {
    await handlers.get("session_start")!({}, ctx);
    assert.deepEqual(errors, []);
    const prepared = await service().prepare({ argv: ["/bin/bash", "-c", 'printf "%s|%s|%s" "$FIXTURE_VALUE" "$NODE_OPTIONS" "$BASH_ENV"'],
      env: { FIXTURE_VALUE: "ordinary value", NODE_OPTIONS: "fixture override", BASH_ENV: "fixture override", "BASH_FUNC_metadata%%": "benign metadata" }, denyWrite: [], remote: false });
    assert.equal(prepared.launchEnv["BASH_FUNC_metadata%%"], undefined);
    assert.equal(prepared.launchEnv.BASH_ENV, undefined);
    assert.equal(prepared.launchEnv.NODE_OPTIONS, undefined);
    assert(prepared.argv.at(-1).includes("BASH_FUNC_metadata%%=benign metadata"));
    assert(!prepared.argv.at(-1).includes("BASH_ENV=fixture override"));
    assert(!prepared.argv.at(-1).includes("NODE_OPTIONS=fixture override"));
    assert(prepared.notice.includes("Credential overrides omitted"));
    const ran = spawnSync(prepared.argv[0], prepared.argv.slice(1), { cwd, env: prepared.launchEnv, encoding: "utf8" });
    assert.equal(ran.status, 0, ran.stderr);
    assert(ran.stdout.startsWith("ordinary value||"), ran.stdout);
    assert(!ran.stdout.includes("fixture-host-credential"), ran.stdout);
    assert(!ran.stdout.includes("fixture override"), ran.stdout);
    await handlers.get("session_shutdown")!({}, ctx);
    await assert.rejects(service().prepare({ argv: ["/bin/printf", "benign"], denyWrite: [], remote: false }), /closed/);
    // Defensive service lifecycle control; does not assert that installed /new reuses this closure.
    await handlers.get("session_start")!({}, ctx);
    assert.deepEqual(errors, []);
    assert.equal((await service().prepare({ argv: ["/bin/printf", "benign"], denyWrite: [], remote: false })).confined, true);
  } finally {
    await handlers.get("session_shutdown")!({}, ctx);
    if (oldDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = oldDir;
    if (oldMask === undefined) delete process.env.BASH_ENV; else process.env.BASH_ENV = oldMask;
    rmSync(root, { recursive: true, force: true });
  }
});
