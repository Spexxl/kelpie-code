# pi-agent-modes

Switchable workflow modes for the [Pi coding agent](https://github.com/earendil-works/pi-coding-agent): `ask`, `plan`, `build`, `review`, `debug`, `yolo`.

Each mode changes the agent's system instructions **and** its effective tool access:

- Read-only modes (`ask`, `plan`, `review`) remove `edit`/`write` and unknown
  extension tools from the model's tool list, validate `bash` with a strict
  fail-closed read-only shell policy, and block every disallowed call in a
  `tool_call` hook.
- Working modes (`build`, `debug`, `yolo`) restore full access.
- The current mode is injected into the system prompt on every turn and
  displayed in the status line.
- The mode is **persisted in the session file** and restored when the session
  is resumed (fork-aware).

```
Ⓜ build 🔒   ← footer status badge (🔒 only for read-only modes)
ask          ← widget directly above the input bar (TUI)
```

## Features

| Feature | Description |
| --- | --- |
| 6 built-in modes | `ask`, `plan`, `build` (alias `act`), `review` (alias `audit`), `debug` (alias `fix`), `yolo` (aliases `autopilot`/`go`) |
| Per-mode thinking level | `plan`, `review`, `ask` and `debug` force high reasoning via `pi.setThinkingLevel()`; the previous level is restored when you leave |
| Plan-step tracking | In `plan` mode the model's numbered `Plan:` steps are extracted into a progress widget (☐/☑) and the footer shows `📋 n/m`; `[DONE:n]` marks steps complete during execution |
| Plan → build transition | After a plan is detected, an interactive prompt offers to switch to `build` and inject the plan as a kickoff message |
| Mode widget | The current mode name is displayed right above the input bar, so you always see where you are |
| Defense-in-depth read-only enforcement | `pi.setActiveTools()` removes write/unknown tools per policy + a strict shell validator + a `tool_call` hook blocks everything else with a visible reason |
| `/mode` command | List, switch, aliases, autocomplete (`/mode <TAB>`) |
| Quick cycle | `alt+m` cycles to the next mode with instant visual feedback |
| `/mode back` | Return to the previous mode (toggle semantics, also `ctrl+alt+m`) |
| Persistence | Mode and plan progress are written to the session (`pi-modes` entries), restored on resume and branch navigation, including forked sessions |
| Config | Per-project `.pi/modes.config.json` (trust-guarded) + global `~/.pi/agent/modes.config.json` |
| `--modes <name>` flag | Start a session in a specific mode |
| Structured plan completion | Plan mode exposes `pi_modes_plan_complete` for explicit, validated plan handoff; legacy `Plan:` parsing remains supported |
| Plan lifecycle commands | `/mode plan show`, `save`, `export [path]`, and `implement` manage accepted plans without requiring a TUI dialog |
| Per-mode instructions | Every mode has its own system-prompt section; override/extend via config |

## Installation

Requires pi ≥ 0.83 (tested on 0.83.0).

```sh
# from npm
pi install npm:pi-agent-modes

# or from a local checkout
pi install ./pi-agent-modes

# or load without installing (any single session)
pi -e ./pi-agent-modes -p "…"
```

The extension is picked up automatically on the next session. Verify with:

```sh
/mode
```

## Usage

| Action | Command / shortcut |
| --- | --- |
| Show current mode | `/mode` |
| Switch mode | `/mode plan` |
| Show current plan | `/mode plan show` |
| Save plan state | `/mode plan save` |
| Export plan | `/mode plan export [path]` |
| Implement accepted plan | `/mode plan implement` |
| Cycle to next mode | `alt+m` (ask → plan → build → review → debug → yolo → ask) |
| Return to previous mode | `/mode back` or `ctrl+alt+m` |
| Aliases | `act` = `build`, `audit` = `review`, `fix` = `debug`, `autopilot`/`go` = `yolo` |
| Start in a mode | `pi --modes review` |

`alt+m` was chosen because `tab`, `alt+tab` and `ctrl+tab` are already taken
by the input/autocomplete, the OS and the terminal. It is free in pi's
default keybindings and acts as a mode cycler: each tap moves to the next
mode, and the widget above the input bar updates instantly.

### The modes

| Mode | Read-only | Thinking | Description |
| --- | --- | --- | --- |
| `ask` | 🔒 yes | high | Discussion, questions, explanation. No file changes, read-only bash. |
| `plan` | 🔒 yes | high | Explore, research, produce an implementation plan (steps auto-tracked). No file changes. |
| `build` | no | — | Implement features. Full tool access. |
| `review` | 🔒 yes | high | Structured code review (P0/P1/P2 severity). Read-only. |
| `debug` | no | high | Systematic reproduction + root-cause analysis + minimal fixes. Full access. |
| `yolo` | no | — | Autonomous end-to-end work. Full access, minimal confirmations. |

### Read-only enforcement (defense in depth)

1. **Tool list** — on entering a read-only mode the extension captures the
   active tool set and removes `edit` and `write` (and `bash` when the policy
   is `deny`). The model cannot even see the tools. The set is restored on
   leaving the mode.
2. **`tool_call` hook** — every tool call is evaluated against the mode policy.
   Blocked calls return `{ block: true, reason }`; the model sees
   `[modes] Blocked by mode "ask": …` and can adapt. This covers `bash`
   heuristics, `blockTools` entries, and unknown custom tools.
3. **System prompt** — a `[ACTIVE MODE: …]` header plus the mode's
   instructions are appended to the system prompt on every turn.

> ⚠️ Pi has no native permission system. Read-only enforcement is implemented
> entirely by this extension, at the extension layer. It protects the current
> session's model from writing — it is not a security sandbox against a
> malicious process, and `user_bash` (your own shell) is intentionally not
> guarded.

## Configuration

Config files are JSON with this shape:

```jsonc
{
  "defaultMode": "build",            // optional, default "ask"
  "modes": {
    "plan": {
      "enabled": true,               // optional, default true
      "description": "…",            // optional, shown in /mode
      "instructions": "…",           // optional, replaces the built-in section
      "extraInstructions": "…",      // string or string[], appended to the built-in section
      "allowWriteTools": false,      // optional (read-only modes default false)
      "bash": "readOnly",            // optional: "allow" | "readOnly" | "deny"
      "allowTools": [],              // optional: always-allowed tool names
      "blockTools": ["read"],        // optional: tools the hook must block
      "blockUnknownTools": true,     // optional: block all non-builtin tools (default in read-only modes)
      "thinkingLevel": "high"        // optional: force a reasoning level (off|minimal|low|medium|high|xhigh|max; null to clear)
    }
  }
}
```

Locations (both are merged, project wins):

- Global: `~/.pi/agent/modes.config.json`
- Project: `.pi/modes.config.json` — loaded only when the project is trusted
  (`ctx.isProjectTrusted()`).

### Policy evaluation order

`allowTools` → `blockTools` → `edit`/`write` (`allowWriteTools`) → `bash`
policy → `blockUnknownTools` (`true` by default in read-only modes; `allowTools` always wins).

### Example: lock down `debug` to fixes only

```json
{
  "modes": {
    "debug": {
      "extraInstructions": "Only fix the reported bug. Never add features or refactor unrelated code.",
      "blockTools": ["web_search"]
    }
  }
}
```

## Thinking levels

Some modes force a reasoning level via `pi.setThinkingLevel()` so the model
thinks harder about the kind of task the mode is for:

| Mode | Forced level |
| --- | --- |
| `ask` | `high` |
| `plan` | `high` |
| `review` | `high` |
| `debug` | `high` |
| `build` | _(unchanged — respects your choice)_ |
| `yolo` | _(unchanged — respects your choice)_ |

The level you had before entering a forced mode is restored when you leave it.
Override or clear per mode in `modes.config.json`:

```json
{
  "modes": {
    "yolo": { "thinkingLevel": "medium" },
    "ask": { "thinkingLevel": null }
  }
}
```

## Plan-step tracking

While `plan` mode is active, the preferred completion path is the standalone
`pi_modes_plan_complete` tool. It accepts the complete Markdown plan and a
validated `steps` array. Legacy assistants that produce a numbered plan under a
`Plan:` header remain supported.

- The transition prompt is shown only after the complete agent run settles, so
  tool calls, retries and compaction cannot trigger it prematurely.
- Choosing *Execute* switches to `build` and injects the remaining steps as a
  kickoff message.
- During execution the model marks each step complete with a `[DONE:n]` tag;
  the widget updates live and progress is persisted.

This mirrors pi's built-in `plan-mode` example, adapted to the multi-mode model.


## Behavior notes

- **Persistence**: the mode and plan progress are stored in the session file as
  versioned `pi-modes` entries and restored on resume, forks, and `/tree`
  navigation. A fresh session (`/new`) starts at the default mode.
- **`/mode back`** remembers only the *previous* mode (a single pointer, not a
  stack). Switching A→B→C then `back` returns to B; the next `back` returns to C.
- **`--modes <name>`** is read once at startup; it overrides `defaultMode` for
  that session only.
- **Mode widget**: the name above the input bar is TUI-only (`ctx.ui.setWidget`,
  placement `aboveEditor`). In print/RPC modes it is skipped, and the footer
  status badge `Ⓜ mode 🔒` remains the source of truth.

## Security boundary

Pi extensions run with the permissions of the Pi process and Pi has no built-in
OS sandbox. The read-only policy is defense in depth against model tool calls:
it does not guard your own `!`/`!!` commands, malicious processes, or arbitrary
code already running on the machine. For untrusted repositories or unattended
work, use a container, VM, or other OS-level sandbox.

Read-only bash intentionally fails closed for shell lists, redirects, command
substitution, opaque wrappers, mutating flags, and commands outside its reviewed
allowlist. Add custom tools explicitly with `allowTools` when you have reviewed
their behavior:

```json
{
  "modes": {
    "plan": {
      "allowTools": ["web_search", "lsp_diagnostics"]
    }
  }
}
```

## Development

```sh
npm install        # peer deps for types + e2e driver
npm test           # unit tests (node --test, no test framework needed)
npm run typecheck  # tsc --noEmit
node e2e/driver.mjs          # E2E: commands + persistence (RPC, no LLM)
node e2e/driver.mjs --llm    # + real-LLM blocking/write checks
```

The E2E driver spawns real pi RPC sessions, switches modes, verifies state
entries, restarts a session to check persistence, and (with `--llm`) proves
that a blocked tool call returns `Blocked by mode` while write tools are
unavailable in `ask` and available in `build`.

## Publishing to npm

```sh
npm login
npm version 0.3.0        # create the 0.3.0 release commit and tag
npm publish                # tarball: extensions/, src/, README.md, CHANGELOG.md, LICENSE
```

The package follows the pi package conventions (`docs/packages.md`): the
`pi.extensions` manifest points at `./extensions`, and pi core packages are
`peerDependencies` (`"*"`). No runtime dependencies.

## Compatibility

- Tested with pi **0.83.0** (`@earendil-works/pi-coding-agent`), node 22.
- The `--modes` flag name avoids clashing with pi's own `--mode` flag.
- Shortcuts: `alt+m` (cycle) and `ctrl+alt+m` (back) are free in pi's default
  keybindings — `tab`/`alt+tab`/`ctrl+tab`/`shift+tab` are not.

## License

MIT
