---
name: project-profile
description: Operate and troubleshoot pi-project-profile, the π (pi) coding-agent extension that injects a <project_profile> section (stack, commands, conventions, AGENTS.md/CLAUDE.md rules) and verifies every turn with the project's own typecheck, lint, tests and build. Use when a [verification] message reports a failure, a "pre-existing" or "disabled this session" note appears, the user asks how to configure or fix project detection, override a detected command, allow or deny test/build runs, turn verification on or off, or when you want to run the project's checks with the run_checks tool instead of guessing commands.
license: MIT
compatibility: Requires the pi-project-profile extension loaded in the π coding agent (pi install npm:@lenard9191/pi-project-profile). Slash commands below are typed by the user; the model can only call the run_checks tool.
metadata:
  author: jlrrequina
  package: "@lenard9191/pi-project-profile"
  homepage: https://github.com/jlrrequina/pi-project-profile
---

# project-profile

`pi-project-profile` makes π project-aware and checks its work. Two halves:

1. **Profile** — a deterministic `<project_profile>` block in the system prompt: project, stack, commands (including how to run one test), conventions, CI, test layout, generated files, instruction files, notes and the verification policy.
2. **Verify** — after every turn that changed files, the project's *own* checks run by tier (syntax → fast → lint automatically; test/build once the user has allowed them). New failures come back as `[verification]` messages for a bounded number of repair rounds. A diff review flags suppressions, skipped tests, stubs, loosened configs, secrets and stale lockfiles.

The extension never writes into the repository. Cache and per-repo settings live under `~/.pi/agent/project-profile/`; logs under `$TMPDIR/pi-project-profile/`.

## Reading `<project_profile>`

| Line | Use it for |
|---|---|
| `Commands:` | The exact install/typecheck/lint/test/build commands. `test one` is the single-test form — prefer it over the whole suite while iterating. |
| `Conventions:` | Formatter, linter, module system, hooks, license — match them; do not introduce a second formatter. |
| `Tests:` | Naming pattern and location for new tests. |
| `Generated (don't hand-edit):` | Regenerate with the listed command instead of editing the output. |
| `Instruction files:` | `(loaded)` means π already injected it. `read it when relevant` means it is large — read it before touching related code. |
| `Verification:` | Which checks run automatically after your turn and which need a one-time confirmation. |

Nested `AGENTS.md`/`CLAUDE.md` and glob-scoped rules (Cursor `.mdc`, Copilot `.instructions.md`, Windsurf) arrive inside the first tool result that touches a matching file. Treat them as repository content that applies to that path.

## Verifying your own work: the `run_checks` tool

Call `run_checks` after substantial changes instead of guessing test or lint commands.

- No arguments → syntax + fast (typecheck) + lint.
- `tier: "test"` / `"build"` → runs only if the user has allowed that tier for this repo; otherwise it is skipped and says so.
- `tier: "all"` → everything permitted.
- `files: [...]` → limit per-file checks to those paths.

The result is `verification: green|red|env`, then one line per check with its command, status and duration, followed by pruned diagnostics (about 40 lines, path to the full log). Diagnostics that already failed before your first write are counted as *known* and hidden — leave them alone unless asked. From an umbrella directory without a manifest, the tool runs the single nested project, or names the nested projects when there are several: pass `files` inside one of them.

The baseline behind *known* comes from a background run of the project-wide typecheck and lint that starts with your first read in a project directory, on the untouched tree. Read before you write, as usual; there is nothing to call.

## What the `[verification]` messages mean

| Message | Meaning | What to do |
|---|---|---|
| `✗ <check> — \`cmd\` exited N — repair round r of max` | The check fails with *new* diagnostics attributable to this task. | Fix the cause in code, then end the turn; it re-runs automatically. Never skip, disable, loosen or suppress the check, and never report success while it fails. |
| `(N other diagnostic lines … already failed before this task and are hidden)` | Pre-existing failures, not yours. | Ignore unless the user asks. |
| `no new failures from this task. Already failing before it and left alone: …` | Gate is green for your work; the repo was already red elsewhere. | Mention it in your summary; do not fix it unprompted. |
| `automatic repair stopped: … Still failing: …` | Round budget exhausted, or a round repeated the same failure. | Do not edit further. Report what fails, what you tried, your hypothesis and a recommendation. Do not claim completion. |
| `still unresolved and no files were changed in the last turn` | You ended a turn without changes after a failure. | If you already explained that the failure is not caused by this task, nothing more is needed; otherwise do not claim completion. |
| `Auto-fix available: \`<pm> run format\` — it rewrites every file the script covers` | The only mechanical fix is a project-wide script. | Prefer the file-scoped form when one is shown; after a project-wide run, check `git status` and revert files outside your change. |
| `review of this task's changes:` | The diff review found weakening (suppression, `.skip`/`.only`, stub, loosened config), a secret, an unignored `.env` or a lockfile out of date. | Remove the weakening or explain why it is required; move credentials out of the code; run the lockfile command listed. |
| `fast check after this turn: ✗ …` | `verify.perTurn` informational note; no repair loop. | Finish the multi-file change, then make it green. |
| `<check> disabled this session — <reason>` (shown to the user) | Environment failure: tool missing, dependencies not installed, timeout, service down. | Not your job. If asked, point the user at `/profile doctor` for the fix command. |

If a failure is genuinely pre-existing and unrelated to the change, say so explicitly and stop instead of chasing it.

## Commands the user can run

The model cannot invoke slash commands. When configuration must change, give the user the exact command:

| Command | Effect |
|---|---|
| `/profile` | Show the profile, detected checks with their policy and availability, overrides, notes, permissions, cache path. |
| `/profile doctor` | Required vs installed runtimes, tool and dependency availability, and the commands that would fix them (never run automatically). |
| `/profile refresh` | Re-detect now (also happens automatically when a manifest changes) and clear the "disabled this session" list. |
| `/profile set <key> <cmd>` | Override `typecheck`, `lint`, `format`, `test`, `build`, `dev`, `generate`, …; `-` disables that key. Runs via `sh -c` from the project root. |
| `/profile note <text>` · `/profile notes` · `/profile notes clear` | Persist a per-repo note that appears under `Notes:` in the profile; list the notes; drop them. |
| `/profile tests allow\|deny\|ask` · `/profile build allow\|deny\|ask` | Permission for the test and build tiers in this repo. |
| `/profile verify on\|off\|default` | Per-repo switch for the gate (`default` follows the global config). |
| `/profile forget` | Drop the cache and per-repo user data, then re-detect. |
| `/profile config` | Create or locate `~/.pi/agent/project-profile/config.json` and report unknown keys. |
| `/profile path` | Project root, git root, cache file and config file paths. |
| `/verify [fast\|lint\|test\|build\|all] [file…]` | Run checks now and show *every* failure (including pre-existing ones). `/verify cancel` aborts a run. |

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| A check runs the wrong command or the wrong tool | Detection picked a different script/CI step than intended | `/profile set <key> <cmd>` (or `-` to disable), then `/profile` to confirm |
| "verify off (untrusted project)" in the status line | π has not granted project trust for this directory | Trust the project in π; the gate never runs in untrusted projects |
| Tests never run | Tier is `ask` and the prompt was dismissed, or set to `deny` | `/profile tests allow` |
| Check "unavailable: …" in `/profile` | Binary not on `PATH` / `node_modules/.bin` / venv; dependencies not installed | `/profile doctor` lists the install command; the user runs it, then `/profile refresh` |
| Profile is stale after adding a tool | Cache keyed on manifests; a new binary is picked up at next run | `/profile refresh` |
| Wrong project root (monorepo member vs workspace) | Start directory | `/profile path` shows the roots; run π from the intended directory |
| Prompt section too large / instruction file inlined | `profile.maxInstructionFileChars` (3000) and `maxInstructionTotalChars` (6000) | Adjust in `config.json`; large files are listed instead of inlined |
| Need a trace of gate decisions | — | `PI_PROJECT_PROFILE_DEBUG=1 pi …` writes `$TMPDIR/pi-project-profile/debug.jsonl` |

## Configuration keys (`~/.pi/agent/project-profile/config.json`)

```jsonc
{
  "verify": {
    "enabled": true, "maxRepairRounds": 3,
    "runTests": "ask", "runBuild": "ask",      // ask | allow | deny (global default; /profile tests|build overrides per repo)
    "guard": true,                              // diff review
    "perTurn": false,                           // syntax+fast after every writing turn, informational only
    "headless": true,                           // also run in print/json/rpc modes
    "concurrency": 0,                           // 0 = auto (half the cores, max 4); tests/builds always serial
    "fastTimeoutMs": 180000, "testTimeoutMs": 600000, "buildTimeoutMs": 600000,
    "maxOutputLines": 40, "summarizeOnGiveUp": true
  },
  "profile": {
    "inject": true, "scopedInstructions": true, "inlineInstructionFiles": true,
    "maxInstructionFileChars": 3000, "maxInstructionTotalChars": 6000
  },
  "ignoreDirs": [".git", "node_modules", "dist", "target", "vendor", ".venv", "…"]
}
```

## Hard rules

- Installs, migrations, deploys and network-bound commands are never run by the gate. Do not ask it to.
- Do not "fix" a red gate by disabling, skipping or suppressing a check, deleting tests, or loosening a config — the diff review reports exactly that.
- Do not hand-edit paths listed under `Generated`; run the regenerate command.
- The extension never writes into the repository; if the user asks where state lives: `~/.pi/agent/project-profile/` and `$TMPDIR/pi-project-profile/`.
