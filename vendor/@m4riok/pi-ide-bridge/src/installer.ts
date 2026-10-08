import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { VSCODE_EXTENSION_ID } from './constants.js';

export async function installVsCodeCompanion(): Promise<boolean> {
  return installVsCodeExtension(VSCODE_EXTENSION_ID);
}

export async function installVsCodeCompanionFromLocalDebugVsix(vsixPath: string): Promise<boolean> {
  const exists = await access(vsixPath).then(() => true).catch(() => false);
  if (!exists) return false;
  return installVsCodeExtension(vsixPath);
}

type Candidate = { cmd: string; args: string[]; shell: boolean };

function getCandidates(extensionSpec: string): Candidate[] {
  const installArgs = ['--install-extension', extensionSpec, '--force'];

  if (process.platform === 'win32') {
    const safeSpec = extensionSpec.replace(/'/g, "''");
    return [
      // Explicitly invoke code.cmd so the batch script sets ELECTRON_RUN_AS_NODE=1
      // before calling Code.exe — prevents the GUI window from opening.
      // 'code' alone can resolve to Code.exe on some setups, which opens a window.
      { cmd: 'code.cmd', args: installArgs, shell: true },
      // PowerShell fallback — covers users whose PATH is only set in PS profiles
      { cmd: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-Command', `& code.cmd --install-extension '${safeSpec}' --force`], shell: false },
    ];
  }

  if (process.platform === 'darwin') {
    return [
      { cmd: 'code', args: installArgs, shell: false },
      { cmd: 'code', args: installArgs, shell: true },
      { cmd: '/usr/local/bin/code', args: installArgs, shell: false },
      { cmd: '/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code', args: installArgs, shell: false },
    ];
  }

  // Linux / WSL
  return [
    { cmd: 'code', args: installArgs, shell: false },
    { cmd: 'code', args: installArgs, shell: true },
  ];
}

function installVsCodeExtension(extensionSpec: string): Promise<boolean> {
  return runCandidates(getCandidates(extensionSpec));
}

async function runCandidates(candidates: Candidate[]): Promise<boolean> {
  for (const { cmd, args, shell } of candidates) {
    if (await runCommand(cmd, args, shell)) return true;
  }
  return false;
}

function runCommand(cmd: string, args: string[], shell: boolean): Promise<boolean> {
  return new Promise((resolvePromise) => {
    const child = spawn(cmd, args, { stdio: 'ignore', shell });
    child.on('error', () => resolvePromise(false));
    child.on('close', (code) => resolvePromise(code === 0));
  });
}
