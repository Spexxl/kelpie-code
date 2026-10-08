# Changelog

## 0.3.0 - 2026-08-03

### Added

- Strict fail-closed read-only shell validation for pipelines, redirects, substitutions, wrappers, and mutating command flags.
- Explicit `pi_modes_plan_complete` tool for validated structured plan handoff.
- Versioned persistence for plan steps, completion state, and accepted Markdown plans.
- Branch-aware state restoration through Pi's `session_tree` lifecycle event.
- Read-only modes now block unknown extension and SDK tools by default; use `allowTools` for reviewed exceptions.
- Adversarial shell-policy regression tests.

### Fixed

- Plan transition waits for `agent_settled` instead of prompting during an unfinished assistant message.
- Plan execution now checks whether `build` is enabled and clears completed plans correctly.
- CLI/config aliases such as `act`, `audit`, and `fix` resolve during startup.
- `extraInstructions` accepts both a string and an array of strings, matching the documented configuration.
- Dynamic tool restrictions are re-applied before each agent request.

### Security note

Pi extensions run with the permissions of the Pi process and do not provide an OS sandbox. The read-only policy is defense in depth for model tool calls, not protection against malicious local processes or user-entered shell commands.
