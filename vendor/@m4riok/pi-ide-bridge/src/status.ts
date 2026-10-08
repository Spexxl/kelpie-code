import { basename } from 'node:path';
import stringWidth from 'string-width';
import type { ApprovalMode, EditorContext } from './types.js';

export type StatusRenderMode = 'widget' | 'status';

let statusHideTimer: ReturnType<typeof setTimeout> | undefined;
let statusHideGeneration = 0;
let connectionHideTimer: ReturnType<typeof setTimeout> | undefined;
let connectionHideGeneration = 0;

// Enable transient auto-hide for connection and approval statuses.
const ENABLE_TRANSIENT_STATUS_HIDE = true;

const STATUSBAR_WIDGET_ID = 'pi-ide-bridge-statusbar';
const STATUSBAR_SAFE_RIGHT_MARGIN = 6;

type SlotKey = 'context' | 'connection' | 'approval';
type Side = 'left' | 'right';

type SlotItem = {
  slot: SlotKey;
  text: string;
};

const statusBarState: Record<SlotKey, string | undefined> = {
  context: undefined,
  connection: undefined,
  approval: undefined,
};

const leftSlotOrder: SlotKey[] = ['approval'];
const rightSlotOrder: SlotKey[] = ['connection', 'context'];

let resizeListenerAttached = false;
let resizeRenderCtx: any;
let statusRenderMode: StatusRenderMode = 'widget';

const STATUS_KEYS: Record<SlotKey, string> = {
  context: 'pi-ide-bridge-context',
  connection: 'pi-ide-bridge-connection',
  approval: 'pi-ide-bridge-approval',
};

export function clearApprovalStatusTimer() {
  if (statusHideTimer) {
    clearTimeout(statusHideTimer);
    statusHideTimer = undefined;
  }
  statusHideGeneration++;
}

export function clearConnectionStatusTimer() {
  if (connectionHideTimer) {
    clearTimeout(connectionHideTimer);
    connectionHideTimer = undefined;
  }
  connectionHideGeneration++;
}

export function disposeStatusBar(ctx?: any) {
  if (resizeListenerAttached && process.stdout) {
    process.stdout.off('resize', onTerminalResize);
  }
  resizeListenerAttached = false;
  resizeRenderCtx = undefined;

  if (ctx?.ui) {
    clearStatusModeOutputs(ctx);
  }

  statusBarState.context = undefined;
  statusBarState.connection = undefined;
  statusBarState.approval = undefined;
}

export function getStatusRenderMode(): StatusRenderMode {
  return statusRenderMode;
}

export function setStatusRenderMode(ctx: any, mode: StatusRenderMode): void {
  statusRenderMode = mode;

  if (mode === 'status' && resizeListenerAttached && process.stdout) {
    process.stdout.off('resize', onTerminalResize);
    resizeListenerAttached = false;
    resizeRenderCtx = undefined;
  }

  clearStatusModeOutputs(ctx);
  renderByMode(ctx);
}

export function applyConnectionStatus(ctx: any, connected: boolean, durationMs: number) {
  const text = connected
    ? formatConnectionText(ctx, '●', 'connected to IDE', true)
    : formatConnectionText(ctx, '●', 'disconnected from IDE', false);
  setStatusBarSlot(ctx, 'connection', text);

  if (!ENABLE_TRANSIENT_STATUS_HIDE) return;

  if (connectionHideTimer) clearTimeout(connectionHideTimer);
  const generation = ++connectionHideGeneration;
  connectionHideTimer = setTimeout(() => {
    if (generation !== connectionHideGeneration) return;
    setStatusBarSlot(ctx, 'connection', undefined);
  }, durationMs);
}

export function applyApprovalStatus(ctx: any, mode: ApprovalMode, durationMs: number) {
  const base = `⏵⏵ auto-accept edits: ${mode === 'auto' ? 'on' : 'off'} (F8 to cycle)`;
  const text = formatApprovalText(ctx, base, mode);
  setStatusBarSlot(ctx, 'approval', text);

  if (!ENABLE_TRANSIENT_STATUS_HIDE) return;

  if (statusHideTimer) clearTimeout(statusHideTimer);
  const generation = ++statusHideGeneration;
  statusHideTimer = setTimeout(() => {
    if (generation !== statusHideGeneration) return;
    setStatusBarSlot(ctx, 'approval', undefined);
  }, durationMs);
}

export function applyIdeContextStatus(ctx: any, context: EditorContext | undefined) {
  try {
    if (!context || !Array.isArray(context.openFiles) || context.openFiles.length === 0) {
      setStatusBarSlot(ctx, 'context', undefined);
      return;
    }

    const active = context.openFiles.find((file) => file.isActive) || context.openFiles[0];
    if (!active) {
      setStatusBarSlot(ctx, 'context', undefined);
      return;
    }

    const selectedText = active.selectedText || '';
    const selectedLines = selectedText ? selectedText.split(/\r?\n/).length : 0;
    const base = selectedLines > 0
      ? `✂  ${selectedLines} line${selectedLines === 1 ? '' : 's'} selected`
      : `◉  In ${basename(active.path)}`;

    setStatusBarSlot(ctx, 'context', formatAccentText(ctx, base));
  } catch {
    // Status UI failures must not write to stdout/stderr and disrupt the TUI.
  }
}

function setStatusBarSlot(ctx: any, slot: SlotKey, text: string | undefined) {
  try {
    statusBarState[slot] = text;
    renderByMode(ctx);
  } catch {
    // Status UI failures must not write to stdout/stderr and disrupt the TUI.
  }
}

function renderByMode(ctx: any) {
  if (statusRenderMode === 'status') {
    renderAsStatus(ctx);
    return;
  }
  ensureResizeListener(ctx);
  renderStatusBar(ctx);
}

function clearStatusModeOutputs(ctx: any) {
  try {
    ctx.ui.setWidget(STATUSBAR_WIDGET_ID, undefined, { placement: 'belowEditor' });
  } catch {
    // ignore widget clear errors
  }

  for (const key of Object.values(STATUS_KEYS)) {
    try {
      ctx.ui.setStatus(key, undefined);
    } catch {
      // ignore status clear errors
    }
  }
}

function renderAsStatus(ctx: any) {
  for (const slot of Object.keys(STATUS_KEYS) as SlotKey[]) {
    const key = STATUS_KEYS[slot];
    const text = statusBarState[slot];
    ctx.ui.setStatus(key, text);
  }
}

function ensureResizeListener(ctx: any) {
  resizeRenderCtx = ctx;
  if (resizeListenerAttached || !process.stdout) return;
  process.stdout.on('resize', onTerminalResize);
  resizeListenerAttached = true;
}

function onTerminalResize() {
  if (!resizeRenderCtx) return;
  try {
    renderStatusBar(resizeRenderCtx);
  } catch {
    // ignore resize render failures
  }
}

function renderStatusBar(ctx: any) {
  const leftItems = getItemsForSide('left');
  const rightItems = getItemsForSide('right');

  if (leftItems.length === 0 && rightItems.length === 0) {
    ctx.ui.setWidget(STATUSBAR_WIDGET_ID, undefined, { placement: 'belowEditor' });
    return;
  }

  const terminalWidth = Number(process.stdout?.columns || 120);
  const width = Math.max(20, terminalWidth - STATUSBAR_SAFE_RIGHT_MARGIN);
  const lineCount = Math.max(leftItems.length, rightItems.length);
  const lines: string[] = [];

  for (let i = 0; i < lineCount; i++) {
    const leftItem = leftItems[i];
    const rightItem = rightItems[i];
    lines.push(composeLine(ctx, leftItem, rightItem, width));
  }

  ctx.ui.setWidget(STATUSBAR_WIDGET_ID, lines, { placement: 'belowEditor' });
}

function getItemsForSide(side: Side): SlotItem[] {
  const order = side === 'left' ? leftSlotOrder : rightSlotOrder;
  const items: SlotItem[] = [];
  for (const slot of order) {
    const text = statusBarState[slot];
    if (!text) continue;
    items.push({ slot, text });
  }
  return items;
}

function composeLine(_ctx: any, leftItem: SlotItem | undefined, rightItem: SlotItem | undefined, width: number): string {
  const spacer = 2;
  const leftPlain = leftItem?.text ?? '';
  const rightPlain = rightItem?.text ?? '';

  if (!leftPlain && !rightPlain) return '';

  if (!rightPlain) {
    const left = truncateToWidth(leftPlain, width);
    return left;
  }

  if (!leftPlain) {
    const right = truncateToWidth(rightPlain, width);
    const spaces = Math.max(0, width - textWidth(right));
    return `${' '.repeat(spaces)}${right}`;
  }

  if (textWidth(rightPlain) >= width) {
    const right = truncateToWidth(rightPlain, width);
    return right;
  }

  const maxLeft = Math.max(0, width - textWidth(rightPlain) - spacer);
  const left = truncateToWidth(leftPlain, maxLeft);
  const spaces = Math.max(spacer, width - textWidth(left) - textWidth(rightPlain));

  return `${left}${' '.repeat(spaces)}${rightPlain}`;
}

function formatAccentText(ctx: any, text: string): string {
  const theme = ctx.ui?.theme;
  if (theme?.fg) return theme.fg('accent', text);
  return `\u001b[38;2;74;61;196m${text}\u001b[0m`;
}

function formatErrorText(ctx: any, text: string): string {
  const theme = ctx.ui?.theme;
  if (theme?.fg) return theme.fg('error', text);
  return text;
}

function formatConnectionText(ctx: any, icon: string, body: string, connected: boolean): string {
  const theme = ctx.ui?.theme;
  const iconText = theme?.fg
    ? (connected ? theme.fg('success', icon) : theme.fg('error', icon))
    : icon;
  const bodyText = formatAccentText(ctx, body);
  return `${iconText} ${bodyText}`;
}

function formatApprovalText(ctx: any, text: string, mode: ApprovalMode): string {
  return mode === 'auto' ? formatAccentText(ctx, text) : formatErrorText(ctx, text);
}

function textWidth(text: string): number {
  return stringWidth(text);
}

function truncateToWidth(text: string, maxWidth: number): string {
  if (maxWidth <= 0) return '';
  if (textWidth(text) <= maxWidth) return text;
  if (maxWidth === 1) return '…';

  const target = maxWidth - 1;
  let out = '';
  for (const char of text) {
    const next = out + char;
    if (textWidth(next) > target) break;
    out = next;
  }

  return `${out}…`;
}
