import type { SourceFetch } from '@gamevault/source-core';

import { extractSingleStagedZipArchive } from './services/files.js';
import type { MyJDownloaderService } from './services/myjdownloader.js';
import {
  GameVaultService,
  type DirectHttpDownloadRunner,
  type PlayniteIntegrationPaths,
  type SecureValueProvider,
} from './services/gamevault-service.js';
import type { GameVaultDatabase } from './services/database.js';
import type { dismountIsoImagesUnderPath } from './services/files.js';

interface CreateGameVaultServiceParams {
  database: GameVaultDatabase;
  dismountIsoUnderPath?: typeof dismountIsoImagesUnderPath;
  myJDownloader: MyJDownloaderService;
  notify: (event: 'debug' | 'error' | 'info' | 'warn', message: string) => void;
  pickDirectoryDialog: () => Promise<string | null>;
  playnitePaths?: PlayniteIntegrationPaths;
  secrets: SecureValueProvider;
  showWindow: (trackedItemId?: string) => void;
  sourceFetch?: SourceFetch;
  startDirectHttpDownload?: DirectHttpDownloadRunner;
  steamFetch?: typeof fetch;
}

export function createGameVaultService(
  params: CreateGameVaultServiceParams,
): GameVaultService {
  return new GameVaultService(
    params.database,
    params.myJDownloader,
    params.secrets,
    params.notify,
    params.showWindow,
    params.pickDirectoryDialog,
    params.dismountIsoUnderPath,
    params.sourceFetch,
    params.startDirectHttpDownload,
    extractSingleStagedZipArchive,
    params.steamFetch,
    params.playnitePaths,
  );
}
