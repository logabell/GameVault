import { join } from 'node:path';

function sanitizeAnkerGamesDownloadFileName(
  fileName: string | null | undefined,
  fallbackBaseName: string,
): string {
  const sanitized = (fileName ?? '')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '')
    .trim();
  if (sanitized) {
    return sanitized.toLowerCase().endsWith('.zip')
      ? sanitized
      : `${sanitized}.zip`;
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
