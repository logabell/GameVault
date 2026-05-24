import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  getAsarUnpackedPath,
  prepareBrowserExtensionInstall,
} from '../src/main/services/extension-setup.js';

async function withTempRoot<T>(callback: (tempRoot: string) => Promise<T>) {
  const tempRoot = await mkdtemp(join(tmpdir(), 'gamevault-extension-setup-'));
  try {
    return await callback(tempRoot);
  } finally {
    await rm(tempRoot, { force: true, recursive: true });
  }
}

describe('extension setup helpers', () => {
  it('maps packaged app.asar paths to the unpacked resources folder', () => {
    expect(
      getAsarUnpackedPath(
        'D:\\Apps\\GameVault\\resources\\app.asar\\dist\\extension',
      ),
    ).toBe(
      'D:\\Apps\\GameVault\\resources\\app.asar.unpacked\\dist\\extension',
    );
  });

  it('copies the bundled extension to a browser-readable target folder', async () => {
    await withTempRoot(async (tempRoot) => {
      const sourceExtensionPath = join(tempRoot, 'resources', 'extension');
      const targetExtensionPath = join(tempRoot, 'userData', 'BrowserExtension');
      await mkdir(join(sourceExtensionPath, 'icons'), { recursive: true });
      await writeFile(
        join(sourceExtensionPath, 'manifest.json'),
        JSON.stringify({ name: 'GameVault', version: '1.2.0' }),
        'utf8',
      );
      await writeFile(
        join(sourceExtensionPath, 'icons', 'gamevault-16.png'),
        'png',
        'utf8',
      );

      await expect(
        prepareBrowserExtensionInstall({
          sourceExtensionPath,
          targetExtensionPath,
        }),
      ).resolves.toBe(true);

      await expect(
        readFile(join(targetExtensionPath, 'manifest.json'), 'utf8'),
      ).resolves.toContain('"GameVault"');
      await expect(
        readFile(join(targetExtensionPath, 'icons', 'gamevault-16.png'), 'utf8'),
      ).resolves.toBe('png');
    });
  });

  it('keeps an existing prepared folder usable if the bundled source is unavailable', async () => {
    await withTempRoot(async (tempRoot) => {
      const targetExtensionPath = join(tempRoot, 'userData', 'BrowserExtension');
      await mkdir(targetExtensionPath, { recursive: true });
      await writeFile(
        join(targetExtensionPath, 'manifest.json'),
        JSON.stringify({ name: 'GameVault', version: '1.2.0' }),
        'utf8',
      );

      await expect(
        prepareBrowserExtensionInstall({
          sourceExtensionPath: join(tempRoot, 'missing-source'),
          targetExtensionPath,
        }),
      ).resolves.toBe(true);
    });
  });
});
