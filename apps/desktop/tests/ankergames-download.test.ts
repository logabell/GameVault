import { describe, expect, it } from 'vitest';

import {
  buildAnkerGamesDownloadSaveTarget,
  extractAnkerGamesDownloadFileName,
} from '../src/main/ankergames-download.js';

describe('Ankergames curl downloads', () => {
  it('targets curl downloads inside staging without a manual save picker', () => {
    expect(
      buildAnkerGamesDownloadSaveTarget({
        fallbackBaseName: 'Shape of Dreams',
        fileName: 'Shape:Of<Dreams>.zip',
        stagePath: 'C:\\vault\\_staging\\shape-of-dreams',
      }),
    ).toEqual({
      fileName: 'ShapeOfDreams.zip',
      savePath: 'C:\\vault\\_staging\\shape-of-dreams\\ShapeOfDreams.zip',
    });
  });

  it('adds a zip extension when dlproxy only exposes a token-like URL segment', () => {
    expect(
      buildAnkerGamesDownloadSaveTarget({
        fallbackBaseName: 'Shape of Dreams',
        fileName: 'proxy-token',
        stagePath: 'C:\\vault\\_staging\\shape-of-dreams',
      }),
    ).toEqual({
      fileName: 'proxy-token.zip',
      savePath: 'C:\\vault\\_staging\\shape-of-dreams\\proxy-token.zip',
    });
  });

  it('extracts a download file name from content disposition before saving', () => {
    expect(
      extractAnkerGamesDownloadFileName({
        contentDisposition:
          'attachment; filename="Mouse-P-I-For-Hire-AnkerGames.zip"',
        responseUrl: 'https://tunnel1.dlproxy.uk/download/proxy-token',
      }),
    ).toBe('Mouse-P-I-For-Hire-AnkerGames.zip');
  });
});
