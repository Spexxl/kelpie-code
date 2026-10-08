# pi-project-profile

**Project-aware π (pi) coding agent, with a verification gate.** A [π](https://pi.dev) extension that detects any repository's stack, commands, conventions and instruction files (`AGENTS.md`, `CLAUDE.md`, `.cursorrules`, …), injects them as a stable `<project_profile>` system-prompt section, and then runs the project's *own* typecheck, lint, tests and build after every agent turn — with a bounded self-repair loop and a review of the agent's diff.

[![npm version](https://img.shields.io/npm/v/@lenard9191/pi-project-profile)](https://www.npmjs.com/package/@lenard9191/pi-project-profile)
[![npm downloads](https://img.shields.io/npm/dm/@lenard9191/pi-project-profile)](https://www.npmjs.com/package/@lenard9191/pi-project-profile)
[![π package](https://img.shields.io/badge/pi.dev-package-8A2BE2)](https://pi.dev/packages/@lenard9191/pi-project-profile)
[![CI](https://github.com/jlrrequina/pi-project-profile/actions/workflows/ci.yml/badge.svg)](https://github.com/jlrrequina/pi-project-profile/actions/workflows/ci.yml)
[![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/jlrrequina/pi-project-profile/badge)](https://scorecard.dev/viewer/?uri=github.com/jlrrequina/pi-project-profile)
[![license](https://img.shields.io/npm/l/@lenard9191/pi-project-profile)](LICENSE)

```bash
pi install npm:@lenard9191/pi-project-profile
```

![pi-project-profile: the injected project profile and the verification of an agent turn](https://raw.githubusercontent.com/jlrrequina/pi-project-profile/main/docs/cover.png)

- **Profile**: detects the stack, commands (including how to run one test), conventions, CI checks, test layout, generated code and instruction files (`AGENTS.md`, `CLAUDE.md`, `.cursorrules`, Copilot, Windsurf, Cline, Gemini, Codex, …), and injects them as a stable `<project_profile>` system-prompt section.
- **Verify**: after every turn that changed files, runs the project's *own* checks and sends new failures back to the agent for a bounded number of repair rounds.
- **Review**: flags what a reviewer would want to know about the agent's diff: added suppressions, skipped or focused tests, stubs, loosened configs, deleted tests, secrets, unignored `.env` files, stale lockfiles.
- **Rules on demand**: delivers nested `AGENTS.md` files and glob-scoped rules (Cursor, Copilot, Windsurf) when the agent first touches a file they apply to, and warns before hand-editing generated files.

It never writes into the repository. Cache and settings live under `~/.pi/agent/project-profile/`.

## Why

A coding agent dropped into an unfamiliar repository guesses: which package manager, which test runner, whether `tsc` or `biome` is the source of truth, where tests live, which files are generated. Then it reports "done" without having run anything, or runs the wrong thing. pi-project-profile answers those questions once per repository, keeps the answer stable so prompt caching works, and turns "done" into "the project's own checks pass" — without ever running installs, migrations or deploys on its own.

## How it works

1. **Session start** — the repository is scanned (manifests, lockfiles, CI files, Makefiles, instruction files; nothing is executed), cached under `~/.pi/agent/project-profile/`, and rendered as `<project_profile>` in the system prompt. Re-detection happens automatically when a manifest changes.
2. **Each turn** — files the agent touches are tracked; nested `AGENTS.md`/`CLAUDE.md` and glob-scoped rules that apply to them are delivered with the first matching tool result; generated files get a warning. The agent's first read in a project directory starts that project's typecheck and lint once, in the background, on the untouched tree: whatever already fails there is the baseline, so it is never blamed on the agent (a run that finishes after the agent's first write is discarded).
3. **Before the turn settles** — if files changed, the syntax, typecheck and lint tiers run (tests and builds once you have allowed them for the repo). New failures go back to the agent as a `[verification]` message for at most three repair rounds; pre-existing failures are reported to you once and never blamed on the agent. The diff review runs alongside.

## Install

```bash
pi install npm:@lenard9191/pi-project-profile
```

Requires π ≥ 0.87 and Node ≥ 22.18. No runtime dependencies. Update with `pi update npm:@lenard9191/pi-project-profile`. Try it once without installing: `pi -e npm:@lenard9191/pi-project-profile`.

The package ships one extension and one [Agent Skill](https://agentskills.io) (`skills/project-profile`): an operating and troubleshooting guide the model loads on demand when a verification message needs interpreting or you ask how to configure the extension. `/skill:project-profile` loads it explicitly.

## What the agent sees

```
<project_profile>
- Project: zod — ~/projects/zod · remote github.com/colinhacks/zod · ~741 tracked files
- Stack: monorepo: pnpm workspaces (8 packages) · pnpm · Vite · Vitest
- Commands: install `pnpm install` · typecheck `pnpm exec tsc --noEmit -p tsconfig.json` · lint `pnpm run lint` · test `pnpm run test` · test one `pnpm exec vitest run <file> -t "<name>"`
- Conventions: ESM · Prettier · Biome · Husky git hooks · License: MIT
- Tests: `*.test.ts` in tests/ (202)
- Instruction files: AGENTS.md (loaded) · .cursorrules (22 KB — read it when relevant)
- Verification: after each turn that changed files, the harness runs `pnpm exec tsc --noEmit -p tsconfig.json`, `pnpm run lint:check` automatically; asks once before running tests
</project_profile>
```

The section is identical for every turn of a session, so prompt caching keeps working.

## Verification

| Tier | Examples | Policy |
|---|---|---|
| syntax | `node --check`, `python -c ast.parse`, `ruby -c`, `bash -n`, JSON parse | automatic, changed files only |
| fast | `tsc --noEmit`, `cargo check`, `go build`/`go vet`, `mypy`/`pyright`, `mix compile`, `dart analyze` | automatic |
| lint | `eslint`, `biome`, `prettier --check`, `ruff`, `cargo fmt --check`/`clippy`, `gofmt`, `rubocop`, `swiftlint` | automatic |
| test | `npm test`, `cargo test`, `pytest`, `go test`, `rspec`, `mix test`, `phpunit`, `swift test`, `./gradlew test` | confirmed once per repo |
| build | `pnpm build`, `./gradlew compile*`, `swift build`, `zig build`, `cmake --build` | confirmed once per repo |

Installs, migrations, deploys and anything network-bound are never run.

- **Only new failures cost repair rounds.** Diagnostics recorded before the agent's first write (a repo that was already red) are pre-existing: not sent back to the agent, noted once for you, and they don't block the tests. The baseline comes from a background run of the project-wide typecheck and lint, started by the agent's first read in each project directory (at most four per session; workspace-wide scripts such as `turbo run lint` are not started this way).
- **Narrowed runs.** Tests run as `vitest related`, `jest --findRelatedTests`, `go test ./<pkg>/...`, `cargo test -p <package>` or `pytest <changed test files>` when that is safe; `cargo check` drops `--all-targets` when no test/bench/example code changed. Monorepo packages are checked in their own directory with their own scripts, and a workspace-wide root run replaces the per-package duplicates.
- **Fast.** Read-only checks in a tier run in parallel; tests and builds run one at a time.
- **Actionable failures.** Diagnostic lines first (~40 lines, full log path), plus the exact auto-fix command for format/lint failures (`prettier --write <files>`, `ruff check --fix <files>`, …).
- **Bounded.** At most `maxRepairRounds` (3); stops early when a round changes nothing or repeats the same failure, then asks the agent for a summary. Environment failures (missing tool, deps not installed, timeout, database down) go to *you* and disable that check for the session.

## Review of the agent's changes

Compared with the content before the agent's first write (or git `HEAD`; files that were already dirty are never blamed on the agent):

- `@ts-ignore`, `eslint-disable`, `# type: ignore`, `# noqa`, `#[allow]`, `//nolint`, `@Suppress`, … added
- tests skipped (`.skip`, `xit`, `@pytest.mark.skip`, `t.Skip`, `#[ignore]`) or focused (`.only`), test files deleted, test cases removed
- stubs left in (`raise NotImplementedError`, `todo!()`, `throw new Error("not implemented")`)
- checks loosened in config (`"strict": false`, ESLint rules `"off"`, `continue-on-error: true`, `|| true` in scripts)
- secrets (AWS, GitHub, OpenAI/Anthropic, Slack, Stripe, Google, npm, Hugging Face keys, private keys; values are never repeated), `.env` files that are not gitignored
- dependency changes without a lockfile update (`pnpm install`, `uv lock`, `go mod tidy`, …)

Secrets, stale lockfiles and `.only` get one follow-up turn; weakening added while checks were failing gets one follow-up turn; everything else is shown to you.

## Commands and tool

| | |
|---|---|
| `/profile` | show the profile, checks, availability and cache path |
| `/profile doctor` | required vs installed runtimes, tool and dependency availability, fix commands (never run) |
| `/profile refresh` | re-detect (also automatic when a manifest changes) |
| `/profile set <key> <cmd>` | override `typecheck`, `lint`, `test`, `build`, … (`-` disables) |
| `/profile note <text>` | persist a per-repo note for the agent (`/profile notes` lists them, `/profile notes clear` drops them) |
| `/profile tests allow\|deny\|ask` | test-tier permission (same for `build`) |
| `/profile verify on\|off` | per-repo switch for the gate |
| `/profile forget` | drop cache and user data for this repo |
| `/verify [fast\|lint\|test\|build\|all] [file…]` | run checks now, showing every failure (`/verify cancel` aborts) |
| `run_checks` | the same, as a tool the model can call mid-task; at an umbrella directory without a manifest it runs the single nested project, or names the nested projects when there are several |

## Configuration

`~/.pi/agent/project-profile/config.json` — create it with `/profile config`. Main keys:

```jsonc
{
  "verify": { "enabled": true, "maxRepairRounds": 3, "runTests": "ask", "runBuild": "ask", "guard": true, "perTurn": false, "concurrency": 0 },
  "profile": { "inject": true, "scopedInstructions": true, "maxInstructionFileChars": 3000 }
}
```

`verify.perTurn` also runs the syntax + fast tiers after every turn that changed files and adds a short informational note when red (no repair loop: multi-file edits are legitimately red half-way). `PI_PROJECT_PROFILE_DEBUG=1` writes a JSONL trace to `$TMPDIR/pi-project-profile/`.

## Design rules

- Nothing is hardcoded per project; every capability degrades detected → generic → no-op, never to a wrong action.
- Only read-only checks run unprompted. The gate runs only in projects π reports as trusted.
- Tools are bound late (`node_modules/.bin`, `uv run`/`poetry run`/`.venv`), so the profile stays valid before and after installs.
- Repository instructions are framed as repository content, inlined only when small, and skipped when they read like a bot directive.

## Coverage

Node/TypeScript (npm, pnpm, yarn, bun; workspaces, Turborepo, Nx), Deno, Rust, Go, Python (uv, poetry, pdm, pipenv, hatch), Ruby, JVM (Gradle, Maven, Kotlin, Android), .NET, Swift, PHP, Elixir, Dart/Flutter, C/C++ (CMake, Meson), Zig, Haskell, Scala, OCaml, Gleam, Erlang, Terraform, shell, Lua, Perl, plus Makefile/justfile/Taskfile targets, Bazel, CI (GitHub Actions, GitLab, CircleCI, Azure, Travis, Jenkins, Buildkite, Bitbucket), docker-compose services and umbrella repos. Tested on macOS, Linux and Windows.

Instruction files: `AGENTS.md`, `AGENTS.override.md`, `CLAUDE.md` (root and nested), `.cursorrules`, `.cursor/rules/*.mdc`, `.github/copilot-instructions.md`, `.github/instructions/*.instructions.md`, `.windsurfrules`, `.windsurf/rules`, `.clinerules`, `.roo/rules`, `.agents/rules`, `GEMINI.md`, `CONVENTIONS.md`, `.junie/guidelines.md`, `.codex/instructions.md`, `codex.md`, `.continuerules`, `.aider.conf.yml`.

## FAQ

### Does it work with Claude Code, Cursor, Codex or GitHub Copilot?

It is an extension for the π coding agent only. It does read the instruction files those tools use (`CLAUDE.md`, `.cursorrules`, `.cursor/rules`, `copilot-instructions.md`, `.github/instructions`, Windsurf and Cline rules, `GEMINI.md`, `codex.md`), so a repository already set up for them is understood by π with no extra configuration.

### Does it change anything in my repository?

No. Detection is read-only, the cache and per-repo settings live under `~/.pi/agent/project-profile/`, logs under `$TMPDIR/pi-project-profile/`. The automatic checks are the project's own read-only commands; auto-fix commands are suggested, never run.

### Will it run my tests or builds automatically?

Only after you allow it once per repository (`/profile tests allow`, or answer the prompt the first time). Typecheck and lint run automatically because they are read-only. Installs, migrations, deploys and anything that needs the network are never run.

### What happens when a check fails?

The failing diagnostics (pruned to ~40 lines, with the full log path and an auto-fix hint) go back to the agent, which must fix the cause — not disable the check — and end its turn; the checks re-run. After three rounds, or when a round changes nothing or repeats the same failure, the loop stops and the agent summarizes what is still failing instead of claiming success.

### My repo was already failing before the agent touched it. Will the agent try to fix that?

No. The project-wide typecheck and lint run once in the background when the agent starts reading, before it writes; what fails then is pre-existing: hidden from the agent, reported to you once ("already fails on the untouched tree"), and it doesn't block the test tier. `/verify` still shows everything.

### Does it break prompt caching?

No. The `<project_profile>` section contains no timestamps, branch names or iteration-order-dependent content, so it is byte-identical for every turn of a session.

### The detected command is wrong. How do I fix it?

`/profile set test "pnpm vitest run"` overrides one key for this repository (`/profile set lint -` disables one); `/profile doctor` explains missing tools; `/profile refresh` re-detects. Persist guidance for the agent with `/profile note "…"`. For a wrong detection worth reporting, include the output of `node scripts/scan.ts <repo> --checks` in the [issue](https://github.com/jlrrequina/pi-project-profile/issues).

### How is this different from an LSP or linter extension?

An LSP-based extension gives the model diagnostics as it edits. pi-project-profile runs the project's *own* commands — the ones CI runs — as a gate after the turn, with a repair loop, a pre-existing-failure baseline and a diff review; it also supplies the profile in the first place. The two are complementary.

### Does it work in headless or scripted π runs?

Yes: `verify.headless` (default `true`) runs the gate in print/JSON/RPC modes too, and test/build tiers that would need a confirmation are skipped instead of blocking.

## Links

- npm: <https://www.npmjs.com/package/@lenard9191/pi-project-profile>
- π package catalog: <https://pi.dev/packages/@lenard9191/pi-project-profile>
- Site: <https://jlrrequina.github.io/pi-project-profile/> · [`llms.txt`](llms.txt) for language models
- [Changelog](CHANGELOG.md) · [Security policy](SECURITY.md) · [Contributing](CONTRIBUTING.md) · [Constraints for changes](AGENTS.md)

## Development

```bash
npm install
npm run check                       # tsc
npm test                            # node --test
node scripts/scan.ts <dir> --checks # print the profile + checks for any directory
```

CI runs the tests on Linux, macOS and Windows (Node 22.18, 24, 26), smoke-tests the packed tarball, and runs detection weekly on ~20 real repositories (`npm run corpus`). Releases are published from GitHub Actions with npm provenance and a signed build attestation. See [AGENTS.md](AGENTS.md) for the constraints every change must keep and [CONTRIBUTING.md](CONTRIBUTING.md) for releasing. MIT © John Lenard Requina
