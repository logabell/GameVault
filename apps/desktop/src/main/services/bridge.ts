import { createServer, type Server } from 'node:http';

import type {
  NativeMessageRequest,
  NativeMessageResponse,
  SourceKind,
} from '@vaulttrack/shared-types';

import { VaultTrackService } from './vaulttrack-service.js';

export class NativeBridgeServer {
  private server: Server | null = null;

  constructor(
    private readonly service: VaultTrackService,
    private readonly port = 47615,
  ) {}

  start(): Promise<void> {
    if (this.server) {
      return Promise.resolve();
    }

    this.server = createServer((request, response) => {
      if (request.method !== 'POST' || request.url !== '/native-message') {
        response.writeHead(404).end();
        return;
      }

      const chunks: Buffer[] = [];
      request.on('data', (chunk) => chunks.push(chunk as Buffer));
      request.on('end', async () => {
        try {
          const message = JSON.parse(
            Buffer.concat(chunks).toString('utf8'),
          ) as NativeMessageRequest;
          const payload = await this.handleMessage(message);
          response.setHeader('Content-Type', 'application/json');
          response.end(JSON.stringify(payload));
        } catch (error) {
          response.statusCode = 500;
          response.setHeader('Content-Type', 'application/json');
          response.end(
            JSON.stringify({
              error: {
                code: 'BRIDGE_REQUEST_ERROR',
                message:
                  error instanceof Error
                    ? error.message
                    : 'Unexpected native bridge request error',
              },
              ok: false,
              type: 'getConnectionHealth',
            } satisfies NativeMessageResponse),
          );
        }
      });
    });

    return new Promise((resolve, reject) => {
      this.server?.once('error', reject);
      this.server?.listen(this.port, '127.0.0.1', () => resolve());
    });
  }

  stop(): Promise<void> {
    if (!this.server) {
      return Promise.resolve();
    }

    return new Promise((resolve, reject) => {
      this.server?.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        this.server = null;
        resolve();
      });
    });
  }

  private async handleMessage(
    request: NativeMessageRequest,
  ): Promise<NativeMessageResponse> {
    try {
      switch (request.type) {
        case 'addTrackedItem':
          return {
            ok: true,
            payload: await this.service.addTrackedItem(request.payload),
            type: request.type,
          };
        case 'getTrackedItemStatus':
          return {
            ok: true,
            payload: await this.service.getTrackedItemStatusBySourceUrl(
              request.payload.sourceUrl,
            ),
            type: request.type,
          };
        case 'resolveSteamMatch':
          return {
            ok: true,
            payload: await this.service.resolveSteamMatch(
              request.payload.title,
              request.payload.sourceKind as SourceKind,
              request.payload.sourceUrl,
              request.payload.queryTitle ?? request.payload.manualQuery ?? null,
            ),
            type: request.type,
          };
        case 'resolveSteamPatches':
          return {
            ok: true,
            payload: await this.service.resolveSteamPatches(
              request.payload.appId,
            ),
            type: request.type,
          };
        case 'listPendingSteamDbBuildLookups':
          return {
            ok: true,
            payload: this.service.listPendingSteamDbBuildLookups(),
            type: request.type,
          };
        case 'completeSteamDbBuildLookup':
          return {
            ok: true,
            payload: this.service.completeSteamDbBuildLookup(request.payload),
            type: request.type,
          };
        case 'cacheSteamDbBuildLookup':
          return {
            ok: true,
            payload: this.service.cacheSteamDbBuildLookup(request.payload),
            type: request.type,
          };
        case 'updateSteamDbBuildLookup':
          return {
            ok: true,
            payload: this.service.updateSteamDbBuildLookup(request.payload),
            type: request.type,
          };
        case 'refreshTrackedItem':
          return {
            ok: true,
            payload: await this.service.refreshTrackedItem(
              request.payload.trackedItemId,
            ),
            type: request.type,
          };
        case 'updateSourcePatch':
          return {
            ok: true,
            payload: await this.service.updateSourcePatch(request.payload),
            type: request.type,
          };
        case 'markDownloadFailed':
          return {
            ok: true,
            payload: await this.service.markDownloadFailed(
              request.payload.trackedItemId,
            ),
            type: request.type,
          };
        case 'completeStagedInstall':
          return {
            ok: true,
            payload: await this.service.completeStagedInstall(
              request.payload.trackedItemId,
            ),
            type: request.type,
          };
        case 'retryDownload':
          return {
            ok: true,
            payload: await this.service.retryDownload(
              request.payload.trackedItemId,
              request.payload.selectedDownloads,
            ),
            type: request.type,
          };
        case 'clearDownloadMirrorFailed':
          return {
            ok: true,
            payload: await this.service.markDownloadMirrorFailed(
              request.payload.trackedItemId,
              request.payload.url,
              false,
            ),
            type: request.type,
          };
        case 'openDesktop':
          return {
            ok: true,
            payload: this.service.openDesktop(request.payload.trackedItemId),
            type: request.type,
          };
        case 'getConnectionHealth':
          return {
            ok: true,
            payload: await this.service.getConnectionHealth(),
            type: request.type,
          };
        case 'authenticateMyJDownloader':
          return {
            ok: true,
            payload: await this.service.authenticateMyJDownloader(
              request.payload.email,
              request.payload.password,
            ),
            type: request.type,
          };
        case 'selectMyJDownloaderDevice':
          return {
            ok: true,
            payload: await this.service.selectMyJDownloaderDevice(
              request.payload.deviceId,
            ),
            type: request.type,
          };
        case 'disconnectMyJDownloader':
          return {
            ok: true,
            payload: await this.service.disconnectMyJDownloader(),
            type: request.type,
          };
        case 'listTrackedItems':
          return {
            ok: true,
            payload: await this.service.listTrackedItems(),
            type: request.type,
          };
        case 'removeTrackedItem':
          return {
            ok: true,
            payload: await this.service.removeTrackedItem(request.payload),
            type: request.type,
          };
        case 'getSettings':
          return {
            ok: true,
            payload: this.service.getSettings(),
            type: request.type,
          };
        case 'saveSettings':
          return {
            ok: true,
            payload: this.service.saveSettings(request.payload),
            type: request.type,
          };
        case 'pickDirectory':
          return {
            ok: true,
            payload: await this.service.pickDirectory(),
            type: request.type,
          };
        default: {
          const unsupportedRequest = request as { type?: string };
          return {
            error: {
              code: 'NATIVE_MESSAGE_ERROR',
              message: `Unsupported native message type: ${unsupportedRequest.type ?? 'unknown'}`,
            },
            ok: false,
            type: unsupportedRequest.type as NativeMessageRequest['type'],
          };
        }
      }
    } catch (error) {
      return {
        error: {
          code: 'NATIVE_MESSAGE_ERROR',
          message:
            error instanceof Error
              ? error.message
              : 'Unknown native message error',
        },
        ok: false,
        type: request.type,
      };
    }
  }
}
