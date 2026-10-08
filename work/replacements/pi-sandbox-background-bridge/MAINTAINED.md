# Maintained pi-sandbox background bridge

Private local copy of carderne/pi-sandbox 0.7.1, pinned to @carderne/sandbox-runtime 0.0.76. Load with the sibling background-carderne adapter. Foreground tools/permissions retain their existing paths; the additional service prepares Background commands using the same session-scoped runtime manager. Do not load the original sandbox at the same time.

Only explicit sandbox-disable/toggle, --no-sandbox or enabled:false at session initialization allows unconfined Background work, and its launch is visibly marked. Runtime absence/failure/initialization/shutdown blocks Background work. The bridge reloads current configuration anchored to session cwd and applies current allowances. It adds per-launch write denials for Background control-plane state, both extension sources, and sandbox configuration; user-specified command cwd does not change policy selection.

The local test/session-isolation fixture has the Pi 1.1 sessionManager and ExtensionToolContext fields required by current builtin bash metadata handling. Production foreground behavior was not changed to mask the older fixture failure.

Keep the existing LICENSE and upstream README. Future upstream updates must preserve the background-service:v1 contract and run the sibling actual-SDK regression plus this package's type check and unit suite. Network proxy lifetime is the sandbox session's lifetime; detached jobs are not promised network continuity after session shutdown.

Revision bridge.2: Background policy loading rejects unreadable/malformed JSON and invalid permission shapes. Only enabled:false is an explicit opt-out. Runtime generations and a final policy check reject stale preparations after lifecycle or policy changes. Protected-root descendant write grants are denied explicitly to cover runtime 0.0.76 parent-denial behavior. The local peer version is pinned to the tested Pi 1.1.0.
