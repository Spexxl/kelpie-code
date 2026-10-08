import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { ASK_TOOLS, STATE_ENTRY } from './constants.js';
import { findSavedAskState, type PersistedState, type StateEntry } from './state.js';

export class AskModeController {
  private enabled = false;
  private previousTools: string[] | undefined;

  constructor(private readonly pi: ExtensionAPI) {}

  isEnabled(): boolean {
    return this.enabled;
  }

  enableFromFlag(): void {
    this.enabled = true;
  }

  enter(ctx: ExtensionContext): void {
    this.previousTools = [...this.pi.getActiveTools()];
    this.enabled = true;
    this.pi.setActiveTools(ASK_TOOLS);
    this.updateUI(ctx);
    this.persist();
    ctx.ui.notify('Ask mode ON — read-only tools only', 'info');
  }

  exit(ctx: ExtensionContext): void {
    this.enabled = false;
    if (this.previousTools) {
      this.pi.setActiveTools(this.previousTools);
      this.previousTools = undefined;
    }
    this.updateUI(ctx);
    this.persist();
    ctx.ui.notify('Ask mode OFF — full tool access restored', 'info');
  }

  toggle(ctx: ExtensionContext): void {
    if (this.enabled) {
      this.exit(ctx);
    } else {
      this.enter(ctx);
    }
  }

  restore(ctx: ExtensionContext, entries: StateEntry[]): void {
    const saved = findSavedAskState(entries);
    if (saved !== undefined) {
      this.enabled = saved;
    }

    if (this.enabled) {
      this.pi.setActiveTools(ASK_TOOLS);
    }

    this.updateUI(ctx);
  }

  reset(): void {
    this.enabled = false;
  }

  private persist(): void {
    this.pi.appendEntry<PersistedState>(STATE_ENTRY, { askEnabled: this.enabled });
  }

  private updateUI(ctx: ExtensionContext): void {
    ctx.ui.setStatus('ask-mode', this.enabled ? ctx.ui.theme.fg('accent', '🔍 ask') : undefined);
  }
}
