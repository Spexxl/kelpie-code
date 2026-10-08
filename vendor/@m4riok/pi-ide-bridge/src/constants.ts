import bridgeContract from './bridgeContract.js';

export const BRIDGE_HOST = bridgeContract.BRIDGE_HOST;
export const BOOTSTRAP_PORT = bridgeContract.BRIDGE_BOOTSTRAP_PORT;
export const STARTUP_STATUS_DURATION_MS = 20_000;
export const TOGGLE_STATUS_DURATION_MS = 5_000;
export const VSCODE_EXTENSION_ID = 'm4riok.pi-ide-bridge-vscode';
export const RETRY_BACKOFF_MS = [150, 300, 600, 1_000, 5_000] as const;
export const BOOTSTRAP_RETRY_BACKOFF_MS = [150, 300, 600, 1_000] as const;
