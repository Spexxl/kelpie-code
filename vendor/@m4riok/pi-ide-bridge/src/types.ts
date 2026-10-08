export type ApprovalMode = 'ask' | 'auto';
export type ApprovalDecision = 'approved' | 'approved_auto' | 'rejected';
export type BridgeCloseDecision = 'approved' | 'rejected' | 'closed_by_pi';

export type ApprovalProxyRequest = {
  version: 1;
  token: string;
  proxyRequestId: string;
  requestId: string;
  toolName: 'edit' | 'write';
  pathArg: string;
  filePath: string;
  beforeText: string;
  afterText: string;
  requestedAt: number;
  pid?: number;
  cwd?: string;
};

export type ApprovalProxyResponse = {
  version: 1;
  token: string;
  proxyRequestId: string;
  requestId: string;
  decision: ApprovalDecision;
  respondedAt: number;
  message?: string;
};

export type RejectedChange = {
  filePath: string;
  beforeText: string;
  afterText: string;
  rejectedAt: number;
};

export type BridgeConnection = {
  port: number;
  authToken: string;
};

export type OpenFile = {
  path: string;
  timestamp: number;
  isActive?: boolean;
  selectedText?: string;
  cursor?: { line: number; character: number };
};

export type EditorContext = {
  openFiles: OpenFile[];
  isTrusted: boolean;
};

export type DiagnosticsScope = 'active' | 'all' | 'file';

export type DiagnosticsRequest = {
  scope?: DiagnosticsScope;
  filePath?: string;
};

export type DiagnosticEntry = {
  severity: 'error' | 'warning';
  message: string;
  line: number;
  character: number;
  source?: string;
  code?: string;
};

export type FileDiagnostics = {
  path: string;
  diagnostics: DiagnosticEntry[];
};

export type DiagnosticsResponse = {
  files: FileDiagnostics[];
  totalErrors: number;
  totalWarnings: number;
};
