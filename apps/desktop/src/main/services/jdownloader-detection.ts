import { execFile } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';

import type { JDownloaderInstallStatus } from '@gamevault/shared-types';

interface CommandResult {
  stderr: string;
  stdout: string;
}

interface JDownloaderDetectionOptions {
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  runCommand?: (command: string, args: string[]) => Promise<CommandResult>;
  statPath?: (path: string) => Promise<unknown>;
}

const JD_PROCESS_NAMES = ['JDownloader2.exe', 'JDownloader.exe'];
const JD_EXECUTABLE_NAMES = ['JDownloader2.exe', 'JDownloader.exe'];

function defaultRunCommand(
  command: string,
  args: string[],
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { windowsHide: true }, (error, stdout, stderr) => {
      if (error) {
        reject(error);
        return;
      }
      resolve({ stderr, stdout });
    });
  });
}

function knownInstallPaths(env: NodeJS.ProcessEnv): string[] {
  const candidates: string[] = [];
  const folders = [
    env.LOCALAPPDATA,
    env.ProgramFiles,
    env['ProgramFiles(x86)'],
    env.USERPROFILE ? join(env.USERPROFILE, 'AppData', 'Local') : null,
  ].filter((entry): entry is string => Boolean(entry?.trim()));

  for (const folder of folders) {
    candidates.push(
      join(folder, 'JDownloader 2.0', 'JDownloader2.exe'),
      join(folder, 'JDownloader', 'JDownloader.exe'),
    );
  }

  return [...new Set(candidates)];
}

async function firstExistingPath(
  paths: string[],
  statPath: (path: string) => Promise<unknown>,
): Promise<string | null> {
  for (const path of paths) {
    try {
      await statPath(path);
      return path;
    } catch {
      // Keep probing candidate locations.
    }
  }
  return null;
}

async function detectRunningJDownloader(
  runCommand: (command: string, args: string[]) => Promise<CommandResult>,
): Promise<boolean> {
  try {
    const result = await runCommand('tasklist.exe', ['/FO', 'CSV', '/NH']);
    const output = result.stdout.toLowerCase();
    return JD_PROCESS_NAMES.some((name) => output.includes(name.toLowerCase()));
  } catch {
    return false;
  }
}

async function detectWherePath(
  runCommand: (command: string, args: string[]) => Promise<CommandResult>,
): Promise<string | null> {
  for (const executable of JD_EXECUTABLE_NAMES) {
    try {
      const result = await runCommand('where.exe', [executable]);
      const match = result.stdout
        .split(/\r?\n/g)
        .map((line) => line.trim())
        .find(Boolean);
      if (match) {
        return match;
      }
    } catch {
      // where.exe exits non-zero when a command is not on PATH.
    }
  }
  return null;
}

export async function detectJDownloader(
  options: JDownloaderDetectionOptions = {},
): Promise<JDownloaderInstallStatus> {
  const env = options.env ?? process.env;
  const now = options.now ?? (() => new Date());
  const runCommand = options.runCommand ?? defaultRunCommand;
  const statPath = options.statPath ?? stat;
  const checkedAt = now().toISOString();

  const [running, knownPath, wherePath] = await Promise.all([
    detectRunningJDownloader(runCommand),
    firstExistingPath(knownInstallPaths(env), statPath),
    detectWherePath(runCommand),
  ]);

  const installPath = knownPath ?? wherePath;
  const source = running
    ? 'process'
    : knownPath
      ? 'known-path'
      : wherePath
        ? 'where'
        : null;
  const detected = running || Boolean(installPath);

  return {
    checkedAt,
    detected,
    installed: Boolean(installPath),
    installPath,
    message: detected
      ? running
        ? 'JDownloader is running and ready for setup.'
        : `JDownloader was found at ${installPath}.`
      : 'JDownloader was not found on this system.',
    running,
    source,
  };
}
