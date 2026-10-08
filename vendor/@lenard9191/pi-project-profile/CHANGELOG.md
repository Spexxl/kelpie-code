# Changelog

## Unreleased

## 1.3.0 — 2026-10-03

- `/profile` now shows `disabled this session: <reason>` next to a check the gate disabled. The report looked the check up by id while the gate stores `id@cwd` (the doctor already used the right key), so the annotation never appeared.
- A check the gate cannot run (tool missing, dependencies not installed, timeout) is now reported to the model once per session as a `[verification]` message, not only as a UI toast the model never sees. Before, the model kept the prompt's promise that the check runs automatically and could report success without any check having run.
- The prompt section's `Verification:` line no longer promises checks that cannot run yet. When every automatic check is unavailable (typically before the first install), it names the commands and the reason instead of "runs … automatically".
- `run_checks` declares `outputSchema` and returns `structuredContent` (`{ status, runs: [{ id, label, status, exitCode, durationMs, summary }] }`), so codemode scripts calling `tools.run_checks()` get data instead of text (π 1.0.0 extension API). It also declares tool `annotations` (`idempotentHint: true`, not read-only, not destructive) for permission extensions, and reports "verification unavailable" as a tool error.
- A weekly `Host compatibility` workflow typechecks and tests against the latest π release, so an upstream API change shows up without waiting for a Dependabot bump.
- The development dependencies follow π 1.0.0 (`@earendil-works/pi-ai`, `pi-coding-agent`, `pi-tui`); the peer range stays `>=0.87.0`.
- Tests: the mock π API now captures command handlers, so `/profile` (`set`, `tests`, `verify`, `note`, `notes`, `show`, `forget`, unknown subcommands) and `/verify` (`lint`, `cancel`, red result sent to the model) run under test; per-turn checks, the repair loop's two stop conditions, superseded notes, re-delivery of scoped instructions after compaction, and user overrides in `effectiveChecks` are pinned as well.
- Detection: a `run:` step that continues a command with a trailing backslash (`cargo clippy \` + `--all-targets -- -D warnings`) is one command now. Before, the first line alone became the CI run and a lint check that could not execute. `DETECTOR_VERSION` 14.

## 1.2.0 — 2026-09-30

From a review of every gate failure in the author's own sessions: all of them were failures that existed before the task (a monorepo root `tsc` over 552 files, 805 lint warnings and 424 unformatted files on `main`, a stale `dist`), and the agent spent turns and `git stash` proving it.

- **Baseline before the first write.** The agent's first read in a project directory starts that project's project-wide typecheck and lint once, in the background, on the untouched tree (the session root at the first prompt as well; at most four directories per session; workspace-wide scripts such as `turbo run lint` are not started this way). What fails there is the pre-existing baseline for the whole session, so the first prompt is no longer the one where every old failure is blamed on the agent. A run that finishes after a write, a shell change or a new prompt is discarded; a run stopped by the gate never marks a check as disabled. The user sees `already fails on the untouched tree (N diagnostics)` once; the agent sees `no new failures` instead of a repair round.
- Detection: a workspace root whose `tsconfig.json` only extends a base config (no `include`, `files` or `references`) gets no synthesized `tsc --noEmit -p tsconfig.json` — that command compiles every package with the base options (thousands of bogus errors, a 2 MB log per run); typecheck runs per package instead, and the profile says so. `DETECTOR_VERSION` 13.
- Output pruning: eslint's stylish output as `next lint` prints it (`54:13  Warning: …`) and prettier's `[warn] <file>` lines are diagnostics now; the file header above a stylish block is kept with its lines and is part of the baseline key, so the same rule in two files is two known failures. Before, both outputs were reduced to pnpm's `ELIFECYCLE Command failed` line with "805 more lines".
- Fix hints: a failing project-wide format script (`prettier --check .`) suggests `prettier --write <the files you changed>` instead of the project's `format` script, which would rewrite every unformatted file in the tree; when only the project script is available, the hint says it rewrites everything and to check `git status`. Paths with shell-special characters (`app/(admin)/…`) are quoted.
- `run_checks` and `/verify` without files at an umbrella directory (no manifest at the root) run the single nested project, or name the nested projects when there are several, instead of answering "no applicable checks".
- A session started in the home directory gets no profile: nothing is injected into the prompt (the layout of `~` is private and no check can run there), nothing is cached, verification stays off.
- The "no changes since the last failure" message no longer contradicts the instruction to stop when a failure is pre-existing.

## 1.1.0 — 2026-09-29

- **Bundled Agent Skill** `project-profile` (`/skill:project-profile`): an operating and troubleshooting guide the model loads on demand — how to read the `<project_profile>` section, what each `[verification]` message means and what to do, the `run_checks` tool, every `/profile` and `/verify` command, a symptom → fix table and all configuration keys. Declared in the `pi` manifest and listed in the π package catalog as a skill.
- `llms.txt` (llmstxt.org format) at the package root and on the site, linking the README, skill, changelog, contributor and security documents for language models and agents.
- Landing site at <https://jlrrequina.github.io/pi-project-profile/> (static; Open Graph and Twitter cards, `SoftwareApplication`/`SoftwareSourceCode`/`FAQPage` structured data, `sitemap.xml`), published by a pinned Pages workflow.
- README: tagline, downloads and catalog badges, *Why* and *How it works*, the full list of instruction files detected, an FAQ (Claude Code/Cursor/Codex/Copilot compatibility, repository safety, tests, prompt caching, overriding a detection, headless runs) and links.
- Fixed: the npm description was 503 characters and the registry stores 255, so npm search, the package page and the π catalog cut it mid-sentence ("…verifies the agent's changes after"). It is now 248 characters and front-loaded. Keywords reworked (`agents-md`, `claude-md`, `cursorrules`, `copilot-instructions`, `guardrails`, `context-engineering`, …).
- Releases attach the tarball's provenance bundle as `<tarball>.intoto.jsonl` (SLSA v1 statement, signature, certificate and transparency-log entry), verified in the workflow before publishing; `gh attestation verify <tarball> --bundle <tarball>.intoto.jsonl -R jlrrequina/pi-project-profile` checks a download without GitHub's attestation store. See SECURITY.md.
- Property-based tests (`test/properties.test.ts`, [fast-check](https://fast-check.dev), dev dependency only): the release version order and changelog moves, the pre-existing-failure baseline (line numbers, timings, CRLF, output order and trailing whitespace never make a known failure new; counts are a multiset difference), secrets never echoed by the diff review, and the prompt section's independence from volatile fields and from the order or path separators of π's loaded-file list.
- Tests guard the discoverability metadata: description length, catalog keyword and manifest entries, skill frontmatter (name = directory, limits, documented commands and config keys exist), `llms.txt` structure and link targets, site ↔ sitemap ↔ workflow agreement; the tarball smoke test requires the skill and `llms.txt`.

## 1.0.1 — 2026-09-29

- Fixed: paths from tool calls are resolved through symlinks, so files in a symlinked checkout are grouped with their project, shown relative to it and attributed correctly by the review of changes.
- Fixed: the "N known" count of pre-existing failures no longer includes package-manager wrapper lines (`npm error Lifecycle script … failed`).
- Releases are published from GitHub Actions: npm trusted publishing with provenance for the tagged commit, and the same tarball, with a build attestation, on the GitHub release.

## 1.0.0 — 2026-09-29

- **Pre-existing failures.** Diagnostics recorded before a prompt form its baseline (normalised: no line numbers or timings, error codes kept, counted as a multiset). Only new diagnostics make the gate red, reach the agent and form the no-progress signature; a check that fails only with known diagnostics is reported once to the user, does not cost a repair round and no longer blocks the test tier. `/verify` still shows everything.
- **Review of the agent's changes** (`verify.guard`): added suppressions (`@ts-ignore`, `eslint-disable`, `# type: ignore`, `# noqa`, `#[allow]`, `//nolint`, …), skipped or focused tests, stubs, loosened check configs, deleted test files and removed test cases, secrets (masked, never echoed), unignored `.env` files and dependency changes without a lockfile update. Attribution uses the content captured before the agent's first write, or git `HEAD` for files that were clean when the prompt started. Secrets, stale lockfiles and `.only` get one follow-up turn; weakening added while checks were failing gets one follow-up turn.
- **Auto-fix hints**: failing format/lint checks come with the exact writing command for the files they ran on (`prettier --write`, `biome check --write`, `eslint --fix`, `ruff check --fix`, `gofmt -w`, `cargo fmt`, …) or the repo's own `format`/`fix` script.
- **Instructions on demand** (`profile.scopedInstructions`): nested `AGENTS.md`/`AGENTS.override.md`/`CLAUDE.md` that π does not load, and glob-scoped rules (Cursor `.mdc` globs/alwaysApply, Copilot `.instructions.md` applyTo, Windsurf `trigger: glob`) are appended to the first tool result that touches a matching file, once per session (again after compaction).
- **Generated files**: `.gitattributes` linguist-generated patterns and `DO NOT EDIT`/`@generated` headers; editing one adds a note with the regenerate command. The profile lists generated paths and a `generate` command (package scripts, Makefile/just/Task targets, buf, sqlc, Prisma).
- **Test conventions and single-test commands** in the profile (`*.test.ts` next to source, `test_*.py` in tests/, …; `vitest run <file> -t`, `pytest <file>::<test>`, `go test -run`, `cargo test -p`, rspec, phpunit, gradle, maven, dotnet, swift, mix, dart, deno).
- **`/profile doctor`**: required vs installed runtimes (node, python, go, rust, bun), tool and dependency availability, and the commands that would fix them (never run).
- **Parallel checks**: read-only tiers run concurrently (`verify.concurrency`, auto = half the cores, max 4); tools sharing a lock (cargo, gradle, go, …) stay serial; tests and builds run one at a time.
- **Windows**: separator-safe home guard, `/verify` paths, context-file matching and cross-drive files; CI on Linux, macOS and Windows (Node 22.18 and 24).
- Fixed: availability is judged on the command that actually runs, so a narrowed `vitest related` run no longer needs the package manager of the full command on PATH.
- Fixed: shell linters found on PATH (shellcheck, hadolint) are added only when the repository has such files, and never hide the project's own CI or Makefile lint check — detection no longer depends on what happens to be installed.
- Detector version 12.

## 0.2.0 — 2026-09-29

- Scoped test runs: when the changed files allow it, the test tier runs `vitest related --run`, `jest --findRelatedTests`, `go test ./<pkg>/...`, `cargo test -p <package>` (workspace root package; members already run in their own directory) or `pytest <changed test files>` instead of the whole suite. Config/manifest changes, unknown file kinds and ambiguous mappings fall back to the full run; previously failing checks keep their file list across repair rounds. The binary is still resolved at run time.
- `verify.perTurn` (default off): run the syntax + fast tiers after every turn that changed files (tool writes, or a git peek when a shell tool ran) and append a non-continuing informational note when red. Earlier per-turn notes are superseded to keep context small.
- Monorepos: a package's files are checked with the package's own scripts/binaries in its directory, rendered with the workspace's package manager (a member without its own lockfile inherits pnpm/yarn/bun/npm from the workspace root). When the root also runs a workspace-wide command for the same check (`turbo`, `nx`, `pnpm -r`, `--workspaces`, `tsc -b` over references, ...) the package-level duplicate is skipped.
- `cargo check` runs without `--all-targets` unless a test/bench/example target, `#[cfg(test)]` code or a manifest changed.
- Windows: executables resolve through `PATHEXT` (`npm` → `npm.cmd`), `node_modules/.bin/*.cmd` shims and venv `Scripts/` are used, `.cmd`/`.bat` and CI `sh -c` commands run through the shell, and timeouts kill the child directly (no process groups).
- Fixed: boundary handlers now keep entries queued by earlier extensions instead of replacing the draft chain.
- Fixed: a tool installed mid-session (e.g. `vendor/bin/phpstan` after `composer install`) is no longer reported missing until restart.
- Detector version 10 (new `scope` and `coversWorkspace` fields on checks).

## 0.1.0 — 2026-09-29

Initial release.

- Profile: stack / commands / conventions / CI / instruction-file detection for ~30 ecosystems, cached under `~/.pi/agent/project-profile/`, injected as a static `<project_profile>` system-prompt section.
- Verify: `agent_before_settle` gate that runs the project's own checks by tier (syntax → fast → lint automatic; test/build confirmed once per repo), prunes failures, and drives a bounded repair loop (`maxRepairRounds`, stops on no changes or identical failure).
- Environment failures (missing tools, uninstalled deps, timeouts, services down) notify the user and disable the check for the session instead of looping the agent.
- `/profile`, `/verify` commands and the `run_checks` tool.
- Project-root resolution never climbs to the home directory (a stray `~/package.json` or a dotfiles repo at `~` must not turn `~` into the project).
