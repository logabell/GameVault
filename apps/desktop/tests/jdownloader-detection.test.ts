import { describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';

import { detectJDownloader } from '../src/main/services/jdownloader-detection.js';

describe('detectJDownloader', () => {
  it('detects a known install path and a running process', async () => {
    const localAppData = 'C:\\Users\\Logan\\AppData\\Local';
    const installPath = join(
      localAppData,
      'JDownloader 2.0',
      'JDownloader2.exe',
    );
    const statPath = vi.fn(async (path: string) => {
      if (path === installPath) {
        return {};
      }
      throw new Error('missing');
    });
    const runCommand = vi.fn(async (command: string) => {
      if (command === 'tasklist.exe') {
        return {
          stderr: '',
          stdout: '"JDownloader2.exe","1234","Console","1","50,000 K"',
        };
      }
      throw new Error('not found');
    });

    const result = await detectJDownloader({
      env: { LOCALAPPDATA: localAppData },
      now: () => new Date('2026-04-24T12:00:00.000Z'),
      runCommand,
      statPath,
    });

    expect(result).toMatchObject({
      checkedAt: '2026-04-24T12:00:00.000Z',
      detected: true,
      installed: true,
      installPath,
      running: true,
      source: 'process',
    });
  });

  it('falls back to where.exe when known paths are absent', async () => {
    const runCommand = vi.fn(async (command: string) => {
      if (command === 'where.exe') {
        return {
          stderr: '',
          stdout: 'C:\\Tools\\JDownloader2.exe\r\n',
        };
      }
      return { stderr: '', stdout: '' };
    });

    const result = await detectJDownloader({
      env: {},
      runCommand,
      statPath: vi.fn(async () => {
        throw new Error('missing');
      }),
    });

    expect(result).toMatchObject({
      detected: true,
      installed: true,
      installPath: 'C:\\Tools\\JDownloader2.exe',
      running: false,
      source: 'where',
    });
  });

  it('returns a not detected status when no probes match', async () => {
    const result = await detectJDownloader({
      env: {},
      runCommand: vi.fn(async () => {
        throw new Error('missing');
      }),
      statPath: vi.fn(async () => {
        throw new Error('missing');
      }),
    });

    expect(result).toMatchObject({
      detected: false,
      installed: false,
      installPath: null,
      running: false,
      source: null,
    });
  });
});
