import { createSandboxManager } from "@carderne/sandbox-runtime";
import { type AgentToolResult, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  createBashToolDefinition,
  isToolCallEventType,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { Key } from "@earendil-works/pi-tui";
import { fileURLToPath } from "node:url";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { buildRuntimeConfig } from "./sandbox-runtime.ts";

import {
  addDomainToConfig,
  addReadPathToConfig,
  addWritePathToConfig,
  getConfigPaths,
  loadConfig,
} from "./config.ts";
import {
  canonicalizePath,
  domainIsAllowed,
  extractDomainsFromCommand,
  matchesPattern,
  resolveWritePermission,
} from "./policy.ts";
import {
  createSandboxedBashOps,
  extractBlockedWritePath,
  initializeSandbox,
  updateSandboxConfig,
  resolveAllowances,
  type SessionAllowances,
  supportsNodeEnvProxy,
} from "./sandbox-runtime.ts";
import {
  formatSandboxConfiguration,
  formatSandboxStatus,
  type PermissionPromptResult,
  promptDomainBlock,
  promptReadBlock,
  showPermissionPrompt,
  promptWriteBlock,
  warnIfAllDomainsAllowed,
  warnIfLinuxUnenforcedGlobs,
} from "./ui.ts";

export default function (pi: ExtensionAPI) {
  const sandboxManager = createSandboxManager();
  pi.registerFlag("no-sandbox", {
    description: "Disable OS-level sandboxing for bash commands",
    type: "boolean",
    default: false,
  });

  // localBash supplies the tool metadata (name, description, params) via the spread
  // below. Its execute method is always overridden, and each invocation rebuilds the
  // bash tool against the session cwd, so this cwd is never used to run commands.
  const localBash = createBashToolDefinition(process.cwd());

  let sandboxEnabled = false;
  let sandboxInitialized = false;
  let projectTrusted = false;
  let sessionCwd: string | undefined;
  let backgroundState = "initializing";
  let backgroundReason = "sandbox session has not initialized";
  let backgroundGeneration = 0;
  const shellQuote = (value: string) => `'${value.replace(/'/g, "'\\''")}'`;
  // A service is provided afresh; the closure reads live session state/config on use.
  pi.events?.on("pi-sandbox:background-service:v1", (data: unknown) => {
    const request = data as { provide?: (service: unknown) => void };
    request?.provide?.({
      async prepare(launch: { argv: string[]; env?: Record<string, string>; denyWrite: string[]; remote: boolean }) {
        if (backgroundState === "disabled") return { confined: false, notice: `Sandbox: UNCONFINED (${backgroundReason}).` };
        if (backgroundState !== "ready" || !sandboxEnabled || !sandboxInitialized || !sessionCwd) {
          throw new Error(`pi-sandbox is ${backgroundState}: ${backgroundReason}`);
        }
        const generation = backgroundGeneration;
        if (launch.remote) throw new Error("Structured SSH background tasks cannot inherit pi-sandbox remote filesystem protection. Use confined bash for SSH; remote protection is separate.");
        const config = loadConfig(sessionCwd, projectTrusted, { strict: true });
        if (config.enabled === false) throw new Error("pi-sandbox config changed to disabled; explicitly disable the session sandbox before launching unconfined tasks.");
        if (config.filesystem?.disabled) throw new Error("Background tasks require filesystem sandboxing to protect their task registry and extension sources. Enable filesystem protection or explicitly disable the session sandbox.");
        const current = buildRuntimeConfig(config, allowances, process.platform, sessionCwd);
        const policySnapshot = JSON.stringify(current);
        // Refresh live network/credential policy. Extra filesystem denials apply only to this job.
        sandboxManager.updateConfig(current);
        const { globalPath, projectPath } = getConfigPaths(sessionCwd);
        // Protect a directory, not an absent config file: Linux otherwise creates
        // an empty placeholder which the next load mistakes for malformed JSON.
        mkdirSync(dirname(projectPath), { recursive: true });
        const protectedPaths = [...launch.denyWrite, fileURLToPath(new URL("../", import.meta.url)), globalPath, dirname(projectPath)]
          .map((entry) => canonicalizePath(entry, sessionCwd));
        // Runtime 0.0.76 skips a parent denial when only a descendant is
        // write-granted. Deny those intersecting grants explicitly as well.
        const protectedGrants = (current.filesystem?.allowWrite ?? [])
          .map((entry) => canonicalizePath(entry, sessionCwd))
          .filter((grant) => protectedPaths.some((protectedPath) => grant === protectedPath || grant.startsWith(protectedPath.replace(/\/$/, "") + "/")));
        const perLaunch = { ...current, filesystem: { ...current.filesystem,
          denyWrite: [...new Set([...(current.filesystem?.denyWrite ?? []).map((entry) => canonicalizePath(entry, sessionCwd)), ...protectedPaths, ...protectedGrants])],
        } };
        // The runtime owns declared credential variables (deny, mask, and
        // extract-no-match handling). A job override must not replace its result.
        const credentialNames = new Set((current.credentials?.envVars ?? []).map((entry) => entry.name));
        const launchEnv: NodeJS.ProcessEnv = { ...process.env };
        const omittedCredentialOverrides: string[] = [];
        for (const [key, value] of Object.entries(launch.env ?? {})) {
          if (credentialNames.has(key)) omittedCredentialOverrides.push(key);
          else launchEnv[key] = value;
        }
        // User loader/startup variables must take effect only after OS confinement.
        const insideEnv: string[] = [];
        for (const key of Object.keys(launchEnv)) {
          if (/^(?:LD_|DYLD_|BASH_FUNC_)/.test(key) || ["BASH_ENV", "ENV", "SHELLOPTS", "BASHOPTS", "CDPATH", "GLOBIGNORE", "NODE_OPTIONS", "GCONV_PATH", "LOCPATH", "GLIBC_TUNABLES", "PATH"].includes(key)) {
            if (!credentialNames.has(key)) insideEnv.push(`${key}=${launchEnv[key]}`);
            delete launchEnv[key];
          }
        }
        launchEnv.PATH = "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";
        const command = `exec /usr/bin/env ${insideEnv.map(shellQuote).join(" ")} ${launch.argv.map(shellQuote).join(" ")}`;
        const wrapped = await sandboxManager.wrapWithSandbox(command, "/bin/bash", perLaunch);
        // A disable/shutdown that raced async wrapping must never publish a stale wrapper.
        if (generation !== backgroundGeneration || backgroundState !== "ready" || !sandboxEnabled || !sandboxInitialized || !sessionCwd) throw new Error("sandbox changed while preparing the background launch");
        const latestPolicy = buildRuntimeConfig(loadConfig(sessionCwd, projectTrusted, { strict: true }), allowances, process.platform, sessionCwd);
        if (JSON.stringify(latestPolicy) !== policySnapshot) throw new Error("sandbox policy changed while preparing the background launch; retry with the current policy");
        return { confined: true, argv: ["/bin/bash", "--noprofile", "--norc", "-c", wrapped], launchEnv,
          notice: "Sandbox: pi-sandbox OS filesystem/network/credential policy applied." +
            (omittedCredentialOverrides.length ? ` Credential overrides omitted under runtime policy: ${omittedCredentialOverrides.join(", ")}.` : ""),
        };
      },
    });
  });
  const allowances: SessionAllowances = { domains: [], readPaths: [], writePaths: [] };

  const effectiveAllowances = (cwd: string) =>
    resolveAllowances(loadConfig(cwd, projectTrusted), allowances);
  const effectiveDomains = (cwd: string) => effectiveAllowances(cwd).domains;
  const effectiveReadPaths = (cwd: string) => effectiveAllowances(cwd).readPaths;
  const effectiveWritePaths = (cwd: string) => effectiveAllowances(cwd).writePaths;

  async function refreshSandbox(cwd: string): Promise<void> {
    if (!sandboxInitialized) return;
    try {
      updateSandboxConfig(sandboxManager, loadConfig(cwd, projectTrusted), allowances, cwd);
    } catch (error) {
      console.error(`Warning: Failed to update sandbox configuration: ${error}`);
    }
  }

  async function applyChoice(
    choice: Exclude<PermissionPromptResult["action"], "abort">,
    kind: "domain" | "read" | "write",
    value: string,
    cwd: string,
  ): Promise<void> {
    const { globalPath, projectPath } = getConfigPaths(cwd);
    const target = choice === "project" ? projectPath : globalPath;

    try {
      if (kind === "domain") {
        if (!allowances.domains.includes(value)) allowances.domains.push(value);
        if (choice !== "session") addDomainToConfig(target, value);
      } else if (kind === "read") {
        if (!allowances.readPaths.includes(value)) allowances.readPaths.push(value);
        if (choice !== "session") addReadPathToConfig(target, value);
      } else {
        if (!allowances.writePaths.includes(value)) allowances.writePaths.push(value);
        if (choice !== "session") addWritePathToConfig(target, value);
      }
    } catch (error) {
      // The grant still applies for this session (allowances updated above);
      // only persistence failed. Surface it instead of wiping the config.
      console.error(`Warning: ${error instanceof Error ? error.message : error}`);
    }
    await refreshSandbox(cwd);
  }

  function updateStatus(
    ctx: Parameters<typeof warnIfAllDomainsAllowed>[0],
    config: ReturnType<typeof loadConfig>,
  ) {
    ctx.ui.setStatus("sandbox", ctx.ui.theme.fg("accent", formatSandboxStatus(config)));
  }

  async function enableSandbox(
    ctx: Parameters<typeof warnIfAllDomainsAllowed>[0],
    setProxyEnvironment: boolean,
  ): Promise<boolean> {
    if (sandboxEnabled) {
      ctx.ui.notify("Sandbox is already enabled", "info");
      return false;
    }
    const generation = ++backgroundGeneration;
    backgroundState = "initializing";
    backgroundReason = "runtime initialization in progress";

    const platform = process.platform;
    if (platform !== "darwin" && platform !== "linux") {
      ctx.ui.notify(`Sandbox not supported on ${platform}`, "warning");
      return false;
    }

    try {
      const config = loadConfig(ctx.cwd, projectTrusted, { strict: true });
      await initializeSandbox(sandboxManager, config, allowances, ctx.cwd);
      if (generation !== backgroundGeneration) return false;
      if (setProxyEnvironment && supportsNodeEnvProxy(process.versions.node)) {
        process.env.NODE_USE_ENV_PROXY ??= "1";
      }
      sandboxEnabled = true;
      sandboxInitialized = true;
      backgroundState = "ready";
      backgroundReason = "runtime initialized";
      warnIfAllDomainsAllowed(ctx, config);
      warnIfLinuxUnenforcedGlobs(ctx, config);
      updateStatus(ctx, config);
      return true;
    } catch (error) {
      if (generation !== backgroundGeneration) return false;
      sandboxEnabled = false;
      backgroundState = "failed";
      backgroundReason = error instanceof Error ? error.message : String(error);
      ctx.ui.notify(
        `Sandbox initialization failed: ${error instanceof Error ? error.message : error}`,
        "error",
      );
      return false;
    }
  }

  async function disableSandbox(
    ctx: Parameters<typeof warnIfAllDomainsAllowed>[0],
  ): Promise<boolean> {
    backgroundGeneration++;
    backgroundState = "disabled";
    backgroundReason = "explicit /sandbox-disable or sandbox toggle";
    if (!sandboxEnabled) {
      ctx.ui.notify("Sandbox is already disabled", "info");
      return false;
    }

    if (sandboxInitialized) {
      try {
        await sandboxManager.reset();
      } catch {
        // Ignore cleanup errors.
      }
    }
    sandboxEnabled = false;
    sandboxInitialized = false;
    ctx.ui.setStatus("sandbox", "");
    return true;
  }

  async function toggleSandbox(ctx: Parameters<typeof warnIfAllDomainsAllowed>[0]): Promise<void> {
    if (sandboxEnabled) {
      if (await disableSandbox(ctx)) ctx.ui.notify("Sandbox disabled", "info");
      return;
    }
    if (await enableSandbox(ctx, false)) ctx.ui.notify("Sandbox enabled", "info");
  }

  pi.registerTool({
    ...localBash,
    label: "bash (sandboxed)",
    async execute(id, params, signal, onUpdate, ctx) {
      const runBash = () => {
        const settings = SettingsManager.create(ctx.cwd, undefined, { projectTrusted });
        const userShellPath = settings.getShellPath();
        return createBashToolDefinition(ctx.cwd, {
          operations:
            sandboxEnabled && sandboxInitialized
              ? createSandboxedBashOps(
                  sandboxManager,
                  userShellPath,
                  loadConfig(ctx.cwd, projectTrusted).network?.sshProxy !== false,
                )
              : undefined,
          commandPrefix: settings.getShellCommandPrefix(),
          shellPath: userShellPath,
        }).execute(id, params, signal, onUpdate, ctx);
      };

      let result: AgentToolResult<any>;
      try {
        result = await runBash();
      } catch (error) {
        if (!(error instanceof Error) || !error.message.includes("Operation not permitted")) {
          throw error;
        }
        result = {
          content: [
            {
              type: "text",
              text: `Error: Command failed with OS-level sandbox restriction: ${error.message}`,
            },
          ],
          details: {},
        };
      }

      if (sandboxEnabled && sandboxInitialized && ctx?.hasUI) {
        const output = result.content
          .filter((content: any) => content.type === "text")
          .map((content: any) => content.text)
          .join("\n");
        const blockedPath = extractBlockedWritePath(output);

        if (blockedPath) {
          const path = canonicalizePath(blockedPath, ctx.cwd);
          const config = loadConfig(ctx.cwd, projectTrusted);
          const writePermission = await resolveWritePermission({
            path,
            allowWrite: effectiveWritePaths(ctx.cwd),
            denyWrite: config.filesystem?.denyWrite ?? [],
            baseCwd: ctx.cwd,
            prompt: (path) =>
              promptWriteBlock(pi, ctx, path, config.permissionPromptTimeoutSeconds),
            saveWritePermission: (choice, value) => applyChoice(choice, "write", value, ctx.cwd),
          });
          if (writePermission.action === "deny") {
            return result;
          }
          if (writePermission.action === "allow") {
            await refreshSandbox(ctx.cwd);
            return runBash();
          }
          if (writePermission.action === "granted") {
            onUpdate?.({
              content: [
                {
                  type: "text",
                  text: `\n--- Write access granted for "${writePermission.value}", retrying ---\n`,
                },
              ],
              details: {},
            });
            return runBash();
          }
        }
      }
      return result;
    },
  });

  pi.on("user_bash", async (event, ctx) => {
    if (!sandboxEnabled || !sandboxInitialized) return;

    const userShellPath = SettingsManager.create(ctx.cwd, undefined, {
      projectTrusted,
    }).getShellPath();
    const config = loadConfig(ctx.cwd, projectTrusted);
    if (config.sandboxUserShell === false) return;
    for (const domain of extractDomainsFromCommand(event.command)) {
      if (!domainIsAllowed(domain, effectiveDomains(ctx.cwd))) {
        const choice = await promptDomainBlock(
          pi,
          ctx,
          domain,
          config.permissionPromptTimeoutSeconds,
        );
        if (choice.action === "abort") {
          return {
            result: {
              output: `Blocked: "${domain}" is not in allowedDomains. Use /sandbox to review your config.`,
              exitCode: 1,
              cancelled: false,
              truncated: false,
            },
          };
        }
        await applyChoice(choice.action, "domain", choice.value, ctx.cwd);
      }
    }
    return {
      operations: createSandboxedBashOps(
        sandboxManager,
        userShellPath,
        loadConfig(ctx.cwd, projectTrusted).network?.sshProxy !== false,
      ),
    };
  });

  pi.on("tool_call", async (event, ctx) => {
    if (!sandboxEnabled) return;
    const config = loadConfig(ctx.cwd, projectTrusted);
    if (!config.enabled) return;
    const { projectPath, globalPath } = getConfigPaths(ctx.cwd);

    if (sandboxInitialized && isToolCallEventType("bash", event)) {
      for (const domain of extractDomainsFromCommand(event.input.command)) {
        if (!domainIsAllowed(domain, effectiveDomains(ctx.cwd))) {
          const choice = await promptDomainBlock(
            pi,
            ctx,
            domain,
            config.permissionPromptTimeoutSeconds,
          );
          if (choice.action === "abort") {
            return {
              block: true,
              reason: `Network access to "${domain}" is blocked (not in allowedDomains).`,
            };
          }
          await applyChoice(choice.action, "domain", choice.value, ctx.cwd);
        }
      }
    }

    if (isToolCallEventType("read", event)) {
      const path = canonicalizePath(event.input.path, ctx.cwd);
      if (!matchesPattern(path, effectiveReadPaths(ctx.cwd), ctx.cwd)) {
        const choice = await promptReadBlock(pi, ctx, path, config.permissionPromptTimeoutSeconds);
        if (choice.action === "abort") {
          return { block: true, reason: `Sandbox: read access denied for "${path}"` };
        }
        await applyChoice(choice.action, "read", choice.value, ctx.cwd);
        return;
      }
    }

    if (isToolCallEventType("write", event) || isToolCallEventType("edit", event)) {
      const path = canonicalizePath((event.input as { path: string }).path, ctx.cwd);
      const writePermission = await resolveWritePermission({
        path,
        allowWrite: effectiveWritePaths(ctx.cwd),
        denyWrite: config.filesystem?.denyWrite ?? [],
        baseCwd: ctx.cwd,
        prompt: (path) => promptWriteBlock(pi, ctx, path, config.permissionPromptTimeoutSeconds),
        saveWritePermission: (choice, value) => applyChoice(choice, "write", value, ctx.cwd),
      });
      if (writePermission.action === "deny") {
        return {
          block: true,
          reason:
            `Sandbox: write access denied for "${path}" (in denyWrite). ` +
            `To change this, edit denyWrite in:\n  ${projectPath}\n  ${globalPath}`,
        };
      }
      if (writePermission.action === "abort") {
        return {
          block: true,
          reason: `Sandbox: write access denied for "${path}" (not in allowWrite)`,
        };
      }
      if (writePermission.action === "granted") {
        return;
      }
    }
  });

  pi.on("session_start", async (_event, ctx) => {
    backgroundGeneration++;
    projectTrusted = ctx.isProjectTrusted();
    sessionCwd = ctx.cwd;
    backgroundState = "initializing";
    if (pi.getFlag("no-sandbox") as boolean) {
      sandboxEnabled = false;
      backgroundState = "disabled";
      backgroundReason = "explicit --no-sandbox";
      ctx.ui.notify("Sandbox disabled via --no-sandbox", "warning");
      return;
    }
    try {
      if (loadConfig(ctx.cwd, projectTrusted, { strict: true }).enabled === false) {
        sandboxEnabled = false;
        backgroundState = "disabled";
        backgroundReason = "explicit enabled:false configuration";
        ctx.ui.notify("Sandbox disabled via config", "info");
        return;
      }
    } catch (error) {
      sandboxEnabled = false;
      backgroundState = "failed";
      backgroundReason = error instanceof Error ? error.message : String(error);
      ctx.ui.notify(backgroundReason, "error");
      return;
    }
    await enableSandbox(ctx, true);
  });

  pi.on("session_shutdown", async () => {
    backgroundGeneration++;
    backgroundState = "closed";
    backgroundReason = "sandbox session has shut down";
    const wasInitialized = sandboxInitialized;
    sandboxEnabled = false;
    sandboxInitialized = false;
    sessionCwd = undefined;
    projectTrusted = false;
    allowances.domains.length = 0;
    allowances.readPaths.length = 0;
    allowances.writePaths.length = 0;
    if (wasInitialized) {
      try {
        await sandboxManager.reset();
      } catch {
        // Ignore cleanup errors.
      }
    }
  });

  pi.registerShortcut(Key.alt("s"), {
    description: "Toggle sandbox on/off for this session",
    handler: toggleSandbox,
  });

  pi.registerCommand("sandbox-enable", {
    description: "Enable the sandbox for this session",
    handler: async (_args, ctx) => {
      if (await enableSandbox(ctx, false)) ctx.ui.notify("Sandbox enabled", "info");
    },
  });

  pi.registerCommand("sandbox-disable", {
    description: "Disable the sandbox for this session",
    handler: async (_args, ctx) => {
      if (await disableSandbox(ctx)) ctx.ui.notify("Sandbox disabled", "info");
    },
  });

  pi.registerCommand("sandbox-allow", {
    description: "Prompt to allow a domain or read/write access to a file path",
    handler: async (args, ctx) => {
      const [kind, ...targetParts] = args.trim().split(/\s+/);
      const targetArg = targetParts.join(" ");

      if ((kind !== "domain" && kind !== "read" && kind !== "write") || !targetArg) {
        ctx.ui.notify("Usage: /sandbox-allow <domain|read|write> <domain-or-path>", "error");
        return;
      }

      const target = kind === "domain" ? targetArg : canonicalizePath(targetArg, ctx.cwd);
      const config = loadConfig(ctx.cwd, projectTrusted);
      const configKey =
        kind === "domain" ? "allowedDomains" : kind === "read" ? "allowRead" : "allowWrite";
      const choice = await showPermissionPrompt(
        pi,
        ctx,
        `Add ${target} to ${configKey}?`,
        target,
        (value) => {
          if (!value) return "Rule cannot be empty.";
          const matches =
            kind === "domain"
              ? domainIsAllowed(target, [value])
              : matchesPattern(target, [value], ctx.cwd);
          return matches ? null : `Rule must match "${target}".`;
        },
        config.permissionPromptTimeoutSeconds,
      );
      if (choice.action === "abort") {
        ctx.ui.notify("Allow cancelled", "info");
        return;
      }

      await applyChoice(choice.action, kind, choice.value, ctx.cwd);
      ctx.ui.notify(`Added ${choice.value} to ${configKey}`, "info");
    },
  });

  pi.registerCommand("sandbox", {
    description: "Show sandbox configuration",
    handler: async (_args, ctx) => {
      if (!sandboxEnabled) {
        ctx.ui.notify("Sandbox is disabled", "info");
        return;
      }
      ctx.ui.notify(
        formatSandboxConfiguration(
          loadConfig(ctx.cwd, projectTrusted),
          getConfigPaths(ctx.cwd),
          allowances,
        ),
        "info",
      );
    },
  });
}
