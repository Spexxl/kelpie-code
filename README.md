# kelpie-code

A preserved integration of Pi Agent, native CodeMode, and extensions, forming the foundation for a custom agent harness with a user interface. The current implementation is a CLI stack; the interface is planned.

## What's included

- The complete Pi 1.1.0 monorepo source in `upstream/pi/`, with its upstream tag and commit recorded.
- Installed distributions of Pi 1.1.0 and Jev Browser 0.8.4 in `vendor/`, including upstream documentation and licenses.
- All 16 declared npm extensions in `vendor/`: 13 active extensions and three originals whose extension entry points are disabled.
- Three maintained forks in `work/replacements/`: Ask/CodeMode, the Sandbox/Background bridge, and Background Tasks.
- Jev Browser upstream source in `work/replacements/browser-upstream/`.
- Configuration templates, research profiles, installation scripts, tests, and review evidence.
- Extension dependency locks in `locks/`, with the inventory and known limitations in `outputs/`.

`vendor/` preserves the published files of the installed packages, excluding `node_modules`. Pi's source is also preserved in `upstream/pi/`. Transitive extension dependencies are recorded in the lockfile; Node, Chromium, and runtime dependencies still need to be installed. The installation helper reinstalls the selected package versions from npm.

## Restore the stack

The helper requires Linux, Bash, Python 3, an existing NVM installation, and network access. Close Pi before running:

```bash
bash work/reinstall-stack.sh
bash work/verify-install.sh
```

The script installs Node 24.21.0, Pi, and the pinned extensions, backs up existing configuration, applies the maintained forks, and disables the three original extension entry points. It also installs Chromium and attempts to install the IDE companion through `code` when the editor is available. Provider authentication must be configured separately. The templates in `config/` are reference files; expand their placeholders before using them.

The sandbox policy in `config/sandbox.json` and the profiles in `work/profiles/` are preserved separately. The current installer does not apply them automatically. Review them and copy them to `~/.pi/agent/sandbox.json` and `~/.pi/agent/agents/` as appropriate.

## Offline verification

```bash
python3 scripts/link-test-dependencies.py
node work/replacements/ask-fork-test.mjs
node work/replacements/background-carderne/test/background-regression.mjs
node work/replacements/background-carderne/test/watch-preparation-regression.mjs
node work/replacements/final-installed-stack-smoke.mjs
node work/replacements/browser-tests.mjs
```

The suites use the installed SDK and a scripted provider, without paid API calls. Set `PI_SDK_DIR` and `PI_PACKAGES_DIR` to override installation paths. See [verification notes](docs/verification.md) for current checks, historical evidence, and pending validation.

## Planned development

Build a session controller, an explicit event contract, and a user interface on top of Pi's SDK. The existing integration contracts and boundaries are documented in [integration notes](docs/integration.md), with the proposed development path in the [roadmap](docs/roadmap.md).

## Credits and licensing

Upstream packages retain their own authorship and licenses. The maintained forks derive from MIT-licensed projects and preserve their notices. See `vendor/manifest.json` and each package's license files. Original repository glue and documentation are covered by the root [MIT license](LICENSE); bundled upstream projects retain their respective licenses and copyright notices. Pi and third-party extensions remain credited to their original authors. Credentials, real conversations, and personal agent state are excluded.
