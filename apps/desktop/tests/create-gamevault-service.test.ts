import { describe, expect, it, vi } from 'vitest';

import { createGameVaultService } from '../src/main/create-gamevault-service.js';
import { extractSingleStagedZipArchive } from '../src/main/services/files.js';

describe('createGameVaultService', () => {
  it('keeps the staged ZIP extractor separate from steamFetch', () => {
    const steamFetch = vi.fn<typeof fetch>();
    const sourceFetch = vi.fn();

    const service = createGameVaultService({
      database: {} as never,
      myJDownloader: {} as never,
      notify: () => undefined,
      pickDirectoryDialog: async () => null,
      secrets: {
        decrypt: (text) => text,
        encrypt: (text) => text,
      },
      showWindow: () => undefined,
      sourceFetch,
      steamFetch,
    });

    expect((service as never as { extractStagedZipArchive: unknown }).extractStagedZipArchive).toBe(
      extractSingleStagedZipArchive,
    );
    expect((service as never as { steamFetch: unknown }).steamFetch).toBe(
      steamFetch,
    );
  });
});
