# @dreki-gg/pi-ask-mode

Read-only ask mode for [pi](https://github.com/badlogic/pi-mono). Toggle with `/ask` — pi can read, search, and answer but cannot create, edit, or delete files.

## Install

```bash
pi install npm:@dreki-gg/pi-ask-mode
```

## Usage

| Feature | Name | Notes |
|---|---|---|
| Flag | `--ask` | Start pi in ask mode |
| Command | `/ask` | Toggle ask mode on/off |
| Shortcut | `Ctrl+Alt+A` | Toggle ask mode |

Start in ask mode:

```bash
pi --ask
```

Toggle inside pi:

```text
/ask
```

Enter ask mode and send a prompt in one step:

```text
/ask How does authentication work in this codebase?
```

Run `/ask` again to exit ask mode.

## Allowed

- `read` — Read file contents
- `bash` — Read-only commands only (`ls`, `grep`, `cat`, `git status`, `git log`, etc.)
- `grep` — Search file contents
- `find` — Find files by pattern
- `ls` — List directories

## Blocked

- `edit` — File editing
- `write` — File creation/overwriting
- Destructive bash commands — `rm`, `mv`, `cp`, `mkdir`, `git commit`, `git push`, `npm install`, redirects, editors, and similar commands

## How it works

Ask mode uses two layers of protection:

1. **Tool whitelist** — Only read-only tools are exposed to the LLM via `setActiveTools()`.
2. **Defense-in-depth** — A `tool_call` handler blocks `edit`, `write`, and destructive bash commands even if the LLM somehow attempts them.

Ask mode has no end-of-turn menu and creates no `.plans/` files. It stays active until you run `/ask` again.

State persists across session restarts and tree navigation.

## Difference from pi-modes

[`@dreki-gg/pi-modes`](https://github.com/dreki-gg/pi-extensions/tree/main/packages/modes) provides configurable presets that can also restrict tools. Use pi-modes if you want multiple configurable modes with model/thinking presets. Use pi-ask-mode if you just want a simple dedicated read-only toggle.
