import type { ParsedSourcePayload } from '@vaulttrack/shared-types';
import {
  isAnkerGamesDirectDownloadUrl,
  isAnkerGamesProxyDownloadUrl,
  resolveAnkerGamesBrowserDownloadUrl,
  type SourceFetch,
} from '@vaulttrack/source-core';

export interface AnkergamesBrowserDownloadCapture {
  browserDownloadUrl: string;
  url: string;
}

function normalizeComparableUrl(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }

  try {
    const parsedUrl = new URL(value);
    parsedUrl.hash = '';
    return parsedUrl.toString().replace(/\/$/, '').toLowerCase();
  } catch {
    return value.trim().replace(/\/$/, '').toLowerCase() || null;
  }
}

export function isAnkergamesBrowserDownloadUrl(
  value: string | null | undefined,
): value is string {
  return Boolean(
    value &&
      (isAnkerGamesProxyDownloadUrl(value) ||
        isAnkerGamesDirectDownloadUrl(value)),
  );
}

export function mergeAnkergamesBrowserDownloadsIntoParsedSource(
  parsedSource: ParsedSourcePayload,
  downloads: AnkergamesBrowserDownloadCapture[] | null | undefined,
): ParsedSourcePayload {
  if (
    parsedSource.sourceKind !== 'ankergames' ||
    !downloads ||
    downloads.length === 0
  ) {
    return parsedSource;
  }

  const captures = new Map<string, string>();
  for (const download of downloads) {
    if (!isAnkergamesBrowserDownloadUrl(download.browserDownloadUrl)) {
      continue;
    }
    const stableUrl = normalizeComparableUrl(download.url);
    if (!stableUrl) {
      continue;
    }
    captures.set(stableUrl, download.browserDownloadUrl);
  }

  if (captures.size === 0) {
    return parsedSource;
  }

  let changed = false;
  const fullDownloadUrls = parsedSource.fullDownloadUrls.map((download) => {
    const browserDownloadUrl =
      captures.get(normalizeComparableUrl(download.url) ?? '') ??
      download.browserDownloadUrl ??
      null;
    if (!browserDownloadUrl || browserDownloadUrl === download.browserDownloadUrl) {
      return download;
    }
    changed = true;
    return {
      ...download,
      browserDownloadUrl,
    };
  });

  return changed
    ? {
        ...parsedSource,
        fullDownloadUrls,
      }
    : parsedSource;
}

export async function enrichParsedSourceWithAnkergamesBrowserDownloads(
  parsedSource: ParsedSourcePayload,
  fetchFn: SourceFetch,
): Promise<ParsedSourcePayload> {
  if (
    parsedSource.sourceKind !== 'ankergames' ||
    parsedSource.fullDownloadUrls.length === 0
  ) {
    return parsedSource;
  }

  const captures: AnkergamesBrowserDownloadCapture[] = [];

  for (const download of parsedSource.fullDownloadUrls) {
    if (isAnkergamesBrowserDownloadUrl(download.browserDownloadUrl)) {
      captures.push({
        browserDownloadUrl: download.browserDownloadUrl,
        url: download.url,
      });
      continue;
    }

    try {
      const browserDownloadUrl = await resolveAnkerGamesBrowserDownloadUrl({
        fetch: fetchFn,
        sourceUrl: parsedSource.sourceUrl,
        stableDownloadUrl: download.url,
      });
      if (!isAnkergamesBrowserDownloadUrl(browserDownloadUrl)) {
        continue;
      }
      captures.push({
        browserDownloadUrl,
        url: download.url,
      });
    } catch {
      // Keep the stable generated mirror when background resolution is unavailable.
    }
  }

  return mergeAnkergamesBrowserDownloadsIntoParsedSource(
    parsedSource,
    captures,
  );
}
