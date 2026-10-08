import { createHash, randomUUID } from 'node:crypto';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { ApprovalDecision, ApprovalMode, ApprovalProxyRequest, ApprovalProxyResponse } from './types.js';

const APPROVAL_HOST = '127.0.0.1';
const APPROVAL_PATH = '/approval';
const MAX_PROXY_PAYLOAD_BYTES = 25 * 1024 * 1024;

export const APPROVAL_MODE_ENV = 'PI_IDE_BRIDGE_APPROVAL_MODE';
export const PARENT_APPROVAL_URL_ENV = 'PI_IDE_BRIDGE_PARENT_APPROVAL_URL';
export const PARENT_APPROVAL_TOKEN_ENV = 'PI_IDE_BRIDGE_PARENT_APPROVAL_TOKEN';
export const PARENT_APPROVAL_PID_ENV = 'PI_IDE_BRIDGE_PARENT_APPROVAL_PID';

type ParentApprovalHandler = (request: ApprovalProxyRequest) => Promise<ApprovalDecision>;

type ParentApprovalProxyConfig = {
  url: string;
  token: string;
  pid?: number;
};

export type ParentApprovalProxyHandle = ParentApprovalProxyConfig & {
  port: number;
  stop: () => void;
};

export function getApprovalModeFromEnvironment(): ApprovalMode | undefined {
  return parseApprovalMode(process.env[APPROVAL_MODE_ENV]);
}

export function getInheritedApprovalMode(fallback: ApprovalMode = 'ask'): ApprovalMode {
  return getApprovalModeFromEnvironment() ?? fallback;
}

export function hasParentApprovalProxy(): boolean {
  return Boolean(getParentApprovalProxyConfig());
}

export function setApprovalModeEnvironment(mode: ApprovalMode): void {
  process.env[APPROVAL_MODE_ENV] = mode;
}

export async function startParentApprovalProxy(
  mode: ApprovalMode,
  handler: ParentApprovalHandler,
  onError?: (message: string) => void,
): Promise<ParentApprovalProxyHandle> {
  const token = randomUUID();
  const reportError = (message: string) => {
    if (onError) onError(message);
    else console.warn(message);
  };

  const server = http.createServer((req, res) => {
    void handleApprovalHttpRequest({ req, res, token, handler, reportError });
  });

  server.on('clientError', (_error, socket) => {
    socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
  });

  await new Promise<void>((resolvePromise, rejectPromise) => {
    const onError = (error: Error) => {
      server.off('listening', onListening);
      rejectPromise(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolvePromise();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(0, APPROVAL_HOST);
  });

  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('approval proxy did not bind to a TCP port');
  }

  const port = (address as AddressInfo).port;
  const url = `http://${APPROVAL_HOST}:${port}`;
  process.env[PARENT_APPROVAL_URL_ENV] = url;
  process.env[PARENT_APPROVAL_TOKEN_ENV] = token;
  process.env[PARENT_APPROVAL_PID_ENV] = String(process.pid);
  setApprovalModeEnvironment(mode);

  return {
    url,
    token,
    pid: process.pid,
    port,
    stop: () => {
      clearParentApprovalProxyEnvironment(url, token);
      server.close((error) => {
        if (error) reportError(`Pi IDE Bridge: approval proxy close failed: ${formatError(error)}`);
      });
    },
  };
}

function clearParentApprovalProxyEnvironment(url: string, token: string): void {
  if (process.env[PARENT_APPROVAL_URL_ENV] !== url || process.env[PARENT_APPROVAL_TOKEN_ENV] !== token) return;
  delete process.env[PARENT_APPROVAL_URL_ENV];
  delete process.env[PARENT_APPROVAL_TOKEN_ENV];
  delete process.env[PARENT_APPROVAL_PID_ENV];
}

export async function requestApprovalFromParentProxy(input: {
  requestId: string;
  toolName: 'edit' | 'write';
  pathArg: string;
  filePath: string;
  beforeText: string;
  afterText: string;
  cwd: string;
}, signal?: AbortSignal): Promise<ApprovalDecision | undefined> {
  const config = getParentApprovalProxyConfig();
  if (!config) return undefined;

  const proxyRequestId = createProxyRequestId(input.requestId);
  const request: ApprovalProxyRequest = {
    version: 1,
    token: config.token,
    proxyRequestId,
    requestId: input.requestId,
    toolName: input.toolName,
    pathArg: input.pathArg,
    filePath: input.filePath,
    beforeText: input.beforeText,
    afterText: input.afterText,
    requestedAt: Date.now(),
    pid: process.pid,
    cwd: input.cwd,
  };

  try {
    const response = await postApprovalRequest(config, request, signal);
    return response?.decision;
  } catch (error) {
    if (isAbortError(error)) throw error;
    console.warn(`Pi IDE Bridge: failed to request parent approval: ${formatError(error)}`);
    return undefined;
  }
}

function getParentApprovalProxyConfig(): ParentApprovalProxyConfig | undefined {
  const url = process.env[PARENT_APPROVAL_URL_ENV];
  const token = process.env[PARENT_APPROVAL_TOKEN_ENV];
  if (!url || !token) return undefined;

  const rawPid = Number(process.env[PARENT_APPROVAL_PID_ENV]);
  const pid = Number.isInteger(rawPid) && rawPid > 0 ? rawPid : undefined;
  if (pid !== undefined && !isProcessAlive(pid)) return undefined;

  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:') return undefined;
    if (!isLoopbackHost(parsed.hostname)) return undefined;
    if (!parsed.port) return undefined;
  } catch {
    return undefined;
  }

  return { url, token, ...(pid !== undefined ? { pid } : {}) };
}

async function handleApprovalHttpRequest(input: {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  token: string;
  handler: ParentApprovalHandler;
  reportError: (message: string) => void;
}): Promise<void> {
  const { req, res, token, handler, reportError } = input;

  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'method not allowed' });
    return;
  }

  const pathName = new URL(req.url || '/', `http://${APPROVAL_HOST}`).pathname;
  if (pathName !== APPROVAL_PATH) {
    sendJson(res, 404, { error: 'not found' });
    return;
  }

  if (req.headers.authorization !== `Bearer ${token}`) {
    sendJson(res, 401, { error: 'unauthorized' });
    return;
  }

  let request: ApprovalProxyRequest | undefined;
  let decision: ApprovalDecision = 'rejected';
  let message: string | undefined;

  try {
    const payload = await readRequestJson(req);
    request = validateProxyRequest(payload, token);
    decision = await handler(request);
  } catch (error) {
    message = formatError(error);
    reportError(`Pi IDE Bridge: parent approval request failed: ${message}`);
  }

  if (!request) {
    sendJson(res, 400, { error: message || 'invalid approval request' });
    return;
  }

  const response: ApprovalProxyResponse = {
    version: 1,
    token,
    proxyRequestId: request.proxyRequestId,
    requestId: request.requestId,
    decision,
    respondedAt: Date.now(),
    ...(message ? { message } : {}),
  };
  sendJson(res, 200, response);
}

function validateProxyRequest(payload: unknown, token: string): ApprovalProxyRequest {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('approval request is not an object');
  const raw = payload as Record<string, unknown>;
  if (raw.version !== 1) throw new Error('approval request version is unsupported');
  if (raw.token !== token) throw new Error('approval request token mismatch');
  if (typeof raw.proxyRequestId !== 'string' || raw.proxyRequestId.length === 0) throw new Error('approval request missing proxyRequestId');
  if (typeof raw.requestId !== 'string' || raw.requestId.length === 0) throw new Error('approval request missing requestId');
  if (raw.toolName !== 'edit' && raw.toolName !== 'write') throw new Error('approval request toolName is unsupported');
  if (typeof raw.pathArg !== 'string') throw new Error('approval request missing pathArg');
  if (typeof raw.filePath !== 'string' || raw.filePath.length === 0) throw new Error('approval request missing filePath');
  if (typeof raw.beforeText !== 'string') throw new Error('approval request missing beforeText');
  if (typeof raw.afterText !== 'string') throw new Error('approval request missing afterText');

  return {
    version: 1,
    token,
    proxyRequestId: raw.proxyRequestId,
    requestId: raw.requestId,
    toolName: raw.toolName,
    pathArg: raw.pathArg,
    filePath: raw.filePath,
    beforeText: raw.beforeText,
    afterText: raw.afterText,
    requestedAt: typeof raw.requestedAt === 'number' ? raw.requestedAt : Date.now(),
    ...(typeof raw.pid === 'number' ? { pid: raw.pid } : {}),
    ...(typeof raw.cwd === 'string' ? { cwd: raw.cwd } : {}),
  };
}

function validateProxyResponse(payload: unknown, config: ParentApprovalProxyConfig, request: ApprovalProxyRequest): ApprovalProxyResponse | undefined {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return undefined;
  const raw = payload as Record<string, unknown>;
  if (raw.version !== 1) return undefined;
  if (raw.token !== config.token) return undefined;
  if (raw.proxyRequestId !== request.proxyRequestId || raw.requestId !== request.requestId) return undefined;
  if (!isApprovalDecision(raw.decision)) return undefined;
  return {
    version: 1,
    token: config.token,
    proxyRequestId: request.proxyRequestId,
    requestId: request.requestId,
    decision: raw.decision,
    respondedAt: typeof raw.respondedAt === 'number' ? raw.respondedAt : Date.now(),
    ...(typeof raw.message === 'string' ? { message: raw.message } : {}),
  };
}

function postApprovalRequest(
  config: ParentApprovalProxyConfig,
  request: ApprovalProxyRequest,
  signal?: AbortSignal,
): Promise<ApprovalProxyResponse | undefined> {
  return new Promise((resolvePromise, rejectPromise) => {
    if (signal?.aborted) {
      rejectPromise(createAbortError());
      return;
    }

    const baseUrl = new URL(config.url);
    const targetUrl = new URL(APPROVAL_PATH, baseUrl);
    const body = JSON.stringify(request);
    const req = http.request(
      {
        hostname: targetUrl.hostname,
        port: targetUrl.port,
        path: targetUrl.pathname,
        method: 'POST',
        headers: {
          authorization: `Bearer ${config.token}`,
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
        },
      },
      (res) => {
        void readResponseJson(res).then((payload) => {
          cleanup();
          if ((res.statusCode || 500) < 200 || (res.statusCode || 500) >= 300) {
            rejectPromise(new Error(`approval proxy returned HTTP ${res.statusCode || 500}`));
            return;
          }
          resolvePromise(validateProxyResponse(payload, config, request));
        }).catch((error) => {
          cleanup();
          rejectPromise(error);
        });
      },
    );

    const cleanup = () => {
      req.off('error', onError);
      if (signal) signal.removeEventListener('abort', onAbort);
    };
    const onError = (error: Error) => {
      cleanup();
      rejectPromise(error);
    };
    const onAbort = () => {
      req.destroy(createAbortError());
    };

    req.on('error', onError);
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    req.write(body);
    req.end();
  });
}

async function readRequestJson(req: http.IncomingMessage): Promise<unknown> {
  return JSON.parse(await readLimitedStream(req));
}

async function readResponseJson(res: http.IncomingMessage): Promise<unknown> {
  const text = await readLimitedStream(res);
  return text ? JSON.parse(text) : {};
}

function readLimitedStream(stream: NodeJS.ReadableStream): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    const chunks: Buffer[] = [];
    let total = 0;

    stream.on('data', (chunk) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buffer.length;
      if (total > MAX_PROXY_PAYLOAD_BYTES) {
        rejectPromise(new Error(`approval payload exceeds ${MAX_PROXY_PAYLOAD_BYTES} bytes`));
        (stream as { destroy?: () => void }).destroy?.();
        return;
      }
      chunks.push(buffer);
    });
    stream.on('end', () => resolvePromise(Buffer.concat(chunks).toString('utf8')));
    stream.on('error', rejectPromise);
  });
}

function sendJson(res: http.ServerResponse, statusCode: number, payload: unknown): void {
  const body = `${JSON.stringify(payload)}\n`;
  res.writeHead(statusCode, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

function createProxyRequestId(requestId: string): string {
  const digest = createHash('sha256').update(`${process.pid}:${requestId}:${Date.now()}:${randomUUID()}`).digest('hex');
  return `${process.pid}-${digest.slice(0, 32)}`;
}

function parseApprovalMode(value: unknown): ApprovalMode | undefined {
  return value === 'ask' || value === 'auto' ? value : undefined;
}

function isApprovalDecision(value: unknown): value is ApprovalDecision {
  return value === 'approved' || value === 'approved_auto' || value === 'rejected';
}

function isLoopbackHost(hostname: string): boolean {
  return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1' || hostname === '[::1]';
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException | undefined)?.code === 'EPERM';
  }
}

function createAbortError(): Error {
  const error = new Error('Approval request aborted');
  error.name = 'AbortError';
  return error;
}

function isAbortError(error: unknown): boolean {
  return (error as { name?: unknown } | undefined)?.name === 'AbortError';
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
