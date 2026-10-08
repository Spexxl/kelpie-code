import * as http from 'node:http';
import { BOOTSTRAP_PORT, BOOTSTRAP_RETRY_BACKOFF_MS, BRIDGE_HOST } from './constants.js';
import type { BridgeCloseDecision, BridgeConnection, DiagnosticsRequest, DiagnosticsResponse, EditorContext } from './types.js';
import bridgeContract from './bridgeContract.js';

const {
  BRIDGE_ENV_PORT_KEY,
  BRIDGE_ENV_AUTH_TOKEN_KEY,
  BRIDGE_OPEN_DIFF_PATH,
  BRIDGE_CLOSE_DIFF_PATH,
  BRIDGE_HEALTH_PATH,
  BRIDGE_CONTEXT_STREAM_PATH,
  BRIDGE_DIAGNOSTICS_PATH,
  BRIDGE_BOOTSTRAP_RESOLVE_PATH,
} = bridgeContract;

const HTTP_TIMEOUT_MS = 5_000;
const LOCAL_PROBE_TIMEOUT_MS = 500;
const CONNECTION_CACHE_TTL_MS = 20_000;
const NEGATIVE_CACHE_TTL_MS = 3_000;

type ConnectionSource = 'env' | 'bootstrap' | 'none';
type ResolveResult = { connection: BridgeConnection | undefined; source: ConnectionSource; healthy: boolean; reason?: string };

let cachedResult: ResolveResult | undefined;
let cachedResultExpiresAt = 0;

export async function sendOpenDiff(payload: {
  filePath: string;
  beforeText: string;
  afterText: string;
  requestId: string;
}, options: { rejectOnUnavailable?: boolean } = {}): Promise<string> {
  const connection = await resolveBridgeConnectionInfo();
  if (!connection) {
    if (options.rejectOnUnavailable) throw new Error('no active VS Code bridge connection');
    return waitForPiPromptOnly('no active VS Code bridge connection');
  }

  return postBridgeMessage(connection, BRIDGE_OPEN_DIFF_PATH, payload)
    .then((res) => String(res?.decision || 'rejected'))
    .catch((error) => {
      if (options.rejectOnUnavailable) throw error;
      return waitForPiPromptOnly(`VS Code bridge request failed: ${String(error?.message || error)}`);
    });
}

export async function sendCloseDiff(requestId: string, decision: BridgeCloseDecision): Promise<void> {
  const connection = await resolveBridgeConnectionInfo();
  if (!connection) return;
  return postBridgeMessage(connection, BRIDGE_CLOSE_DIFF_PATH, { requestId, decision }).then(() => undefined).catch(() => undefined);
}

export async function sendGetDiagnostics(params: DiagnosticsRequest): Promise<DiagnosticsResponse | undefined> {
  const connection = await resolveBridgeConnectionInfo();
  if (!connection) return undefined;

  try {
    const response = await postBridgeMessage(connection, BRIDGE_DIAGNOSTICS_PATH, params as Record<string, unknown>);
    if (response?.ok === false) return undefined;
    if (!Array.isArray(response?.files)) return undefined;
    return response as unknown as DiagnosticsResponse;
  } catch {
    return undefined;
  }
}

export function connectContextStream(
  onContext: (context: EditorContext) => void,
  onDisconnect: () => void,
): { disconnect: () => void } {
  let closed = false;
  let disconnected = false;
  let req: http.ClientRequest | undefined;

  const notifyDisconnect = () => {
    if (closed || disconnected) return;
    disconnected = true;
    onDisconnect();
  };

  const start = async () => {
    const connection = await resolveBridgeConnectionInfo();
    if (!connection) {
      notifyDisconnect();
      return;
    }

    req = http.request(
      {
        host: BRIDGE_HOST,
        port: connection.port,
        path: BRIDGE_CONTEXT_STREAM_PATH,
        method: 'GET',
        headers: {
          authorization: `Bearer ${connection.authToken}`,
          accept: 'text/event-stream',
        },
      },
      (res) => {
        if ((res.statusCode || 500) < 200 || (res.statusCode || 500) >= 300) {
          res.resume();
          notifyDisconnect();
          return;
        }

        let buffer = '';
        res.on('data', (chunk) => {
          if (closed) return;
          buffer += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
          buffer = buffer.replace(/\r\n/g, '\n');

          let boundary = buffer.indexOf('\n\n');
          while (boundary !== -1) {
            const eventChunk = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);

            const dataLines = eventChunk
              .split('\n')
              .map((line) => line.trimEnd())
              .filter((line) => line.startsWith('data:'))
              .map((line) => line.slice(5).trimStart());

            if (dataLines.length > 0) {
              try {
                onContext(JSON.parse(dataLines.join('\n')) as EditorContext);
              } catch {
                // ignore malformed events and continue
              }
            }

            boundary = buffer.indexOf('\n\n');
          }
        });

        res.on('error', () => {
          notifyDisconnect();
        });
        res.on('close', () => {
          notifyDisconnect();
        });
      },
    );

    req.on('error', () => {
      notifyDisconnect();
    });
    req.end();
  };

  void start().catch(() => notifyDisconnect());

  return {
    disconnect: () => {
      closed = true;
      req?.destroy();
    },
  };
}

export async function getIdeConnectionStatus(theme?: { fg?: (name: any, text: string) => string }): Promise<{ type: 'info'; text: string }> {
  const diag = await getIdeConnectionDiagnostics();
  if (!diag.connected) {
    const suffix = diag.reason.includes('unreachable') || diag.reason.includes('timeout')
      ? ' Please ensure the extension is running. To install the extension, run /ide install.'
      : '';
    return {
      type: 'info',
      text: `${colorDot(theme, false)} disconnected from IDE: ${diag.reason}.${suffix}`,
    };
  }

  return { type: 'info', text: `${colorDot(theme, true)} ${colorAccent(theme, 'connected to IDE')}` };
}

function colorAccent(theme: { fg?: (name: any, text: string) => string } | undefined, text: string): string {
  if (!theme?.fg) return text;
  return theme.fg('accent', text);
}

function colorDot(theme: { fg?: (name: any, text: string) => string } | undefined, connected: boolean): string {
  if (!theme?.fg) return '●';
  return connected ? theme.fg('success', '●') : theme.fg('error', '●');
}

export async function isIdeConnected(): Promise<boolean> {
  const diag = await getIdeConnectionDiagnostics();
  return diag.connected;
}

export async function getIdeConnectionDebugInfo(): Promise<{ connected: boolean; source: ConnectionSource; port?: number; reason?: string }> {
  const resolved = await resolveBridgeConnectionInfoDetailed();
  if (!resolved.connection) {
    return { connected: false, source: 'none', reason: resolved.reason || 'No bridge connection info available from env or bootstrap endpoint' };
  }

  if (!resolved.healthy) {
    return {
      connected: false,
      source: resolved.source,
      port: resolved.connection.port,
      reason: 'Bridge health check failed',
    };
  }

  return { connected: true, source: resolved.source, port: resolved.connection.port };
}

async function getIdeConnectionDiagnostics(): Promise<{ connected: boolean; reason: string }> {
  const debug = await getIdeConnectionDebugInfo();
  if (!debug.connected) return { connected: false, reason: String(debug.reason || 'Disconnected') };
  return { connected: true, reason: '' };
}

function readConnectionFromEnv(): BridgeConnection | undefined {
  const rawPort = process.env[BRIDGE_ENV_PORT_KEY];
  const authToken = process.env[BRIDGE_ENV_AUTH_TOKEN_KEY];
  const port = rawPort ? Number(rawPort) : NaN;

  if (!Number.isInteger(port) || port <= 0 || port > 65535) return undefined;
  if (!authToken) return undefined;

  return { port, authToken };
}

async function resolveBridgeConnectionInfo(): Promise<BridgeConnection | undefined> {
  const resolved = await resolveBridgeConnectionInfoDetailed();
  return resolved.connection;
}

function cacheResult(result: ResolveResult, ttlMs: number) {
  cachedResult = result;
  cachedResultExpiresAt = Date.now() + ttlMs;
}

async function resolveBridgeConnectionInfoDetailed(): Promise<ResolveResult> {
  if (cachedResult && cachedResultExpiresAt > Date.now()) return cachedResult;

  const envConnection = readConnectionFromEnv();
  if (envConnection) {
    const envHealthy = await pingBridgeHealth(envConnection);
    if (envHealthy) {
      const result: ResolveResult = { connection: envConnection, source: 'env', healthy: true };
      cacheResult(result, CONNECTION_CACHE_TTL_MS);
      return result;
    }
  }

  const bootstrap = await fetchBridgeConnectionWithRetry();
  if (bootstrap.connection) {
    const healthy = await pingBridgeHealth(bootstrap.connection);
    if (healthy) {
      const result: ResolveResult = { connection: bootstrap.connection, source: 'bootstrap', healthy: true };
      cacheResult(result, CONNECTION_CACHE_TTL_MS);
      return result;
    }
  }

  const result: ResolveResult = {
    connection: undefined,
    source: 'none',
    healthy: false,
    reason: bootstrap.reason || 'No bridge connection info available from env or bootstrap endpoint',
  };
  cacheResult(result, NEGATIVE_CACHE_TTL_MS);
  return result;
}

type ResolveOutcome =
  | { status: 'ready'; connection: BridgeConnection }
  | { status: 'not_found'; reason: string }
  | { status: 'error'; reason: string };

async function fetchBridgeConnectionWithRetry(): Promise<{ connection?: BridgeConnection; reason?: string }> {
  let lastReason = 'Bootstrap resolve failed';
  for (const delay of BOOTSTRAP_RETRY_BACKOFF_MS) {
    const outcome = await resolveViaBootstrap();
    if (outcome.status === 'ready') return { connection: outcome.connection };
    lastReason = outcome.reason;
    if (outcome.status !== 'not_found') break; // don't retry hard errors or ambiguity
    await new Promise<void>((r) => setTimeout(r, delay));
  }
  return { reason: lastReason };
}

async function resolveViaBootstrap(): Promise<ResolveOutcome> {
  try {
    const body = JSON.stringify({
      piPid: process.pid,
      piParentPid: process.ppid,
      cwd: process.cwd(),
    });
    const { data } = await makeHttpRequest({
      host: BRIDGE_HOST,
      port: BOOTSTRAP_PORT,
      path: BRIDGE_BOOTSTRAP_RESOLVE_PATH,
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
      },
      body,
      timeoutMs: LOCAL_PROBE_TIMEOUT_MS,
      timeoutErrorMessage: 'bootstrap timeout',
    });

    if (data?.status === 'ready') {
      const bridge = data.bridge as Record<string, unknown>;
      const port = Number(bridge?.port);
      const authToken = typeof bridge?.authToken === 'string' ? bridge.authToken : '';
      if (!Number.isInteger(port) || port <= 0 || port > 65535 || !authToken) {
        return { status: 'error', reason: 'Bootstrap returned invalid bridge payload' };
      }
      return { status: 'ready', connection: { port, authToken } };
    }

    if (data?.status === 'not_found') {
      return { status: 'not_found', reason: String(data?.reason ?? 'No matching VS Code window found') };
    }

    if (data?.status === 'ambiguous') {
      const count = Array.isArray(data?.candidates) ? (data.candidates as unknown[]).length : 0;
      const reason = count <= 1
        ? 'Could not identify a matching VS Code workspace'
        : 'Could not identify a unique VS Code workspace — multiple windows matched';
      return { status: 'error', reason };
    }

    return { status: 'error', reason: 'Bootstrap returned unexpected response' };
  } catch (error) {
    const message = String(error instanceof Error ? error.message : error);
    if (message.includes('bootstrap timeout')) return { status: 'error', reason: 'Bootstrap timeout' };
    if (message.includes('ECONNREFUSED') || message.includes('ECONNRESET') || message.includes('ENOTFOUND')) {
      return { status: 'error', reason: 'Bootstrap unreachable' };
    }
    if (message.includes('invalid JSON response from bridge')) return { status: 'error', reason: 'Bootstrap returned invalid JSON' };
    return { status: 'error', reason: `Bootstrap request failed: ${message}` };
  }
}

function makeHttpRequest(options: {
  host: string;
  port: number;
  path: string;
  method: string;
  headers?: Record<string, string | number>;
  body?: string;
  timeoutMs?: number;
  timeoutErrorMessage?: string;
}): Promise<{ statusCode: number; data: Record<string, unknown> }> {
  return new Promise((resolvePromise, rejectPromise) => {
    const req = http.request(
      {
        host: options.host,
        port: options.port,
        path: options.path,
        method: options.method,
        headers: options.headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });
        res.on('end', () => {
          try {
            const response = chunks.length ? Buffer.concat(chunks).toString('utf8') : '';
            const data = response ? JSON.parse(response) : {};
            resolvePromise({ statusCode: res.statusCode || 500, data });
          } catch (error) {
            rejectPromise(new Error(`invalid JSON response from bridge: ${String(error instanceof Error ? error.message : error)}`));
          }
        });
      },
    );

    if (options.timeoutMs) {
      req.setTimeout(options.timeoutMs, () => req.destroy(new Error(options.timeoutErrorMessage || 'request timeout')));
    }

    req.on('error', rejectPromise);

    if (options.body) {
      req.write(options.body);
    }
    req.end();
  });
}

async function postBridgeMessage(
  connection: BridgeConnection,
  pathName: string,
  message: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const body = JSON.stringify(message);
  const { data } = await makeHttpRequest({
    host: BRIDGE_HOST,
    port: connection.port,
    path: pathName,
    method: 'POST',
    headers: {
      authorization: `Bearer ${connection.authToken}`,
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(body),
    },
    body,
    timeoutMs: pathName !== BRIDGE_OPEN_DIFF_PATH ? HTTP_TIMEOUT_MS : undefined,
    timeoutErrorMessage: 'bridge request timeout',
  });
  return data;
}

function waitForPiPromptOnly(_reason: string): Promise<string> {
  // Intentionally never resolves so the local Pi prompt decision wins Promise.race in runtime.
  return new Promise(() => undefined);
}

async function pingBridgeHealth(connection: BridgeConnection): Promise<boolean> {
  try {
    const { statusCode } = await makeHttpRequest({
      host: BRIDGE_HOST,
      port: connection.port,
      path: BRIDGE_HEALTH_PATH,
      method: 'GET',
      headers: {
        authorization: `Bearer ${connection.authToken}`,
      },
      timeoutMs: LOCAL_PROBE_TIMEOUT_MS,
      timeoutErrorMessage: 'bridge health timeout',
    });
    return statusCode >= 200 && statusCode < 300;
  } catch {
    return false;
  }
}
