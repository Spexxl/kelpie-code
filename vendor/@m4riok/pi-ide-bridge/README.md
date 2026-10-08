# Pi IDE Bridge

Pi IDE Bridge connects the Pi coding agent to VS Code. Pi pauses before touching your files, opens a native diff, and waits for you to approve or reject. It also feeds your current editor state into Pi automatically so the agent always knows what you are looking at.

## What you get

- **Change review** — Pi shows every proposed file edit as a VS Code diff before anything is written to disk. You approve or reject. 
- **Auto-accept mode** — press `F8` to let Pi apply edits without pausing. Press `F8` again to switch back to review mode.
- **Editor context** — Pi automatically knows which files you have open, which is active, where your cursor is, and what text you have selected. 
- **Diagnostics on demand** — Pi can query VS Code's current errors and warnings via the `get_ide_diagnostics` tool, scoped to the active file, a specific file, or all open files.

## Installation

### Step 1 — Install the Pi extension

```
pi install npm:@m4riok/pi-ide-bridge
```

Restart your Pi session after installing.

### Step 2 — Install the VS Code companion

In Pi, run:

```
/ide install
```

This installs the VS Code companion extension automatically. If that fails, see the manual install instructions below.

### Manual VS Code install

Search for **Pi IDE Bridge** in the VS Code Extensions panel, or run:

```
ext install m4riok.pi-ide-bridge-vscode
```

## Commands

| Command | What it does |
|---------|-------------|
| `/ide` or `/ide status` | Show VS Code connection status |
| `/ide install` | Install the VS Code companion extension |
| `/ide context` | Show the current editor context Pi is seeing |
| `/ide diagnostics` | Show diagnostics for the active file |
| `/ide diagnostics all` | Show diagnostics across all open files |
| `/ide diagnostics file <path>` | Show diagnostics for a specific file |

## Keyboard shortcuts

| Key | Action |
|-----|--------|
| `F8` | Toggle between review mode and auto-accept mode |
