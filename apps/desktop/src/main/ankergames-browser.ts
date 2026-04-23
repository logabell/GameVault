import { join } from 'node:path';

import {
  isAnkerGamesDirectDownloadUrl,
  isAnkerGamesProxyDownloadUrl,
} from '@vaulttrack/source-core';

function errorMessageFromUnknown(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error ?? '');
}

function sanitizeAnkerGamesDownloadFileName(
  fileName: string | null | undefined,
  fallbackBaseName: string,
): string {
  const sanitized = (fileName ?? '')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '')
    .trim();
  if (sanitized) {
    return sanitized;
  }
  return `${fallbackBaseName}.zip`;
}

function decodeContentDispositionValue(value: string): string {
  const trimmed = value.trim().replace(/^"(.*)"$/s, '$1');
  try {
    return decodeURIComponent(trimmed);
  } catch {
    return trimmed;
  }
}

export function extractAnkerGamesDownloadFileName(params: {
  contentDisposition?: string | null;
  responseUrl?: string | null;
}): string | null {
  const contentDisposition = params.contentDisposition ?? '';
  const extendedMatch = contentDisposition.match(
    /filename\*\s*=\s*(?:UTF-8''|utf-8''|)([^;]+)/i,
  );
  if (extendedMatch?.[1]) {
    const decoded = decodeContentDispositionValue(extendedMatch[1]);
    if (decoded) {
      return decoded;
    }
  }

  const plainMatch = contentDisposition.match(
    /filename\s*=\s*("(?:[^"]+)"|[^;]+)/i,
  );
  if (plainMatch?.[1]) {
    const decoded = decodeContentDispositionValue(plainMatch[1]);
    if (decoded) {
      return decoded;
    }
  }

  if (!params.responseUrl) {
    return null;
  }

  try {
    const parsedUrl = new URL(params.responseUrl);
    const segment = parsedUrl.pathname.split('/').filter(Boolean).at(-1) ?? '';
    const decoded = decodeURIComponent(segment);
    return decoded || null;
  } catch {
    return null;
  }
}

export function buildAnkerGamesDownloadSaveTarget(params: {
  fallbackBaseName: string;
  fileName: string | null | undefined;
  stagePath: string;
}): { fileName: string; savePath: string } {
  const fileName = sanitizeAnkerGamesDownloadFileName(
    params.fileName,
    params.fallbackBaseName,
  );
  return {
    fileName,
    savePath: join(params.stagePath, fileName),
  };
}

export function configureAnkerGamesDownloadSession(
  session: { setDownloadPath: (path: string) => void },
  stagePath: string,
): void {
  session.setDownloadPath(stagePath);
}

export function isAnkerGamesAbortLikeError(params: {
  error?: unknown;
  errorCode?: number | null;
  errorDescription?: string | null;
}): boolean {
  const message = [
    errorMessageFromUnknown(params.error),
    params.errorDescription ?? '',
  ]
    .join(' ')
    .toLowerCase();
  return (
    params.errorCode === -3 ||
    message.includes('err_aborted') ||
    message.includes('aborted without reason') ||
    message.includes('signal is aborted without reason') ||
    message.includes('the request was aborted') ||
    message.includes('net::err_aborted') ||
    /\babort(?:ed|ing)?\b/.test(message)
  );
}

export function isAnkerGamesInterceptLikeError(params: {
  error?: unknown;
  errorCode?: number | null;
  errorDescription?: string | null;
}): boolean {
  const message = [
    errorMessageFromUnknown(params.error),
    params.errorDescription ?? '',
  ]
    .join(' ')
    .toLowerCase();
  return (
    message.includes('err_blocked_by_client') ||
    message.includes('blocked_by_client') ||
    message.includes('blocked by client')
  );
}

export function shouldIgnoreAnkerGamesNavigationAbort(params: {
  downloadRequested: boolean;
  error?: unknown;
  errorCode?: number | null;
  errorDescription?: string | null;
  interceptedCandidateUrl?: string | null;
  validatedUrl?: string | null;
}): boolean {
  if (
    !isAnkerGamesAbortLikeError(params) &&
    !isAnkerGamesInterceptLikeError(params)
  ) {
    return false;
  }

  if (params.downloadRequested) {
    return true;
  }

  const candidate =
    params.interceptedCandidateUrl?.trim() ||
    params.validatedUrl?.trim() ||
    null;
  return Boolean(
    candidate &&
      (isAnkerGamesDirectDownloadUrl(candidate) ||
        isAnkerGamesProxyDownloadUrl(candidate)),
  );
}
