import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Key } from '@earendil-works/pi-tui';
import { CONTEXT_ENTRY } from './constants.js';
import { AskModeController } from './controller.js';
import { getAskModeInstructions } from './prompt.js';
import type { StateEntry } from './state.js';
import { isSafeCommand } from './utils.js';

export default function askMode(pi: ExtensionAPI): void {
  const ask = new AskModeController(pi);

  pi.registerFlag('ask', {
    description: 'Start in ask mode (read-only)',
    type: 'boolean',
    default: false,
  });

  pi.registerCommand('ask', {
    description: 'Toggle ask mode (read-only)',
    handler: async (args, ctx) => {
      if (ask.isEnabled()) {
        ask.exit(ctx);
        return;
      }

      ask.enter(ctx);
      const prompt = args?.trim();
      if (prompt) {
        pi.sendUserMessage(prompt);
      }
    },
  });

  pi.registerShortcut(Key.ctrlAlt('a'), {
    description: 'Toggle ask mode',
    handler: async (ctx) => ask.toggle(ctx),
  });

  pi.on('tool_call', async (event) => {
    if (!ask.isEnabled()) return;

    if (event.toolName === 'edit' || event.toolName === 'write') {
      return {
        block: true,
        reason: 'Ask mode: file modifications are not allowed. Use /ask to exit ask mode first.',
      };
    }

    if (event.toolName === 'bash') {
      const command = event.input.command as string;
      if (!isSafeCommand(command)) {
        return {
          block: true,
          reason: `Ask mode: command blocked. Only read-only commands are allowed.\nCommand: ${command}\nUse /ask to exit ask mode first.`,
        };
      }
    }
  });

  pi.on('before_agent_start', async () => {
    if (!ask.isEnabled()) return;

    return {
      message: {
        customType: CONTEXT_ENTRY,
        content: getAskModeInstructions(),
        display: false,
      },
    };
  });

  pi.on('context', async (event) => {
    if (ask.isEnabled()) return;

    return {
      messages: event.messages.filter((message) => {
        const msg = message as typeof message & { customType?: string };
        return msg.customType !== CONTEXT_ENTRY;
      }),
    };
  });

  pi.on('session_start', async (_event, ctx) => {
    if (pi.getFlag('ask') === true) {
      ask.enableFromFlag();
    }

    ask.restore(ctx, ctx.sessionManager.getEntries() as StateEntry[]);
  });

  pi.on('session_tree', async (_event, ctx) => {
    ask.reset();
    const entries = (ctx.sessionManager.getBranch?.() ??
      ctx.sessionManager.getEntries()) as StateEntry[];
    ask.restore(ctx, entries);
  });
}
