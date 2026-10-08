import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import extension from "../src/extension.ts";

test("bridge denies protected descendants even when explicitly granted write access", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-bg-protected-"));
  const agent = join(root, "agent"), cwd = join(root, "project"), protectedRoot = join(root, "control"), child = join(protectedRoot, "src");
  for (const dir of [agent, cwd, child]) mkdirSync(dir, { recursive: true });
  const sentinel = join(child, "sentinel.txt");
  writeFileSync(sentinel, "UNCHANGED");
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agent;
  writeFileSync(join(agent, "sandbox.json"), JSON.stringify({ enabled: true,
    network: { disabled: true }, filesystem: { denyRead: [], allowWrite: [cwd, child], denyWrite: [] } }));
  const handlers = new Map(), events = new Map();
  const errors: string[] = [];
  const pi: any = { on: (name: string, fn: unknown) => handlers.set(name, fn),
    events: { on: (name: string, fn: unknown) => events.set(name, fn) },
    registerFlag() {}, registerTool() {}, registerShortcut() {}, registerCommand() {}, getFlag: () => false };
  const ctx: any = { cwd, hasUI: false, isProjectTrusted: () => true,
    ui: { notify(message: string, type: string) { if (type === "error") errors.push(message); }, setStatus() {}, theme: { fg: (_: string, value: string) => value } } };
  extension(pi);
  try {
    await handlers.get("session_start")({}, ctx);
    assert.deepEqual(errors, []);
    let service: any;
    events.get("pi-sandbox:background-service:v1")({ provide: (value: unknown) => { service = value; } });
    const prepared = await service.prepare({ argv: ["/bin/sh", "-c", `printf MUTATED > '${sentinel}'`], remote: false, denyWrite: [protectedRoot] });
    const result = spawnSync(prepared.argv[0], prepared.argv.slice(1), { cwd, env: prepared.launchEnv, encoding: "utf8" });
    assert.equal(readFileSync(sentinel, "utf8"), "UNCHANGED", result.stderr);
    assert.notEqual(result.status, 0, result.stderr);
  } finally {
    await handlers.get("session_shutdown")({}, ctx);
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  }
});
