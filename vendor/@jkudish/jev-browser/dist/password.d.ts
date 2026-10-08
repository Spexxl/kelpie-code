/** Naming a variable with this prefix is the operator's opt-in for password_env. */
export declare const PASSWORD_ENV_PREFIX = "JEV_PASSWORD_";
/** Naming a variable with this prefix is the operator's opt-in for cookie_env. */
export declare const COOKIE_ENV_PREFIX = "JEV_COOKIE_";
export declare const MAX_SECRET_BYTES = 4096;
export declare const MIN_SECRET_CHARS = 4;
export declare const PASSWORD_REDACTED = "[REDACTED]";
/**
 * Exact-origin check for the password trust anchor: scheme://host[:port]
 * with no path, query, credentials, or wildcard. HTTPS is required except on
 * loopback hosts. Returns the canonical origin string, or null.
 */
export declare function parseTrustedOrigin(raw: string): string | null;
/** The handoff directory for password files. Override for tests and containers. */
export declare function handoffDir(): string;
/** The handoff directory must be a private directory owned by this user. */
export declare function ensureHandoffDir(dir?: string): Promise<void>;
/**
 * Validates decoded secret bytes. Exact bytes are preserved: never trimmed,
 * because surrounding whitespace can be part of a password. Producers should
 * use a no-newline mode (e.g. `op read --no-newline`).
 */
export declare function validateSecretBuffer(buf: Buffer, label?: string): string;
/** Reads a secret from stdin. Rejects interactive terminals and oversize input. */
export declare function readSecretFromStdin(): Promise<Buffer>;
/**
 * Consumes a one-shot handoff file. The path must be a plain absolute path
 * naming a direct child of the handoff directory: no subdirectories, no "..",
 * no traversal. The file is opened with O_NOFOLLOW (symlinks fail), validated
 * as a private regular file owned by this user with exactly mode 0600 and a
 * single link, its identity re-checked against the pathname, unlinked, and
 * only then read through the already-open descriptor. Once opened, the file
 * is always unlinked, even when a later check fails: it is one-shot, and a
 * rejected secret must not be left on disk. The `what` label names the option
 * in error messages (password_file or cookie_file); the file contents are
 * never quoted.
 */
export declare function readHandoffSecret(path: string, dir?: string, what?: string): Promise<Buffer>;
/**
 * Resolves a password_env request. Only JEV_PASSWORD_* names are considered;
 * every other name is rejected before its value is ever looked up, so the
 * model cannot probe arbitrary environment variables through this path.
 * The prefix and the option name in errors generalize to JEV_COOKIE_* for
 * seed-cookie delivery, with identical posture.
 */
export declare function readSecretFromEnv(name: string, opts?: {
    prefix?: string;
    what?: string;
}): Buffer;
/**
 * Playwright debug modes can record raw fill() values outside this package's
 * redaction boundary: PWDEBUG, the `debug` library namespaces Playwright logs
 * through (pw:api, pw:channel, pw:protocol, and wildcard specs like `*` that
 * include them), and DEBUG_FILE which redirects those logs to disk. Wildcard
 * semantics make an exact deny-list unreliable, so credential runs refuse any
 * nonempty PWDEBUG, DEBUG, and DEBUG_FILE outright.
 */
export declare function assertNoPlaywrightDebug(): void;
export interface Redactor {
    redact(s: string): string;
    redactDeep(value: unknown): any;
    /**
     * Redacts a string that was captured longer than it may be displayed and
     * returns at most `visible` characters. Position-preserving: an echo the
     * capture boundary cut mid-secret can never be pulled into the displayed
     * slice by earlier echoes shrinking to markers.
     */
    redactCapped(s: string, visible: number): string;
    /**
     * Length of the longest known representation of the secret. Capture
     * windows on credential runs are sized from this (visible limit + this
     * value), so an echo that starts inside the visible window is always
     * captured whole and can be redacted before any display slice.
     */
    maxVariantLength: number;
}
/**
 * Per-run redactor covering the representations a page can echo back: the
 * raw value(s), their percent-encoded forms (URLs), and their HTML-entity
 * forms. Accepts one secret (the password value) or several (the password
 * plus every seed-cookie value): every representation of every secret is a
 * variant, variants are applied longest-first, and the marker postcondition
 * holds for all of them, so a shorter value that is a prefix of a longer
 * one can never survive inside the longer one's match. Applied to every
 * model-facing state, trace, error, and result payload.
 */
export declare function makeRedactor(secrets: string | string[]): Redactor;
/** Reads a secret from an arbitrary local path (CLI only; the caller is human). */
export declare function readSecretFromPath(path: string): Promise<Buffer>;
