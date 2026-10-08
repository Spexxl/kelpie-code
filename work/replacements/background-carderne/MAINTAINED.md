# Maintained Background adapter for carderne pi-sandbox

This is a private local copy of pi-better-background-tasks 0.8.0. It must load together with the sibling pi-sandbox-background-bridge copy (pi-sandbox 0.7.1, @carderne/sandbox-runtime 0.0.76). Do not also load the original Background or Sandbox extension: both copies retain the upstream tool/command names.

The background-service:v1 event-bus bridge asks the current sandbox session to prepare every local process launch and every watch check. The provider keeps session cwd/trust and current configuration/allowances; a tool cwd cannot select a different sandbox configuration. Missing, initializing, failed and closed runtime states reject launches. Explicit sandbox disable allows an unconfined launch with a visible notice. Enabled sandbox with filesystem.disabled cannot protect the registry and rejects background tasks.

The adapter retains durable task metadata, logs, process-group cancellation, timeouts and task inspection. Watch metadata contains original intent, never a saved sandbox wrapper. Resumed watch checks obtain current policy and proxy state. A task started under an OS filesystem policy keeps that launch policy; future processes use current policy. Network allowances are enforced by the live runtime proxy. Detached jobs lose that proxy when their Pi session shuts down; there is no guarantee of durable restricted network access beyond the sandbox session.

Structured SSH cannot inherit local filesystem restrictions and is refused while sandboxing is enabled. Remote sandbox protection requires a separately managed remote runtime. Explicit sandbox disable retains the upstream remote behavior and its weaker direct-mode termination warning.

Outer launcher startup/loader variables are neutralized. Requested values and PATH take effect only inside the OS namespace. Task registry, extension sources, and sandbox configuration paths are denied writes for the confined job. These extra denials do not widen foreground policy.

Regression source: test/background-regression.mjs. It uses the actual installed Pi 1.1 SDK with an offline scripted provider, bounded temporary fixtures, no API requests and no paid models. Run with Node 24.21.0. BG_EXTENSION and SANDBOX_EXTENSION can override the two paths to compare baseline and candidate. Run OS tests outside a enclosing restriction that prevents namespace creation. Type checking needs TypeScript 5.9.3 and Node24 types; use the typecheck script.

Upstream tests for this published Background package were omitted from its npm artifact. Do not run upstream monorepo pretest/prepack hooks in this standalone copy: their shared-source directories do not exist here. Keep LICENSE and upstream README for provenance. Future upstream updates require reapplying and rerunning the bridge regression, rather than overwriting this maintained copy.

Revision carderne.2: watch polling rechecks cancellation, runtime generation and deadline after async preparation; no cancelled or expired watch starts another process. Each check persists and logs any confinement-notice change. OS fixture state now lives outside extension source directories in /tmp. Additional regression: node test/watch-preparation-regression.mjs (four cases).
