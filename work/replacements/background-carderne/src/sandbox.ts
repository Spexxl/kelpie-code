/** Live pi-sandbox bridge. No bridge or unusable runtime means no launch. */
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { commandExecution, validateCommandSpec } from "./process.js";
import { baseDir } from "./registry.js";
import type { CommandSpec } from "./types.js";

const CHANNEL = "pi-sandbox:background-service:v1";
interface Service {
  prepare(request: { argv: string[]; env?: Record<string, string>; denyWrite: string[]; remote: boolean }): Promise<{
    argv?: string[]; launchEnv?: NodeJS.ProcessEnv; confined: boolean; notice: string;
  }>;
}
export class ForegroundSandboxBlockedError extends Error {
  constructor(detail: string) {
    super(`Background task blocked: ${detail}`);
    this.name = "ForegroundSandboxBlockedError";
  }
}
// Discovery happens afresh for each launch, including each resumed watch check.
export function observeForegroundSandboxPolicy(_pi: unknown): void {}
export async function prepareBackgroundCommand(pi: unknown, spec: CommandSpec, remote = false): Promise<CommandSpec & { sandboxNotice: string }> {
  validateCommandSpec(spec);
  let service: Service | undefined;
  const events = (pi as { events?: { emit(channel: string, data: unknown): void } })?.events;
  events?.emit(CHANNEL, { provide(candidate: Service) { service = candidate; } });
  if (!service || typeof service.prepare !== "function") {
    throw new ForegroundSandboxBlockedError("the pi-sandbox runtime bridge is unavailable. Load the maintained pi-sandbox bridge before starting tasks.");
  }
  const { execPath, execArgs } = commandExecution(spec);
  const controlPlane = baseDir();
  mkdirSync(controlPlane, { recursive: true });
  try {
    const result = await service.prepare({ argv: [execPath, ...execArgs], env: spec.env,
      denyWrite: [controlPlane, fileURLToPath(new URL("../", import.meta.url))], remote });
    if (!result || typeof result.confined !== "boolean" || typeof result.notice !== "string") throw new Error("invalid runtime bridge response");
    if (!result.confined) return { ...spec, sandboxNotice: result.notice };
    if (!result.argv?.length || !result.launchEnv) throw new Error("runtime did not provide a confined launch");
    return { ...spec, shell: false, argv: result.argv, sandboxLaunchEnv: result.launchEnv, sandboxNotice: result.notice };
  } catch (error) {
    throw new ForegroundSandboxBlockedError(error instanceof Error ? error.message : String(error));
  }
}
