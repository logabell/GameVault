import type { ParsedSourcePayload } from '@vaulttrack/shared-types';

import { buildFingerprint } from '../utils.js';

export type SourceFetch = (
  input: string,
  init?: RequestInit,
) => Promise<Response>;

interface AnkerGamesVersionStatus {
  buildId: string;
  version: string;
}

export interface RenderAnkerGamesSignedDownloadPageParams {
  signedPageUrl?: string | null;
  sourceUrl: string;
  stableDownloadUrl?: string | null;
}

export type AnkerGamesSignedDownloadPageRenderer = (
  params: RenderAnkerGamesSignedDownloadPageParams,
) => Promise<string | null>;

const RAW_URL_RE = /https?:\/\/[^\s"'<>`\\)]+/gi;
const ENCODED_URL_RE = /https?%3A%2F%2F[^\s"'<>`\\)]+/gi;

function decodeHtmlAttribute(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#039;|&#x27;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function decodeJsEscapes(value: string): string {
  return value
    .replace(/\\u([0-9a-fA-F]{4})/g, (_match, hex: string) =>
      String.fromCharCode(Number.parseInt(hex, 16)),
    )
    .replace(/\\x([0-9a-fA-F]{2})/g, (_match, hex: string) =>
      String.fromCharCode(Number.parseInt(hex, 16)),
    )
    .replace(/\\\//g, '/')
    .replace(/\\"/g, '"')
    .replace(/\\'/g, "'");
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : null;
}

function unwrapLivewireValue(value: unknown): Record<string, unknown> | null {
  if (Array.isArray(value)) {
    return asRecord(value[0]);
  }

  return asRecord(value);
}

function getString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function safeDecodeURIComponent(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

function trimUrlCandidate(value: string): string {
  return decodeHtmlAttribute(value)
    .trim()
    .replace(/[)"',.;\]}]+$/g, '');
}

function textVariants(value: string): string[] {
  const variants = new Set<string>();
  const add = (candidate: string | null) => {
    if (candidate && candidate.trim()) {
      variants.add(candidate);
    }
  };

  add(value);
  add(decodeHtmlAttribute(value));

  for (const candidate of Array.from(variants)) {
    add(decodeJsEscapes(candidate));
  }

  for (const candidate of Array.from(variants)) {
    if (candidate.includes('%')) {
      add(safeDecodeURIComponent(candidate));
    }
  }

  return Array.from(variants);
}

function normalizeAbsoluteUrl(value: string, baseUrl: string): string | null {
  try {
    return new URL(value, baseUrl).toString();
  } catch {
    return null;
  }
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new Error('AnkerGames returned malformed JSON.');
  }
}

async function fetchAnkerGamesCsrfToken(
  sourceUrl: string,
  fetchFn: SourceFetch,
): Promise<string> {
  const response = await fetchFn(new URL('/csrf-token', sourceUrl).toString(), {
    credentials: 'include',
    headers: {
      Accept: 'application/json',
    },
  });
  if (!response.ok) {
    throw new Error(`AnkerGames CSRF request failed with ${response.status}.`);
  }

  const data = asRecord(await readJson(response));
  const token = getString(data?.token);
  if (!token) {
    throw new Error('AnkerGames CSRF response did not include a token.');
  }

  return token;
}

export function extractAnkerGamesVersionRequest(html: string): {
  lazyToken: string;
  snapshot: string;
} | null {
  const tagMatches = html.matchAll(
    /<div\b(?=[^>]*wire:snapshot=)(?=[^>]*wire:id=)[^>]*>/g,
  );

  for (const match of tagMatches) {
    const tag = match[0];
    const snapshotAttribute = tag.match(/wire:snapshot="([^"]+)"/)?.[1];
    if (!snapshotAttribute) {
      continue;
    }

    const snapshot = decodeHtmlAttribute(snapshotAttribute);
    try {
      const parsedSnapshot = JSON.parse(snapshot) as {
        memo?: { name?: string };
      };
      if (parsedSnapshot.memo?.name !== 'version-status') {
        continue;
      }
    } catch {
      continue;
    }

    const lazyToken = tag.match(
      /__lazyLoad\((?:&#039;|'|&quot;|")([^'"&]+)(?:&#039;|'|&quot;|")\)/,
    )?.[1];
    if (!lazyToken) {
      continue;
    }

    return {
      lazyToken,
      snapshot,
    };
  }

  return null;
}

export async function hydrateAnkerGamesVersionStatus(params: {
  fetch: SourceFetch;
  html: string;
  sourceUrl: string;
}): Promise<AnkerGamesVersionStatus> {
  const request = extractAnkerGamesVersionRequest(params.html);
  if (!request) {
    throw new Error('AnkerGames version status component was not found.');
  }

  const csrfToken = await fetchAnkerGamesCsrfToken(
    params.sourceUrl,
    params.fetch,
  );
  const response = await params.fetch(
    new URL('/livewire/update', params.sourceUrl).toString(),
    {
      body: JSON.stringify({
        _token: csrfToken,
        components: [
          {
            calls: [
              {
                method: '__lazyLoad',
                params: [request.lazyToken],
                path: '',
              },
            ],
            snapshot: request.snapshot,
            updates: {},
          },
        ],
      }),
      credentials: 'include',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'X-CSRF-TOKEN': csrfToken,
        'X-Livewire': 'true',
      },
      method: 'POST',
      referrer: params.sourceUrl,
    },
  );
  if (!response.ok) {
    throw new Error(
      `AnkerGames version request failed with ${response.status}.`,
    );
  }

  const payload = asRecord(await readJson(response));
  const component = Array.isArray(payload?.components)
    ? asRecord(payload.components[0])
    : null;
  const snapshotText = getString(component?.snapshot);
  if (!snapshotText) {
    throw new Error('AnkerGames version response did not include a snapshot.');
  }

  const snapshot = asRecord(JSON.parse(snapshotText));
  const data = asRecord(snapshot?.data);
  const versionData = unwrapLivewireValue(data?.versionData);
  const version = getString(versionData?.current_version);
  const buildId = getString(versionData?.current_build);
  if (!version || !buildId) {
    throw new Error(
      'AnkerGames version response did not include current version and build.',
    );
  }

  return {
    buildId,
    version,
  };
}

export async function enrichAnkerGamesParsedSource(params: {
  fetch: SourceFetch;
  html: string;
  parsedSource: ParsedSourcePayload;
}): Promise<ParsedSourcePayload> {
  if (params.parsedSource.sourceKind !== 'ankergames') {
    return params.parsedSource;
  }

  const versionStatus = await hydrateAnkerGamesVersionStatus({
    fetch: params.fetch,
    html: params.html,
    sourceUrl: params.parsedSource.sourceUrl,
  });
  const latestSourceRelease = {
    ...params.parsedSource.latestSourceRelease,
    buildId: versionStatus.buildId,
    label: `Version ${versionStatus.version}`,
    version: versionStatus.version,
  };

  return {
    ...params.parsedSource,
    fingerprint: buildFingerprint([
      params.parsedSource.sourceUrl,
      params.parsedSource.title,
      versionStatus.version,
      versionStatus.buildId,
      params.parsedSource.fullDownloadUrls.map((entry) => entry.url).join('|'),
    ]),
    fullRelease: latestSourceRelease,
    latestSourceRelease,
  };
}

export function isAnkerGamesGeneratedDownloadUrl(url: string): boolean {
  try {
    const parsedUrl = new URL(url);
    return (
      parsedUrl.hostname.replace(/^www\./i, '').toLowerCase() ===
        'ankergames.net' &&
      /^\/generate-download-url\/\d+\/?$/i.test(parsedUrl.pathname)
    );
  } catch {
    return false;
  }
}

export function isAnkerGamesDirectDownloadUrl(url: string): boolean {
  try {
    const parsedUrl = new URL(trimUrlCandidate(url));
    const hostname = parsedUrl.hostname.toLowerCase();
    return (
      /^https?:$/.test(parsedUrl.protocol) &&
      hostname.endsWith('.datanodes.to') &&
      parsedUrl.pathname.startsWith('/d/')
    );
  } catch {
    return false;
  }
}

export function extractAnkerGamesDirectDownloadUrl(
  html: string,
): string | null {
  for (const text of textVariants(html)) {
    const candidates = [
      ...text.matchAll(RAW_URL_RE),
      ...text.matchAll(ENCODED_URL_RE),
    ].map((match) => match[0]);

    for (const candidate of candidates) {
      const decodedCandidate = candidate.includes('%')
        ? (safeDecodeURIComponent(candidate) ?? candidate)
        : candidate;
      const directUrl = trimUrlCandidate(decodedCandidate);
      if (isAnkerGamesDirectDownloadUrl(directUrl)) {
        return directUrl;
      }
    }
  }

  return null;
}

export async function resolveAnkerGamesDownloadUrl(params: {
  fetch: SourceFetch;
  renderSignedDownloadPage?: AnkerGamesSignedDownloadPageRenderer;
  sourceUrl: string;
  stableDownloadUrl: string;
}): Promise<string> {
  const renderDirectUrl = async (
    signedPageUrl: string | null,
  ): Promise<string> => {
    if (!params.renderSignedDownloadPage) {
      throw new Error(
        'AnkerGames signed page did not include a direct DataNodes download URL.',
      );
    }

    const renderedDirectUrl = await params.renderSignedDownloadPage({
      signedPageUrl,
      sourceUrl: params.sourceUrl,
      stableDownloadUrl: params.stableDownloadUrl,
    });
    if (renderedDirectUrl && isAnkerGamesDirectDownloadUrl(renderedDirectUrl)) {
      return renderedDirectUrl;
    }
    throw new Error(
      'AnkerGames render fallback did not return a DataNodes download URL.',
    );
  };

  let normalizedSignedPageUrl: string | null = null;

  try {
    const csrfToken = await fetchAnkerGamesCsrfToken(
      params.sourceUrl,
      params.fetch,
    );
    const generatedResponse = await params.fetch(params.stableDownloadUrl, {
      body: JSON.stringify({
        'g-recaptcha-response': 'development-mode',
      }),
      credentials: 'include',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'X-CSRF-TOKEN': csrfToken,
      },
      method: 'POST',
      referrer: params.sourceUrl,
    });
    if (!generatedResponse.ok) {
      throw new Error(
        `AnkerGames download URL request failed with ${generatedResponse.status}.`,
      );
    }

    const generatedPayload = asRecord(await readJson(generatedResponse));
    const signedPageUrl = getString(generatedPayload?.download_url);
    if (!signedPageUrl) {
      throw new Error(
        'AnkerGames download response did not include a download URL.',
      );
    }
    normalizedSignedPageUrl = normalizeAbsoluteUrl(
      signedPageUrl,
      params.sourceUrl,
    );
    if (!normalizedSignedPageUrl) {
      throw new Error('AnkerGames download response included an invalid URL.');
    }
  } catch (error) {
    if (params.renderSignedDownloadPage) {
      return renderDirectUrl(null);
    }
    throw error;
  }

  if (isAnkerGamesDirectDownloadUrl(normalizedSignedPageUrl)) {
    return normalizedSignedPageUrl;
  }

  try {
    const signedPageResponse = await params.fetch(normalizedSignedPageUrl, {
      credentials: 'include',
      headers: {
        Accept:
          'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
      referrer: params.sourceUrl,
    });
    if (!signedPageResponse.ok) {
      throw new Error(
        `AnkerGames signed download page failed with ${signedPageResponse.status}.`,
      );
    }

    const signedPageHtml = await signedPageResponse.text();
    const directUrl = extractAnkerGamesDirectDownloadUrl(signedPageHtml);
    if (directUrl) {
      return directUrl;
    }
  } catch (error) {
    if (!params.renderSignedDownloadPage) {
      throw error;
    }
  }

  return renderDirectUrl(normalizedSignedPageUrl);
}
