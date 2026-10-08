# Local Ask + native CodeMode

Derived from MIT-licensed pi-agent-modes 0.3.0, npm repository yoyo406/pi-agent-modes (renamed y-0-y-0/pi-agent-modes).

The local change asks the existing workflow:mutex:v1 protocol before entering or restoring Ask. If Plan or another cooperative workflow is active, Ask is refused before changing mode, thinking or tools. Startup/tree restoration falls back to Build. Exit Plan with /plan off before /mode ask. To enter Plan from Ask, first use /mode build.

Install this local package instead of @dreki-gg/pi-ask-mode. Copy modes.config.example.json to the agent directory as modes.config.json. Only Ask/Build are enabled; the separate /plan and /debug commands remain supplied by their existing packages. Alt+M cycles, Ctrl+Alt+M returns to the previous mode.

Ask intentionally denies every bash command. Native read/grep/find/ls remain available, including from CodeMode. Enable +grep, +find and +ls in defaultTools if desired. The allowTools list permits only codemode and tool_search; arbitrary MCP/custom tools are denied even if discovered later. Do not grant tools solely because they claim readOnlyHint.

The original framework's internal plan completion tool is still registered but its internal Plan mode is disabled; it does not replace the existing Plan plugin.

Regression harness: ../ask-fork-test.mjs. The tests use isolated config, real native CodeMode on/only, an offline MCP stdio fixture and real @narumitw/pi-plan-mode; lifecycle boundary tests use the real SDK runner with a fixture implementing the existing mutex protocol. No remote model calls.

Revision local.2: strict Ask defaults now live in the source itself (bash deny, codemode/tool_search allowed, no forced thinking level). Missing or malformed configuration therefore keeps the same safe Ask defaults. An explicit valid trusted override may deliberately change that policy. The updated regression has 126 assertions, including absent and invalid configuration.
