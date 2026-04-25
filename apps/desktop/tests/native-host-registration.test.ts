import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FIREFOX_EXTENSION_ID } from '@gamevault/shared-types';

import {
  GAMEVAULT_NATIVE_HOST_NAME,
  isValidBrowserExtensionId,
  registerExtensionNativeHost,
} from '../src/main/services/native-host-registration.js';

describe('registerExtensionNativeHost', () => {
  it('writes the native host manifest and registers Chrome and Edge', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'gamevault-native-host-'));
    const runCommand = vi.fn(async () => undefined);

    try {
      const result = await registerExtensionNativeHost({
        browsers: ['chrome', 'edge'],
        extensionId: 'abcdefghijklmnopabcdefghijklmnop',
        localAppData: tempRoot,
        nativeHostBundlePath: 'C:\\GameVault\\native-host\\index.cjs',
        now: () => new Date('2026-04-24T13:00:00.000Z'),
        runCommand,
      });

      expect(result).toMatchObject({
        browsers: ['chrome', 'edge'],
        extensionId: 'abcdefghijklmnopabcdefghijklmnop',
        registeredAt: '2026-04-24T13:00:00.000Z',
      });

      const manifest = JSON.parse(await readFile(result.manifestPath, 'utf8'));
      expect(manifest).toEqual({
        allowed_origins: [
          'chrome-extension://abcdefghijklmnopabcdefghijklmnop/',
        ],
        description: 'GameVault Native Messaging Host',
        name: GAMEVAULT_NATIVE_HOST_NAME,
        path: result.launcherPath,
        type: 'stdio',
      });

      expect(runCommand).toHaveBeenCalledWith('reg.exe', [
        'add',
        `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${GAMEVAULT_NATIVE_HOST_NAME}`,
        '/ve',
        '/t',
        'REG_SZ',
        '/d',
        result.manifestPath,
        '/f',
      ]);
      expect(runCommand).toHaveBeenCalledWith('reg.exe', [
        'add',
        `HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts\\${GAMEVAULT_NATIVE_HOST_NAME}`,
        '/ve',
        '/t',
        'REG_SZ',
        '/d',
        result.manifestPath,
        '/f',
      ]);
    } finally {
      await rm(tempRoot, { force: true, recursive: true });
    }
  });

  it('rejects invalid extension IDs', async () => {
    await expect(
      registerExtensionNativeHost({
        browsers: ['chrome'],
        extensionId: 'not-a-valid-id',
        nativeHostBundlePath: 'native-host.cjs',
        runCommand: vi.fn(async () => undefined),
      }),
    ).rejects.toThrow('valid Chrome or Edge extension ID');
  });

  it('writes a Firefox native host manifest with allowed extensions', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'gamevault-native-host-'));
    const runCommand = vi.fn(async () => undefined);

    try {
      const result = await registerExtensionNativeHost({
        browsers: ['firefox'],
        extensionId: FIREFOX_EXTENSION_ID,
        localAppData: tempRoot,
        nativeHostBundlePath: 'C:\\GameVault\\native-host\\index.cjs',
        now: () => new Date('2026-04-24T13:30:00.000Z'),
        runCommand,
      });

      expect(result).toMatchObject({
        browsers: ['firefox'],
        extensionId: FIREFOX_EXTENSION_ID,
        registeredAt: '2026-04-24T13:30:00.000Z',
      });

      const manifest = JSON.parse(await readFile(result.manifestPath, 'utf8'));
      expect(manifest).toEqual({
        allowed_extensions: [FIREFOX_EXTENSION_ID],
        description: 'GameVault Native Messaging Host',
        name: GAMEVAULT_NATIVE_HOST_NAME,
        path: result.launcherPath,
        type: 'stdio',
      });

      expect(runCommand).toHaveBeenCalledWith('reg.exe', [
        'add',
        `HKCU\\Software\\Mozilla\\NativeMessagingHosts\\${GAMEVAULT_NATIVE_HOST_NAME}`,
        '/ve',
        '/t',
        'REG_SZ',
        '/d',
        result.manifestPath,
        '/f',
      ]);
    } finally {
      await rm(tempRoot, { force: true, recursive: true });
    }
  });

  it('validates browser extension IDs', () => {
    expect(isValidBrowserExtensionId('abcdefghijklmnopabcdefghijklmnop')).toBe(
      true,
    );
    expect(isValidBrowserExtensionId('abcdefghijklmnopabcdefghijklmnoq')).toBe(
      false,
    );
    expect(isValidBrowserExtensionId(FIREFOX_EXTENSION_ID, 'firefox')).toBe(
      true,
    );
    expect(isValidBrowserExtensionId('not-firefox', 'firefox')).toBe(false);
  });
});
