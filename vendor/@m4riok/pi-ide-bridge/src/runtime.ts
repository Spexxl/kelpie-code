import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { RETRY_BACKOFF_MS, STARTUP_STATUS_DURATION_MS, TOGGLE_STATUS_DURATION_MS } from './constants.js';
import { applyEditPreview } from './editPreview.js';
import { getApprovalModeFromEnvironment, getInheritedApprovalMode, hasParentApprovalProxy, requestApprovalFromParentProxy, setApprovalModeEnvironment, startParentApprovalProxy, type ParentApprovalProxyHandle } from './approvalProxy.js';
import { connectContextStream, getIdeConnectionDebugInfo, getIdeConnectionStatus, isIdeConnected, sendCloseDiff, sendGetDiagnostics, sendOpenDiff } from './ideBridgeClient.js';
import { installVsCodeCompanion, installVsCodeCompanionFromLocalDebugVsix } from './installer.js';
import { applyApprovalStatus, applyConnectionStatus, applyIdeContextStatus, clearApprovalStatusTimer, clearConnectionStatusTimer, disposeStatusBar, getStatusRenderMode, setStatusRenderMode, type StatusRenderMode } from './status.js';
import type { ApprovalDecision, ApprovalMode, ApprovalProxyRequest, EditorContext, RejectedChange } from './types.js';

const IDE_USAGE = 'Usage: /ide | /ide status | /ide context | /ide install | /ide debug | /ide diagnostics [active|all|file <absolutePath>] | /ide status-mode [widget|status]';
const IDE_CONNECTION_POLL_MS = 7_000;
const IDE_CONNECTION_STATUS_DURATION_MS = 3_000;
const IDE_CONTEXT_SELECTED_PREVIEW_MAX_CHARS = 200;
const PI_IDE_BRIDGE_SETTINGS_KEY = 'piIdeBridge';

type ApprovalRequest = {
  requestId: string;
  toolName: 'edit' | 'write';
  pathArg: string;
  filePath: string;
  beforeText: string;
  afterText: string;
};

class ApprovalUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ApprovalUnavailableError';
  }
}

export default function createPiIdeBridgeExtension(pi: ExtensionAPI) {
  let mode: ApprovalMode = getInheritedApprovalMode();
  let pendingRejectedChange: RejectedChange | undefined;
  let parentApprovalProxy: ParentApprovalProxyHandle | undefined;
  let ideConnectionPollTimer: ReturnType<typeof setInterval> | undefined;
  let lastIdeConnected: boolean | undefined;
  let liveContext: EditorContext | undefined;
  let contextStreamHandle: { disconnect: () => void } | undefined;
  let contextReconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let contextReconnectAttempt = 0;

  async function startApprovalProxyIfPossible(ctx: any): Promise<void> {
    if (ctx.hasUI !== true) return;

    parentApprovalProxy?.stop();
    parentApprovalProxy = undefined;

    try {
      parentApprovalProxy = await startParentApprovalProxy(
        mode,
        (request) => handleParentApprovalRequest(ctx, request),
        (message) => console.warn(message),
      );
    } catch (error) {
      console.warn(`Pi IDE Bridge: approval proxy failed to start: ${String(error instanceof Error ? error.message : error)}`);
    }
  }

  async function handleParentApprovalRequest(ctx: any, request: ApprovalProxyRequest): Promise<ApprovalDecision> {
    if (mode === 'auto') return 'approved';

    const approval: ApprovalRequest = {
      requestId: `child-${request.proxyRequestId}`,
      toolName: request.toolName,
      pathArg: request.pathArg,
      filePath: request.filePath,
      beforeText: request.beforeText,
      afterText: request.afterText,
    };
    const decision = await requestLocalApproval(ctx, approval);
    await applyApprovalDecision(ctx, approval, decision, { closeDiff: true, recordRejected: false });
    return decision;
  }

  async function requestLocalApproval(ctx: any, request: ApprovalRequest): Promise<ApprovalDecision> {
    const canPromptInPi = ctx.hasUI === true;
    const piPromptAbort = new AbortController();

    const vscodeDecisionPromise = sendOpenDiff(
      {
        filePath: request.filePath,
        beforeText: request.beforeText,
        afterText: request.afterText,
        requestId: request.requestId,
      },
      { rejectOnUnavailable: !canPromptInPi },
    ).then((decision) => {
      piPromptAbort.abort();
      return normalizeVscodeDecision(decision);
    }).catch((error) => {
      if (!canPromptInPi) {
        throw new ApprovalUnavailableError([
          `Pi IDE Bridge: edit approval required for ${request.pathArg}, but this Pi session has no UI and IDE bridge is unavailable.`,
          `Reason: ${String(error instanceof Error ? error.message : error)}.`,
          'Enable auto-accept mode in the parent session, connect VS Code bridge, or run from an interactive parent session.',
        ].join(' '));
      }
      return waitForDecisionFallback();
    });

    if (!canPromptInPi) return vscodeDecisionPromise;

    const piDecisionPromise = askPiDecision(ctx, request.pathArg, piPromptAbort.signal).catch((error) => {
      if (isAbortError(error)) {
        return waitForDecisionFallback();
      }
      throw error;
    });

    return Promise.race([vscodeDecisionPromise, piDecisionPromise]);
  }

  async function applyApprovalDecision(
    ctx: any,
    request: ApprovalRequest,
    decision: ApprovalDecision,
    options: { closeDiff: boolean; recordRejected: boolean },
  ): Promise<{ block: true; reason: string } | undefined> {
    if (decision === 'approved_auto') {
      mode = 'auto';
      persistApprovalMode(pi, mode);
      applyApprovalStatus(ctx, mode, TOGGLE_STATUS_DURATION_MS);
      if (options.closeDiff) await sendCloseDiff(request.requestId, 'approved');
      return undefined;
    }

    if (decision === 'approved') {
      if (options.closeDiff) await sendCloseDiff(request.requestId, 'approved');
      return undefined;
    }

    if (options.recordRejected) {
      const rejected: RejectedChange = {
        filePath: request.filePath,
        beforeText: request.beforeText,
        afterText: request.afterText,
        rejectedAt: Date.now(),
      };
      pendingRejectedChange = rejected;
      pi.appendEntry('pi-ide-bridge-rejected-change', rejected);
    }

    if (options.closeDiff) await sendCloseDiff(request.requestId, 'rejected');
    return { block: true, reason: `User rejected update to ${request.pathArg}` };
  }

  pi.on('session_start', async (_event, ctx) => {
    mode = getInheritedApprovalMode(mode);

    const configuredRenderMode = await loadStatusRenderMode(ctx.cwd);
    setStatusRenderMode(ctx, configuredRenderMode);

    applyApprovalStatus(ctx, mode, STARTUP_STATUS_DURATION_MS);

    const pollIdeConnection = async () => {
      const connected = await isIdeConnected().catch(() => false);
      if (lastIdeConnected === undefined || connected !== lastIdeConnected) {
        applyConnectionStatus(ctx, connected, IDE_CONNECTION_STATUS_DURATION_MS);
        lastIdeConnected = connected;
      }
    };

    void pollIdeConnection();
    if (ideConnectionPollTimer) clearInterval(ideConnectionPollTimer);
    ideConnectionPollTimer = setInterval(() => {
      void pollIdeConnection();
    }, IDE_CONNECTION_POLL_MS);

    const reconnectDelays = RETRY_BACKOFF_MS;
    const clearReconnectTimer = () => {
      if (contextReconnectTimer) {
        clearTimeout(contextReconnectTimer);
        contextReconnectTimer = undefined;
      }
    };

    const startContextStream = () => {
      contextStreamHandle = connectContextStream(
        (context) => {
          liveContext = context;
          contextReconnectAttempt = 0;
          clearReconnectTimer();
          applyIdeContextStatus(ctx, context);
        },
        () => {
          if (contextReconnectTimer) return;
          const delay = reconnectDelays[Math.min(contextReconnectAttempt, reconnectDelays.length - 1)];
          contextReconnectAttempt++;
          contextReconnectTimer = setTimeout(() => {
            contextReconnectTimer = undefined;
            startContextStream();
          }, delay);
        },
      );
    };

    startContextStream();

    const entries = ctx.sessionManager.getEntries();
    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i];
      if (entry.type !== 'custom') continue;

      if (!pendingRejectedChange && entry.customType === 'pi-ide-bridge-rejected-change') {
        const data = (entry.data || {}) as Partial<RejectedChange>;
        if (typeof data.filePath === 'string') {
          pendingRejectedChange = {
            filePath: data.filePath,
            beforeText: String(data.beforeText ?? ''),
            afterText: String(data.afterText ?? ''),
            rejectedAt: Number(data.rejectedAt ?? Date.now()),
          };
        }
      }

      if (entry.customType === 'pi-ide-bridge-approval-mode') {
        const data = (entry.data || {}) as { mode?: unknown };
        if (data.mode === 'ask' || data.mode === 'auto') {
          mode = data.mode;
          break;
        }
      }
    }

    await startApprovalProxyIfPossible(ctx);
    applyApprovalStatus(ctx, mode, STARTUP_STATUS_DURATION_MS);
  });

  pi.on('session_shutdown', async (_event, ctx) => {
    parentApprovalProxy?.stop();
    parentApprovalProxy = undefined;
    clearApprovalStatusTimer();
    clearConnectionStatusTimer();
    if (ideConnectionPollTimer) {
      clearInterval(ideConnectionPollTimer);
      ideConnectionPollTimer = undefined;
    }
    if (contextReconnectTimer) {
      clearTimeout(contextReconnectTimer);
      contextReconnectTimer = undefined;
    }
    contextStreamHandle?.disconnect();
    contextStreamHandle = undefined;
    contextReconnectAttempt = 0;
    liveContext = undefined;
    applyIdeContextStatus(ctx, undefined);
    disposeStatusBar(ctx);
    lastIdeConnected = undefined;
  });

  pi.on('before_agent_start', async (_event, _ctx) => {
    if (pendingRejectedChange) {
      const rejected = pendingRejectedChange;
      pendingRejectedChange = undefined;

      return {
        message: {
          customType: 'pi-ide-bridge-rejected-change',
          display: false,
          content: [
            'User rejected a proposed edit in the previous step.',
            'If relevant to the new user prompt, revise that same proposal instead of starting over.',
            `File: ${rejected.filePath}`,
            '--- BEFORE ---',
            rejected.beforeText,
            '--- AFTER (REJECTED) ---',
            rejected.afterText,
          ].join('\n'),
          details: rejected,
        },
      };
    }

    if (!liveContext || !Array.isArray(liveContext.openFiles) || liveContext.openFiles.length === 0) return;

    const active = liveContext.openFiles.find((file) => file.isActive) || liveContext.openFiles[0];
    if (!active) return;

    const cursor = active.cursor ? `line ${active.cursor.line}, col ${active.cursor.character}` : 'cursor unknown';
    const selectedText = active.selectedText || '';
    const selectedLines = selectedText ? selectedText.split(/\r?\n/).length : 0;
    const selectedPreview = selectedText.length > IDE_CONTEXT_SELECTED_PREVIEW_MAX_CHARS
      ? `${selectedText.slice(0, IDE_CONTEXT_SELECTED_PREVIEW_MAX_CHARS)}…`
      : selectedText;
    const selectedInfo = selectedText
      ? `"${selectedPreview}" (${selectedLines} line${selectedLines === 1 ? '' : 's'})`
      : '(none)';
    const openFileNames = liveContext.openFiles.map((file) => file.path.split('/').pop() || file.path);
    const preview = openFileNames.slice(0, 2).join(', ');
    const remaining = openFileNames.length - 2;

    return {
      message: {
        customType: 'pi-ide-bridge-editor-context',
        display: false,
        content: [
          '[IDE Context]',
          `Active file: ${active.path} — ${cursor}`,
          `Selected: ${selectedInfo}`,
          `Open files: ${preview}${remaining > 0 ? `, +${remaining} more` : ''}`,
        ].join('\n'),
        details: liveContext,
      },
    };
  });

  pi.registerShortcut('f8', {
    description: 'Toggle edit approval mode',
    handler: async (ctx) => {
      mode = mode === 'auto' ? 'ask' : 'auto';
      persistApprovalMode(pi, mode);
      applyApprovalStatus(ctx, mode, TOGGLE_STATUS_DURATION_MS);
    },
  });

  pi.registerCommand('ide', {
    description: 'Show IDE bridge status or install the VS Code extension',
    handler: async (args, ctx) => {
      const rawArgs = String(args || '').trim();
      const parts = rawArgs ? rawArgs.split(/\s+/) : [];
      const action = (parts[0] || '').toLowerCase();

      if (!action || action === 'status') {
        const status = await getIdeConnectionStatus(ctx.ui?.theme);
        ctx.ui.notify(status.text, status.type);
        return;
      }

      if (action === 'status-mode') {
        const requested = (parts[1] || '').toLowerCase();
        if (!requested) {
          ctx.ui.notify(`Pi IDE Bridge status mode: ${getStatusRenderMode()}`, 'info');
          return;
        }

        if (requested !== 'widget' && requested !== 'status') {
          ctx.ui.notify('Usage: /ide status-mode [widget|status]', 'error');
          return;
        }

        const renderMode = requested as StatusRenderMode;
        setStatusRenderMode(ctx, renderMode);
        await saveStatusRenderMode(ctx.cwd, renderMode);
        ctx.ui.notify(`Pi IDE Bridge status mode set to ${renderMode}.`, 'info');
        return;
      }

      if (action === 'debug') {
        const debug = await getIdeConnectionDebugInfo();
        if (debug.connected) {
          ctx.ui.notify(`Pi IDE Bridge debug: connected=yes source=${debug.source} port=${String(debug.port ?? 'n/a')}`, 'info');
          return;
        }
        ctx.ui.notify(`Pi IDE Bridge debug: connected=no source=${debug.source} reason=${String(debug.reason || 'unknown')}`, 'info');
        return;
      }

      if (action === 'context') {
        if (!liveContext) {
          ctx.ui.notify('Pi IDE Bridge context: unavailable (no SSE context received yet).', 'info');
          return;
        }

        const payload = JSON.stringify(liveContext, null, 2);
        pi.sendMessage({
          customType: 'pi-ide-bridge-context-debug',
          display: true,
          content: ['[IDE Context Debug]', payload].join('\n'),
          details: liveContext,
        });
        ctx.ui.notify('Pi IDE Bridge context dumped to chat.', 'info');
        return;
      }

      if (action === 'diagnostics') {
        const rest = parts.slice(1);
        const requestedScope = (rest[0] || 'active').toLowerCase();
        const scope = requestedScope === 'all' || requestedScope === 'file' ? requestedScope : 'active';
        const filePath = scope === 'file' ? rest.slice(1).join(' ').trim() : undefined;

        if (scope === 'file' && !filePath) {
          ctx.ui.notify("Usage: /ide diagnostics file <absolutePath>", 'error');
          return;
        }

        const diagnostics = await sendGetDiagnostics({ scope, filePath });
        if (!diagnostics) {
          ctx.ui.notify('Pi IDE Bridge diagnostics: unavailable (bridge disconnected).', 'error');
          return;
        }

        const payload = JSON.stringify(diagnostics, null, 2);
        pi.sendMessage({
          customType: 'pi-ide-bridge-diagnostics-debug',
          display: true,
          content: ['[IDE Diagnostics]', payload].join('\n'),
          details: diagnostics,
        });
        ctx.ui.notify(`Pi IDE Bridge diagnostics dumped to chat (files=${diagnostics.files.length}, errors=${diagnostics.totalErrors}, warnings=${diagnostics.totalWarnings}).`, 'info');
        return;
      }

      if (action === 'install') {
        const vsixPath = parts[1] || '';
        const installed = vsixPath
          ? await installVsCodeCompanionFromLocalDebugVsix(vsixPath)
          : await installVsCodeCompanion();
        if (installed) {
          ctx.ui.notify('✓ VS Code companion extension installed. Run /ide status to verify connection.', 'info');
          return;
        }

        const message = vsixPath
          ? `✕ Failed to install VSIX from path: ${vsixPath}`
          : "✕ No installer is available for IDE. Please install the 'Pi IDE Bridge' extension manually from the marketplace.";
        ctx.ui.notify(message, 'error');
        return;
      }

      if (action === 'help') {
        ctx.ui.notify(IDE_USAGE, 'info');
        return;
      }

      ctx.ui.notify(IDE_USAGE, 'info');
    },
  });

  pi.registerTool({
    name: 'get_ide_diagnostics',
    label: 'Get IDE Diagnostics',
    description: 'Retrieve current VS Code diagnostics (errors and warnings only) for active, open-files, or specific file scope.',
    promptSnippet: 'Query VS Code diagnostics; prefer active scope when the request is vague.',
    promptGuidelines: [
      'Use get_ide_diagnostics when current IDE errors/warnings can help resolve the user task.',
      "When the user asks vaguely (e.g., 'check diagnostics' without scope), prefer scope='active' first.",
      "Use scope='active' for current editor (preferred default), scope='all' for open files (up to 10), or scope='file' with absolute filePath.",
      "scope='active' and scope='file' can return up to 500 diagnostics for deeper detail; scope='all' returns up to 50 per file.",
      'Only errors and warnings are returned; hints and info are intentionally excluded.',
    ],
    parameters: Type.Object({
      scope: Type.Optional(Type.Union([
        Type.Literal('active'),
        Type.Literal('all'),
        Type.Literal('file'),
      ], { description: "Diagnostics scope. Defaults to 'active'." })),
      filePath: Type.Optional(Type.String({ description: "Absolute file path. Required when scope is 'file'." })),
    }),
    async execute(_toolCallId, params) {
      const scope = params.scope ?? 'active';
      const filePath = typeof params.filePath === 'string' ? params.filePath : undefined;

      if (scope === 'file' && !filePath) {
        return {
          content: [{ type: 'text', text: "get_ide_diagnostics error: filePath is required when scope is 'file'." }],
          details: {},
        };
      }

      const diagnostics = await sendGetDiagnostics({ scope, filePath });
      if (!diagnostics) {
        return {
          content: [{ type: 'text', text: 'get_ide_diagnostics error: IDE bridge not connected.' }],
          details: {},
        };
      }

      return {
        content: [{ type: 'text', text: JSON.stringify(diagnostics, null, 2) }],
        details: {},
      };
    },
  });

  pi.on('tool_call', async (event, ctx) => {
    if (event.toolName !== 'edit' && event.toolName !== 'write') return;

    const pathArg = String((event.input as any).path || '');
    if (!pathArg) return;

    const hasUi = ctx.hasUI === true;
    const shouldAskParent = !hasUi && hasParentApprovalProxy();
    if (hasUi) {
      if (mode === 'auto') return;
    } else if (!shouldAskParent && getApprovalModeFromEnvironment() === 'auto') {
      return;
    }

    const filePath = resolve(ctx.cwd, pathArg);
    const beforeText = await readFile(filePath, 'utf8').catch(() => '');
    const preview = event.toolName === 'write'
      ? { output: String((event.input as any).content ?? ''), appliedCount: 1, skippedCount: 0 }
      : applyEditPreview(beforeText, (event.input as any).edits ?? []);
    const afterText = preview.output;
    if (event.toolName === 'edit' && preview.skippedCount > 0) {
      ctx.ui.notify(`Pi IDE Bridge: ${preview.skippedCount} edit preview segment(s) could not be mapped exactly.`, 'info');
    }

    const approval: ApprovalRequest = {
      requestId: event.toolCallId,
      toolName: event.toolName,
      pathArg,
      filePath,
      beforeText,
      afterText,
    };

    let decision: ApprovalDecision;
    let closeDiff = true;

    try {
      if (!hasUi) {
        const parentDecision = shouldAskParent
          ? await requestApprovalFromParentProxy({
            requestId: event.toolCallId,
            toolName: event.toolName,
            pathArg,
            filePath,
            beforeText,
            afterText,
            cwd: ctx.cwd,
          }, ctx.signal)
          : undefined;

        if (parentDecision) {
          decision = parentDecision === 'approved_auto' ? 'approved' : parentDecision;
          closeDiff = false;
        } else if (getApprovalModeFromEnvironment() === 'auto') {
          return;
        } else {
          decision = await requestLocalApproval(ctx, approval);
        }
      } else {
        decision = await requestLocalApproval(ctx, approval);
      }
    } catch (error) {
      if (error instanceof ApprovalUnavailableError) {
        return { block: true, reason: error.message };
      }
      throw error;
    }

    return applyApprovalDecision(ctx, approval, decision, { closeDiff, recordRejected: true });
  });
}

async function askPiDecision(ctx: any, pathArg: string, signal?: AbortSignal): Promise<ApprovalDecision> {
  const choice = await ctx.ui.select(
    `Do you want to make this edit to ${pathArg}?`,
    ['Yes', 'Yes, auto-accept edits', 'No'],
    { signal }
  );

  if (choice === 'Yes, auto-accept edits') return 'approved_auto';
  if (choice === 'Yes') return 'approved';
  return 'rejected';
}

function normalizeVscodeDecision(decision: string): ApprovalDecision {
  if (decision === 'approved') return 'approved';
  return 'rejected';
}

function persistApprovalMode(pi: ExtensionAPI, mode: ApprovalMode): void {
  setApprovalModeEnvironment(mode);
  pi.appendEntry('pi-ide-bridge-approval-mode', { mode, updatedAt: Date.now() });
}

function isAbortError(error: unknown): boolean {
  const name = (error as { name?: unknown } | undefined)?.name;
  return name === 'AbortError';
}

function waitForDecisionFallback(): Promise<ApprovalDecision> {
  return new Promise(() => undefined);
}

async function loadStatusRenderMode(cwd: string): Promise<StatusRenderMode> {
  const projectPath = resolve(cwd, '.pi/settings.json');
  const projectMode = await readStatusRenderModeFromSettingsFile(projectPath);
  if (projectMode) return projectMode;

  const globalPath = resolve(homedir(), '.pi/agent/settings.json');
  const globalMode = await readStatusRenderModeFromSettingsFile(globalPath);
  if (globalMode) return globalMode;

  return 'widget';
}

async function saveStatusRenderMode(cwd: string, mode: StatusRenderMode): Promise<void> {
  const projectPath = resolve(cwd, '.pi/settings.json');
  const projectMode = await readStatusRenderModeFromSettingsFile(projectPath);
  if (projectMode !== null) {
    await writeStatusRenderModeToSettingsFile(projectPath, mode);
    return;
  }

  const globalPath = resolve(homedir(), '.pi/agent/settings.json');
  await writeStatusRenderModeToSettingsFile(globalPath, mode);
}

async function readStatusRenderModeFromSettingsFile(path: string): Promise<StatusRenderMode | null> {
  try {
    const raw = await readFile(path, 'utf8');
    const parsed = JSON.parse(raw) as any;
    const mode = parsed?.[PI_IDE_BRIDGE_SETTINGS_KEY]?.statusMode;
    if (mode === 'widget' || mode === 'status') return mode;
    return null;
  } catch {
    return null;
  }
}

async function writeStatusRenderModeToSettingsFile(path: string, mode: StatusRenderMode): Promise<void> {
  let parsed: any = {};
  try {
    const raw = await readFile(path, 'utf8');
    parsed = JSON.parse(raw) as any;
  } catch {
    parsed = {};
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    parsed = {};
  }

  const existingSection = parsed[PI_IDE_BRIDGE_SETTINGS_KEY];
  parsed[PI_IDE_BRIDGE_SETTINGS_KEY] = {
    ...(existingSection && typeof existingSection === 'object' ? existingSection : {}),
    statusMode: mode,
  };

  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(parsed, null, 2)}\n`, 'utf8');
}
