import type { SourceFetch } from '@vaulttrack/source-core';

import { extractSingleStagedZipArchive } from './services/files.js';
import type { MyJDownloaderService } from './services/myjdownloader.js';
import {
  VaultTrackService,
  type AnkerGamesEmbeddedBrowserDownloadRunner,
  type SecureValueProvider,
} from './services/vaulttrack-service.js';
import type { VaultTrackDatabase } from './services/database.js';
import type { AnkerGamesSignedDownloadPageRenderer } from '@vaulttrack/source-core';
import type { dismountIsoImagesUnderPath } from './services/files.js';

export interface CreateVaultTrackServiceParams {
  database: VaultTrackDatabase;
  dismountIsoUnderPath?: typeof dismountIsoImagesUnderPath;
  myJDownloader: MyJDownloaderService;
  notify: (event: 'debug' | 'error' | 'info' | 'warn', message: string) => void;
  pickDirectoryDialog: () => Promise<string | null>;
  renderAnkerGamesSignedDownloadPage?: AnkerGamesSignedDownloadPageRenderer;
  secrets: SecureValueProvider;
  showWindow: (trackedItemId?: string) => void;
  sourceFetch?: SourceFetch;
  startAnkerGamesEmbeddedDownload?: AnkerGamesEmbeddedBrowserDownloadRunner;
  steamFetch?: typeof fetch;
}

export function createVaultTrackService(
  params: CreateVaultTrackServiceParams,
): VaultTrackService {
  return new VaultTrackService(
    params.database,
    params.myJDownloader,
    params.secrets,
    params.notify,
    params.showWindow,
    params.pickDirectoryDialog,
    params.dismountIsoUnderPath,
    params.sourceFetch,
    params.renderAnkerGamesSignedDownloadPage,
    params.startAnkerGamesEmbeddedDownload,
    extractSingleStagedZipArchive,
    params.steamFetch,
  );
}
