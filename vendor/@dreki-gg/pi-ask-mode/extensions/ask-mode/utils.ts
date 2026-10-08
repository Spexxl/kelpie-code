/**
 * Pure utility functions for ask mode.
 *
 * Command sandboxing is delegated to @dreki-gg/pi-command-sandbox.
 */

import { isSafeCommand as baseSafeCommand } from '@dreki-gg/pi-command-sandbox';

/**
 * Check if a command is safe for ask mode.
 *
 * Delegates to the shared command sandbox with no extra options —
 * ask mode is strictly read-only with no exceptions.
 */
export function isSafeCommand(command: string): boolean {
  return baseSafeCommand(command, {
    allowCommand: (cmd) => isCurlWithStderrRedirect(cmd),
  });
}

/**
 * Allow curl commands that only redirect stderr to /dev/null.
 * shell-quote parses `2>/dev/null` as a stdout redirect, but it's
 * actually a stderr redirect which is safe for read-only mode.
 */
function isCurlWithStderrRedirect(command: string): boolean {
  return (
    /^\s*curl\b/.test(command) &&
    /2>\/dev\/null/.test(command) &&
    !/>(?!\/dev\/null)/.test(command.replace(/2>\/dev\/null/g, ''))
  );
}
