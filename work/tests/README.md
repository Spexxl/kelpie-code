# Offline compatibility suite

The suite runs against the installed Pi SDK and installed extension entry points.
It uses real `AgentSession`, native Code Mode, and the real extension tool-call
pipeline. A scripted provider emits real assistant tool-call messages; native
Code Mode invokes `ctx.executeTool()` through Pi's actual nested-call pipeline.
No fake extension API or stub hook is used. This is an SDK
integration test, not a test of model intelligence or a stub of extension hooks.

All file writes and shell side effects are confined to `work/test-project` and
`work/fixtures`. The local MCP stdio server intentionally exposes one read tool
and one write tool against a disposable sentinel. It never makes network calls.

No mock classifier result will be counted as a real Jev test. Missing credentials,
external browser/editor interfaces, and unavailable process isolation are reported
as limitations. A loaded extension and a registered tool are not proof that their
entire functionality or security policy works.

Results live in `work/test-results.json`. Preserve the detailed evidence when
reviewing the checklist; a partial result must not be presented as a pass.

Run from the repository root with Node 24.21.0 or newer:

```sh
/home/sll/.nvm/versions/node/v24.21.0/bin/node work/tests/compatibility.mjs
/home/sll/.nvm/versions/node/v24.21.0/bin/node work/tests/final-config-smoke.mjs
python work/tests/tui-narrow-smoke.py
```

Override `PI_SDK_DIR` and `PI_PACKAGES_DIR` for a different installation.
`PI_TEST_NODE` overrides the executable used by the PTY smoke. Run the integration
suite outside an additional host process/network sandbox: Codex's sandbox blocked
the fixture's stdio process and the sandbox runtime's Unix sockets, producing
environmental errors that do not measure Pi. The executed suite used a reviewed
unsandboxed process; all requested file writes still remained in disposable
fixtures. Browser navigation uses only a local data URL.

The all-17 suite intentionally loads disabled packages explicitly to reproduce
the compatibility failures. `final-config-smoke.mjs` loads the installed default
configuration and confirms Ask, Background Tasks and Browser are absent while
their packages remain installed. It reads the real user settings but redirects
memory writes to fixtures and performs no model/tool requests.

The sandbox suite's six published test files were copied, unchanged, to
`work/fixtures/sandbox-upstream` because Node refuses to strip TypeScript inside
`node_modules`. Dependencies link to the installed versions. Re-run with:

```sh
/home/sll/.nvm/versions/node/v24.21.0/bin/node --experimental-strip-types --test work/fixtures/sandbox-upstream/test/*.test.ts
```

That upstream run produced 47 tests: 42 pass, 2 fail, 3 skip. The two failures
use unit mock contexts missing `sessionManager`, which Pi 1.1.0's bash tool now
requires; the real SDK integration passes the corresponding context controls.
Three skips concern platform or runtime availability. These unit results are
separate from the 49 SDK cases (43 pass, 6 compatibility failures).
