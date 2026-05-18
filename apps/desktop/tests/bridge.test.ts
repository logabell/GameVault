import { createServer } from 'node:net';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ConnectionHealthSummary } from '@gamevault/shared-types';

import type { GameVaultService } from '../src/main/services/gamevault-service.js';
import { NativeBridgeServer } from '../src/main/services/bridge.js';

const healthyConnection: ConnectionHealthSummary = {
  desktop: {
    color: 'green',
    label: 'Desktop ready',
    message: 'GameVault desktop bridge is available.',
  },
  devices: [],
  myJDownloader: {
    color: 'green',
    label: 'JDownloader',
    message: 'MyJDownloader is authenticated and ready for queued downloads.',
  },
  selectedDeviceId: null,
};

async function getAvailablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        if (!address || typeof address === 'string') {
          reject(new Error('Unable to allocate bridge test port.'));
          return;
        }
        resolve(address.port);
      });
    });
  });
}

describe('NativeBridgeServer', () => {
  let bridge: NativeBridgeServer | null = null;

  afterEach(async () => {
    await bridge?.stop();
    bridge = null;
    vi.restoreAllMocks();
  });

  it('serves health even when extension activity recording fails', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const service = {
      getConnectionHealth: vi.fn(async () => healthyConnection),
      recordExtensionActivity: vi.fn(() => {
        throw new Error('activity write failed');
      }),
    } as unknown as GameVaultService;
    const port = await getAvailablePort();
    bridge = new NativeBridgeServer(service, port);
    await bridge.start();

    const response = await fetch(`http://127.0.0.1:${port}/native-message`, {
      body: JSON.stringify({ payload: {}, type: 'getConnectionHealth' }),
      headers: { 'Content-Type': 'application/json' },
      method: 'POST',
    });
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload).toEqual({
      ok: true,
      payload: healthyConnection,
      type: 'getConnectionHealth',
    });
    expect(service.recordExtensionActivity).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(
      'Unable to record extension activity: activity write failed',
    );
  });

  it('returns native-message JSON for malformed requests instead of HTTP 500', async () => {
    const service = {
      getConnectionHealth: vi.fn(async () => healthyConnection),
      recordExtensionActivity: vi.fn(),
    } as unknown as GameVaultService;
    const port = await getAvailablePort();
    bridge = new NativeBridgeServer(service, port);
    await bridge.start();

    const response = await fetch(`http://127.0.0.1:${port}/native-message`, {
      body: JSON.stringify(null),
      headers: { 'Content-Type': 'application/json' },
      method: 'POST',
    });
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload).toMatchObject({
      error: {
        code: 'BRIDGE_REQUEST_ERROR',
        message: 'Native bridge request is missing a message type.',
      },
      ok: false,
      type: 'getConnectionHealth',
    });
    expect(service.recordExtensionActivity).not.toHaveBeenCalled();
  });

  it('preserves non-Error service failure messages', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const service = {
      listTrackedItems: vi.fn(() => Promise.reject('Nothing to prepare')),
      recordExtensionActivity: vi.fn(),
    } as unknown as GameVaultService;
    const port = await getAvailablePort();
    bridge = new NativeBridgeServer(service, port);
    await bridge.start();

    const response = await fetch(`http://127.0.0.1:${port}/native-message`, {
      body: JSON.stringify({ payload: {}, type: 'listTrackedItems' }),
      headers: { 'Content-Type': 'application/json' },
      method: 'POST',
    });
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload).toMatchObject({
      error: {
        code: 'NATIVE_MESSAGE_ERROR',
        message: 'Nothing to prepare',
      },
      ok: false,
      type: 'listTrackedItems',
    });
    expect(warnSpy).toHaveBeenCalledWith(
      'Native message listTrackedItems failed: Nothing to prepare',
    );
  });
});
