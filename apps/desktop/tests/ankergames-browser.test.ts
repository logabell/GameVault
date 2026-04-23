import { describe, expect, it, vi } from 'vitest';

import {
  buildAnkerGamesDownloadSaveTarget,
  configureAnkerGamesDownloadSession,
  extractAnkerGamesDownloadFileName,
  isAnkerGamesAbortLikeError,
  isAnkerGamesInterceptLikeError,
  shouldIgnoreAnkerGamesNavigationAbort,
} from '../src/main/ankergames-browser.js';

describe('Ankergames browser abort handling', () => {
  it('recognizes Electron abort-style navigation errors', () => {
    expect(
      isAnkerGamesAbortLikeError({
        error: new Error('signal is aborted without reason'),
      }),
    ).toBe(true);
    expect(
      isAnkerGamesAbortLikeError({
        errorCode: -3,
      }),
    ).toBe(true);
    expect(
      isAnkerGamesAbortLikeError({
        errorDescription: 'net::ERR_ABORTED',
      }),
    ).toBe(true);
  });

  it('recognizes Electron blocked-by-client interruptions from intercepted browser downloads', () => {
    expect(
      isAnkerGamesInterceptLikeError({
        error: new Error('net::ERR_BLOCKED_BY_CLIENT'),
      }),
    ).toBe(true);
    expect(
      shouldIgnoreAnkerGamesNavigationAbort({
        downloadRequested: true,
        error: new Error('net::ERR_BLOCKED_BY_CLIENT'),
        interceptedCandidateUrl:
          'https://node42.datanodes.to/d/token/Shape-Of-Dreams-AnkerGames.zip',
      }),
    ).toBe(true);
  });

  it('ignores aborts after a browser download request has already been intercepted', () => {
    expect(
      shouldIgnoreAnkerGamesNavigationAbort({
        downloadRequested: true,
        error: new Error('signal is aborted without reason'),
        interceptedCandidateUrl:
          'https://tunnel1.dlproxy.uk/download/proxy-token?sig=proxy-signature',
      }),
    ).toBe(true);
  });

  it('does not ignore non-abort failures before any Ankergames download candidate is intercepted', () => {
    expect(
      shouldIgnoreAnkerGamesNavigationAbort({
        downloadRequested: false,
        error: new Error('Navigation failed with 500'),
        interceptedCandidateUrl: null,
      }),
    ).toBe(false);
  });

  it('targets hidden browser downloads inside staging without a manual save picker', () => {
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

  it('configures the hidden browser session to save directly into staging', () => {
    const setDownloadPath = vi.fn();

    configureAnkerGamesDownloadSession(
      { setDownloadPath },
      'C:\\vault\\_staging\\shape-of-dreams',
    );

    expect(setDownloadPath).toHaveBeenCalledWith(
      'C:\\vault\\_staging\\shape-of-dreams',
    );
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
