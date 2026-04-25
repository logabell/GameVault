import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';
import { FIREFOX_EXTENSION_ID } from '@gamevault/shared-types';

import { detectBrowserExtension } from '../src/main/services/browser-extension-detection.js';

const EXTENSION_ID = 'abcdefghijklmnopabcdefghijklmnop';
const OTHER_EXTENSION_ID = 'ponmlkjihgfedcbaponmlkjihgfedcba';

function preferences(settings: Record<string, unknown>) {
  return {
    extensions: {
      settings,
    },
  };
}

function browserUserDataPath(localAppData: string, browser: 'chrome' | 'edge') {
  return browser === 'chrome'
    ? join(localAppData, 'Google', 'Chrome', 'User Data')
    : join(localAppData, 'Microsoft', 'Edge', 'User Data');
}

async function writePreferences(params: {
  browser: 'chrome' | 'edge';
  localAppData: string;
  preferences: string | Record<string, unknown>;
  profileName: string;
}) {
  const profileDir = join(
    browserUserDataPath(params.localAppData, params.browser),
    params.profileName,
  );
  await mkdir(profileDir, { recursive: true });
  await writeFile(
    join(profileDir, 'Preferences'),
    typeof params.preferences === 'string'
      ? params.preferences
      : JSON.stringify(params.preferences),
    'utf8',
  );
}

async function writeFirefoxExtensions(params: {
  appData: string;
  extensions: Record<string, unknown>;
  profileName: string;
}) {
  const profileDir = join(
    params.appData,
    'Mozilla',
    'Firefox',
    'Profiles',
    params.profileName,
  );
  await mkdir(profileDir, { recursive: true });
  await writeFile(
    join(profileDir, 'extensions.json'),
    JSON.stringify(params.extensions),
    'utf8',
  );
}

async function withTempRoot<T>(callback: (tempRoot: string) => Promise<T>) {
  const tempRoot = await mkdtemp(join(tmpdir(), 'gamevault-extension-'));
  try {
    return await callback(tempRoot);
  } finally {
    await rm(tempRoot, { force: true, recursive: true });
  }
}

describe('detectBrowserExtension', () => {
  it('reports no install when browser profiles are absent', async () => {
    await withTempRoot(async (tempRoot) => {
      const result = await detectBrowserExtension({
        env: { LOCALAPPDATA: tempRoot },
        extensionPath: join(tempRoot, 'extension', 'dist'),
        now: () => new Date('2026-04-24T14:00:00.000Z'),
      });

      expect(result).toEqual({
        checkedAt: '2026-04-24T14:00:00.000Z',
        detected: false,
        enabled: false,
        installations: [],
        message:
          'GameVault extension was not found in Chrome, Edge, or Firefox. Load the unpacked extension, then refresh detection.',
      });
    });
  });

  it('detects a matching unpacked extension path', async () => {
    await withTempRoot(async (tempRoot) => {
      const extensionPath = join(tempRoot, 'extension', 'dist');
      await writePreferences({
        browser: 'chrome',
        localAppData: tempRoot,
        preferences: preferences({
          [EXTENSION_ID]: {
            manifest: { name: 'Not GameVault' },
            path: extensionPath,
            state: 1,
          },
        }),
        profileName: 'Default',
      });

      const result = await detectBrowserExtension({
        env: { LOCALAPPDATA: tempRoot },
        extensionPath,
        now: () => new Date('2026-04-24T14:05:00.000Z'),
      });

      expect(result.detected).toBe(true);
      expect(result.enabled).toBe(true);
      expect(result.message).toBe(
        'GameVault extension is installed in Chrome Default.',
      );
      expect(result.installations).toHaveLength(1);
      expect(result.installations[0]).toMatchObject({
        browser: 'chrome',
        enabled: true,
        extensionId: EXTENSION_ID,
        installPath: extensionPath,
        manifestName: 'Not GameVault',
        profileName: 'Default',
        state: 1,
      });
    });
  });

  it('detects a disabled extension by manifest name', async () => {
    await withTempRoot(async (tempRoot) => {
      await writePreferences({
        browser: 'edge',
        localAppData: tempRoot,
        preferences: preferences({
          [EXTENSION_ID]: {
            manifest: { name: 'GameVault' },
            path: join(tempRoot, 'different-extension'),
            state: 0,
          },
        }),
        profileName: 'Profile 1',
      });

      const result = await detectBrowserExtension({
        env: { LOCALAPPDATA: tempRoot },
        extensionPath: join(tempRoot, 'extension', 'dist'),
        now: () => new Date('2026-04-24T14:10:00.000Z'),
      });

      expect(result.detected).toBe(true);
      expect(result.enabled).toBe(false);
      expect(result.message).toBe(
        'GameVault extension is installed in Edge Profile 1, but it is disabled.',
      );
      expect(result.installations[0]).toMatchObject({
        browser: 'edge',
        enabled: false,
        extensionId: EXTENSION_ID,
        manifestName: 'GameVault',
        profileName: 'Profile 1',
        state: 0,
      });
    });
  });

  it('reports multiple browser profile installs', async () => {
    await withTempRoot(async (tempRoot) => {
      const extensionPath = join(tempRoot, 'extension', 'dist');
      await writePreferences({
        browser: 'chrome',
        localAppData: tempRoot,
        preferences: preferences({
          [EXTENSION_ID]: {
            manifest: { name: 'GameVault' },
            path: extensionPath,
            state: 1,
          },
        }),
        profileName: 'Default',
      });
      await writePreferences({
        browser: 'edge',
        localAppData: tempRoot,
        preferences: preferences({
          [OTHER_EXTENSION_ID]: {
            manifest: { name: 'GameVault' },
            path: extensionPath,
            state: 0,
          },
        }),
        profileName: 'Profile 1',
      });

      const result = await detectBrowserExtension({
        env: { LOCALAPPDATA: tempRoot },
        extensionPath,
        now: () => new Date('2026-04-24T14:15:00.000Z'),
      });

      expect(result.detected).toBe(true);
      expect(result.enabled).toBe(true);
      expect(result.message).toBe(
        'GameVault extension is installed in 2 browser profiles; 1 is enabled.',
      );
      expect(result.installations.map((install) => install.browser)).toEqual([
        'chrome',
        'edge',
      ]);
    });
  });

  it('detects the Firefox temporary add-on by fixed Gecko ID', async () => {
    await withTempRoot(async (tempRoot) => {
      const extensionPath = join(tempRoot, 'extension', 'dist');
      await writeFirefoxExtensions({
        appData: tempRoot,
        extensions: {
          addons: [
            {
              active: true,
              defaultLocale: { name: 'GameVault' },
              id: FIREFOX_EXTENSION_ID,
              rootURI: `file:///${extensionPath.replace(/\\/g, '/')}/`,
              type: 'extension',
              userDisabled: false,
            },
          ],
        },
        profileName: 'abcd.default-release',
      });

      const result = await detectBrowserExtension({
        env: { APPDATA: tempRoot, LOCALAPPDATA: tempRoot },
        extensionPath,
        now: () => new Date('2026-04-24T14:18:00.000Z'),
      });

      expect(result.detected).toBe(true);
      expect(result.enabled).toBe(true);
      expect(result.message).toBe(
        'GameVault extension is installed in Firefox abcd.default-release.',
      );
      expect(result.installations[0]).toMatchObject({
        browser: 'firefox',
        enabled: true,
        extensionId: FIREFOX_EXTENSION_ID,
        manifestName: 'GameVault',
        profileName: 'abcd.default-release',
        state: 1,
      });
    });
  });

  it('ignores malformed preferences files safely', async () => {
    await withTempRoot(async (tempRoot) => {
      await writePreferences({
        browser: 'chrome',
        localAppData: tempRoot,
        preferences: '{not valid json',
        profileName: 'Default',
      });

      const result = await detectBrowserExtension({
        env: { LOCALAPPDATA: tempRoot },
        extensionPath: join(tempRoot, 'extension', 'dist'),
        now: () => new Date('2026-04-24T14:20:00.000Z'),
      });

      expect(result.detected).toBe(false);
      expect(result.installations).toEqual([]);
    });
  });
});
