import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Only delay the external wrapper operation; use the real extension and config loader.
const managers: any[] = [];
const require = createRequire(new URL("../src/extension.ts", import.meta.url));
mock.module(require.resolve("@carderne/sandbox-runtime"), { exports: {
  createSandboxManager: () => {
    const manager: any = {
      initialize: async () => {}, updateConfig() {}, reset: async () => {},
      checkDependencies: () => ({ errors: [], warnings: [] }),
      wrapWithSandbox: async () => {
        manager.entered?.();
        if (manager.wait) await manager.wait;
        return "fixture-wrapper";
      },
    };
    managers.push(manager);
    return manager;
  },
} });
const { default: extension } = await import("../src/extension.ts");

for (const transition of ["disable-enable", "shutdown-start", "policy-reload"] as const) {
  test(`bridge rejects an old wrapper after ${transition}`, async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-bg-generation-"));
    const agent = join(root, "agent"), cwd = join(root, "project");
    mkdirSync(agent); mkdirSync(cwd);
    const previous = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agent;
    const config = { enabled: true, network: { disabled: true }, filesystem: { denyRead: [], allowWrite: [cwd], denyWrite: [] as string[] } };
    const save = () => writeFileSync(join(agent, "sandbox.json"), JSON.stringify(config));
    save();
    const handlers = new Map(), commands = new Map(), events = new Map();
    const pi: any = { on: (name: string, fn: unknown) => handlers.set(name, fn),
      events: { on: (name: string, fn: unknown) => events.set(name, fn) },
      registerFlag() {}, registerTool() {}, registerShortcut() {}, getFlag: () => false,
      registerCommand: (name: string, value: unknown) => commands.set(name, value) };
    const ctx: any = { cwd, isProjectTrusted: () => true, hasUI: false,
      ui: { notify() {}, setStatus() {}, theme: { fg: (_: string, value: string) => value } } };
    extension(pi);
    const manager = managers.at(-1);
    const service = () => { let result: any; events.get("pi-sandbox:background-service:v1")({ provide: (value: unknown) => { result = value; } }); return result; };
    try {
      await handlers.get("session_start")({}, ctx);
      let release!: () => void, entered!: () => void;
      const wrapped = new Promise<void>((resolve) => { entered = resolve; });
      manager.entered = entered;
      manager.wait = new Promise<void>((resolve) => { release = resolve; });
      const pending = service().prepare({ argv: ["/bin/printf", "benign"], remote: false, denyWrite: [] });
      await wrapped;
      if (transition === "disable-enable") await commands.get("sandbox-disable").handler("", ctx);
      else if (transition === "shutdown-start") await handlers.get("session_shutdown")({}, ctx);
      config.filesystem.denyWrite.push(join(cwd, "new-denial")); save();
      if (transition === "disable-enable") await commands.get("sandbox-enable").handler("", ctx);
      else if (transition === "shutdown-start") await handlers.get("session_start")({}, ctx);
      const rejection = assert.rejects(pending, /sandbox.*changed|stale|generation/i);
      release();
      await rejection;
      manager.wait = undefined;
      assert.equal((await service().prepare({ argv: ["/bin/printf", "benign"], remote: false, denyWrite: [] })).confined, true);
    } finally {
      await handlers.get("session_shutdown")({}, ctx);
      if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
      rmSync(root, { recursive: true, force: true });
    }
  });
}
