# @dreki-gg/pi-ask-mode

## 0.3.3

### Patch Changes

- Updated dependencies []:
  - @dreki-gg/pi-command-sandbox@0.3.0

## 0.3.2

### Patch Changes

- Replace bundled workspace dependency on @dreki-gg/pi-command-sandbox with a normal registry dependency. Removes prepack/postpack scripts and bundledDependencies.

- Updated dependencies []:
  - @dreki-gg/pi-command-sandbox@0.2.0

## 0.3.1

### Patch Changes

- [`da2522d`](https://github.com/dreki-gg/pi-extensions/commit/da2522d208461d1bf270cec2de7fa856b72c978e) Thanks [@jalbarrang](https://github.com/jalbarrang)! - fix(plan-mode, ask-mode): replace workspace:\* with actual version during prepack to fix npm install

  The published packages contained `"workspace:*"` in their dependencies field, which npm doesn't understand (`EUNSUPPORTEDPROTOCOL`). The prepack script now rewrites `workspace:*` to the concrete version from command-sandbox's package.json before packing, and postpack restores it via `git checkout`.

## 0.3.0

### Minor Changes

- [`2a08c1d`](https://github.com/dreki-gg/pi-extensions/commit/2a08c1d0b10a1ca74dfab74f93dd200570537e0f) Thanks [@jalbarrang](https://github.com/jalbarrang)! - feat(ask-mode, plan-mode): support concatenated shell commands in sandbox validation

  Commands using `&&`, `||`, and `;` operators are now parsed and validated per-segment instead of being blocked outright. Uses `shell-quote` for proper shell tokenization that respects quoted strings, subshells, and redirects.

  Previously, safe commands like `cd src && ls -la` or `git status && git log` were incorrectly blocked because the sandbox only split on pipes (`|`). Now each segment is validated independently against the safe/destructive pattern lists.

  Also adds `cd`, `basename`, `dirname`, `realpath`, `readlink`, and `bun pm ls` to the safe commands list, and blocks command substitution (`$(...)` and backticks) by default.

  Shared sandbox logic extracted to private `@dreki-gg/pi-command-sandbox` package (bundled into published tarballs via `bundledDependencies`).

## 0.2.0

### Minor Changes

- [`37abe99`](https://github.com/dreki-gg/pi-extensions/commit/37abe995e921a0364a82333271574b18e0de5b01) Thanks [@jalbarrang](https://github.com/jalbarrang)! - feat(ask-mode): add read-only ask mode extension

  Adds a dedicated Ask mode for pi with a `/ask` toggle, `--ask` flag, and `Ctrl+Alt+A` shortcut. Ask mode restricts tool access to read-only operations and blocks file modifications or destructive shell commands while keeping the conversation open for follow-up questions.
