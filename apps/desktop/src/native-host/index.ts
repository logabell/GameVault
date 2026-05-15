import { spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';

import type {
  NativeMessageRequest,
  NativeMessageResponse,
} from '@gamevault/shared-types';

const BRIDGE_URL = 'http://127.0.0.1:47615/native-message';
const BRIDGE_POST_TIMEOUT_MS = 75000;
const MAX_NATIVE_MESSAGE_BYTES = 1024 * 1024;
const require = createRequire(__filename);

function encodeMessage(message: NativeMessageResponse): Buffer {
  const payload = Buffer.from(JSON.stringify(message), 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(payload.length, 0);
  return Buffer.concat([header, payload]);
}

function readMessage(): Promise<NativeMessageRequest | null> {
  return new Promise((resolveMessage, rejectMessage) => {
    let input = Buffer.alloc(0);
    let expectedPayloadSize: number | null = null;

    const cleanup = () => {
      process.stdin.off('data', handleData);
      process.stdin.off('end', handleEnd);
      process.stdin.off('error', handleError);
    };

    const readBufferedMessage = () => {
      if (expectedPayloadSize == null) {
        if (input.length < 4) {
          return false;
        }

        expectedPayloadSize = input.readUInt32LE(0);
        if (
          expectedPayloadSize <= 0 ||
          expectedPayloadSize > MAX_NATIVE_MESSAGE_BYTES
        ) {
          throw new Error('Native message payload size is invalid.');
        }
      }

      const totalSize = 4 + expectedPayloadSize;
      if (input.length < totalSize) {
        return false;
      }

      const payload = input.subarray(4, totalSize).toString('utf8');
      cleanup();
      resolveMessage(JSON.parse(payload) as NativeMessageRequest);
      return true;
    };

    function handleData(chunk: Buffer | string) {
      try {
        input = Buffer.concat([
          input,
          Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk),
        ]);
        readBufferedMessage();
      } catch (error) {
        cleanup();
        rejectMessage(error);
      }
    }

    function handleEnd() {
      cleanup();
      if (input.length === 0) {
        resolveMessage(null);
        return;
      }
      rejectMessage(new Error('Native message stream ended early.'));
    }

    function handleError(error: Error) {
      cleanup();
      rejectMessage(error);
    }

    process.stdin.on('data', handleData);
    process.stdin.once('end', handleEnd);
    process.stdin.once('error', handleError);
    process.stdin.resume();
  });
}

function getDesktopRoot(): string {
  return resolve(__dirname, '..', '..');
}

function getElectronExecutable(): string {
  if (process.versions.electron && process.execPath) {
    return process.execPath;
  }

  try {
    const packageJsonPath = require.resolve('electron/package.json', {
      paths: [getDesktopRoot()],
    });
    return join(
      dirname(packageJsonPath),
      'dist',
      process.platform === 'win32' ? 'electron.exe' : 'electron',
    );
  } catch {
    return process.execPath;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

async function postBridge(
  request: NativeMessageRequest,
): Promise<NativeMessageResponse> {
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
      throw new Error(
        `GameVault desktop bridge returned ${bridgeResponse.status}.`,
      );
    }
    return (await bridgeResponse.json()) as NativeMessageResponse;
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new Error('GameVault desktop bridge timed out.');
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function startDesktopInBackground(): void {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(
    getElectronExecutable(),
    [getDesktopRoot(), '--background'],
    {
      detached: true,
      env,
      stdio: 'ignore',
      windowsHide: true,
    },
  );
  child.unref();
}

async function ensureBridge(
  request: NativeMessageRequest,
): Promise<NativeMessageResponse> {
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

  throw lastError instanceof Error
    ? lastError
    : new Error('GameVault desktop bridge is unavailable');
}

async function main() {
  let exitCode = 0;

  try {
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
              : 'GameVault desktop bridge is unavailable',
        },
        ok: false,
        type: request.type,
      };
    }

    await new Promise<void>((resolveWrite, rejectWrite) => {
      process.stdout.write(encodeMessage(response), (error) => {
        if (error) {
          rejectWrite(error);
          return;
        }
        resolveWrite();
      });
    });
  } catch (error) {
    exitCode = 1;
    console.error(
      error instanceof Error ? error.message : 'Native host failed.',
    );
  } finally {
    process.exit(exitCode);
  }
}

void main();
