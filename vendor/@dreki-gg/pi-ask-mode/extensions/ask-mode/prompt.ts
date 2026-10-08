import { ASK_TOOLS } from './constants.js';

export function getAskModeInstructions(): string {
  return `[ASK MODE ACTIVE]
You are in ask mode — a read-only mode with strict restrictions.

Restrictions:
- Available tools: ${ASK_TOOLS.join(', ')}
- Bash is restricted to read-only commands (ls, grep, cat, git status, etc.)
- edit and write tools are NOT available
- Do NOT attempt to create, modify, or delete any files

Your task is to answer questions, analyze code, explore the codebase, and provide recommendations without making any changes.`;
}
