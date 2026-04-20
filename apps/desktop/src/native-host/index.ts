import { spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';

import type {
  NativeMessageRequest,
  NativeMessageResponse,
} from '@vaulttrack/shared-types';

const BRIDGE_URL = 'http://127.0.0.1:47615/native-message';
const BRIDGE_POST_TIMEOUT_MS = 10000;
const require = createRequire(__filename);

function encodeMessage(message: NativeMessageResponse): Buffer {
  const payload = Buffer.from(JSON.stringify(message), 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(payload.length, 0);
  return Buffer.concat([header, payload]);
}

async function readMessage(): Promise<NativeMessageRequest | null> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }

  if (chunks.length === 0) {
    return null;
  }

  const input = Buffer.concat(chunks);
  const size = input.readUInt32LE(0);
  const payload = input.subarray(4, 4 + size).toString('utf8');
  return JSON.parse(payload) as NativeMessageRequest;
}

function getDesktopRoot(): string {
  return resolve(__dirname, '..', '..');
}

function getElectronExecutable(): string {
  const packageJsonPath = require.resolve('electron/package.json', {
    paths: [getDesktopRoot()],
  });
  return join(dirname(packageJsonPath), 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

async function postBridge(request: NativeMessageRequest): Promise<NativeMessageResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), BRIDGE_POST_TIMEOUT_MS);

  try {
    const bridgeResponse = await fetch(BRIDGE_URL, {
      body: JSON.stringify(request),
      headers: {
        'Content-Type': 'application/json',
      },
      method: 'POST',
      signal: controller.signal,
    });
    if (!bridgeResponse.ok) {
      throw new Error(`VaultTrack desktop bridge returned ${bridgeResponse.status}.`);
    }
    return (await bridgeResponse.json()) as NativeMessageResponse;
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new Error('VaultTrack desktop bridge timed out.');
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function startDesktopInBackground(): void {
  const child = spawn(getElectronExecutable(), [getDesktopRoot(), '--background'], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
}

async function ensureBridge(request: NativeMessageRequest): Promise<NativeMessageResponse> {
  try {
    return await postBridge(request);
  } catch {
    startDesktopInBackground();
  }

  const deadline = Date.now() + 15000;
  let lastError: unknown = null;
  while (Date.now() < deadline) {
    try {
      return await postBridge(request);
    } catch (error) {
      lastError = error;
      await sleep(250);
    }
  }

  throw lastError instanceof Error ? lastError : new Error('VaultTrack desktop bridge is unavailable');
}

async function main() {
  const request = await readMessage();
  if (!request) {
    return;
  }

  let response: NativeMessageResponse;
  try {
    response = await ensureBridge(request);
  } catch (error) {
    response = {
      error: {
        code: 'DESKTOP_UNAVAILABLE',
        message:
          error instanceof Error
            ? error.message
            : 'VaultTrack desktop bridge is unavailable',
      },
      ok: false,
      type: request.type,
    };
  }

  process.stdout.write(encodeMessage(response));
}

void main();
