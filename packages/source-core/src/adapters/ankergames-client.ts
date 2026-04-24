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
const ANKERGAMES_PROXY_MAX_DEPTH = 4;

export interface AnkerGamesDownloadCandidates {
  directUrls: string[];
  proxyUrls: string[];
}

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

function getVersionStatusString(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value);
  }

  return getString(value);
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
  const version = getVersionStatusString(versionData?.current_version);
  const buildId = getVersionStatusString(versionData?.current_build);
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
      /^\/d\/.+/i.test(parsedUrl.pathname)
    );
  } catch {
    return false;
  }
}

export function isAnkerGamesProxyDownloadUrl(url: string): boolean {
  try {
    const parsedUrl = new URL(trimUrlCandidate(url));
    const hostname = parsedUrl.hostname.toLowerCase();
    return (
      /^https?:$/.test(parsedUrl.protocol) &&
      (hostname === 'dlproxy.uk' || hostname.endsWith('.dlproxy.uk')) &&
      /^\/download(?:\/|$)/i.test(parsedUrl.pathname)
    );
  } catch {
    return false;
  }
}

export function extractAnkerGamesDownloadCandidates(
  html: string,
): AnkerGamesDownloadCandidates {
  const directUrls = new Set<string>();
  const proxyUrls = new Set<string>();

  for (const text of textVariants(html)) {
    const candidates = [
      ...text.matchAll(RAW_URL_RE),
      ...text.matchAll(ENCODED_URL_RE),
    ].map((match) => match[0]);

    for (const candidate of candidates) {
      const decodedCandidate = candidate.includes('%')
        ? (safeDecodeURIComponent(candidate) ?? candidate)
        : candidate;
      const url = trimUrlCandidate(decodedCandidate);
      if (isAnkerGamesDirectDownloadUrl(url)) {
        directUrls.add(url);
      } else if (isAnkerGamesProxyDownloadUrl(url)) {
        proxyUrls.add(url);
      }
    }
  }

  return {
    directUrls: Array.from(directUrls),
    proxyUrls: Array.from(proxyUrls),
  };
}

export function extractAnkerGamesDirectDownloadUrl(
  html: string,
): string | null {
  return extractAnkerGamesDownloadCandidates(html).directUrls[0] ?? null;
}

interface ResolveAnkerGamesDownloadContext {
  fetch: SourceFetch;
  renderSignedDownloadPage?: AnkerGamesSignedDownloadPageRenderer;
  sourceUrl: string;
  stableDownloadUrl: string;
}

function firstAnkerGamesLaunchUrl(
  candidates: AnkerGamesDownloadCandidates,
): string | null {
  return candidates.proxyUrls[0] ?? candidates.directUrls[0] ?? null;
}

async function requestAnkerGamesSignedPageUrl(
  params: ResolveAnkerGamesDownloadContext,
): Promise<string> {
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
    throw new Error('AnkerGames download response did not include a download URL.');
  }

  const normalizedSignedPageUrl = normalizeAbsoluteUrl(
    signedPageUrl,
    params.sourceUrl,
  );
  if (!normalizedSignedPageUrl) {
    throw new Error('AnkerGames download response included an invalid URL.');
  }

  return normalizedSignedPageUrl;
}

async function fetchAnkerGamesSignedPageCandidates(params: {
  context: ResolveAnkerGamesDownloadContext;
  signedPageUrl: string;
}): Promise<AnkerGamesDownloadCandidates> {
  const signedPageResponse = await params.context.fetch(params.signedPageUrl, {
    credentials: 'include',
    headers: {
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    },
    referrer: params.context.sourceUrl,
  });
  if (!signedPageResponse.ok) {
    throw new Error(
      `AnkerGames signed download page failed with ${signedPageResponse.status}.`,
    );
  }

  return extractAnkerGamesDownloadCandidates(await signedPageResponse.text());
}

function buildAnkerGamesCandidateSummary(params: {
  directUrls?: string[];
  proxyUrls?: string[];
  signedPageUrl?: string | null;
  stableDownloadUrl: string;
}): string {
  const hosts = new Set<string>();
  for (const candidate of [
    ...(params.directUrls ?? []),
    ...(params.proxyUrls ?? []),
  ]) {
    try {
      hosts.add(new URL(candidate).hostname.toLowerCase());
    } catch {
      continue;
    }
  }

  return [
    `stable=${params.stableDownloadUrl}`,
    `signed=${params.signedPageUrl ?? 'none'}`,
    `hosts=${hosts.size > 0 ? Array.from(hosts).join(',') : 'none'}`,
    `dlproxySeen=${(params.proxyUrls?.length ?? 0) > 0 ? 'yes' : 'no'}`,
  ].join('; ');
}

async function resolveRenderedAnkerGamesDownloadUrl(params: {
  context: ResolveAnkerGamesDownloadContext;
  referrerUrl: string;
  signedPageUrl: string | null;
  useStableDownloadUrl: boolean;
  visitedProxyUrls: Set<string>;
  proxyDepth: number;
}): Promise<string> {
  if (!params.context.renderSignedDownloadPage) {
    throw new Error(
      'AnkerGames signed page did not include a direct DataNodes download URL.',
    );
  }

  const renderedUrl = await params.context.renderSignedDownloadPage({
    signedPageUrl: params.signedPageUrl,
    sourceUrl: params.context.sourceUrl,
    stableDownloadUrl: params.useStableDownloadUrl
      ? params.context.stableDownloadUrl
      : null,
  });
  if (!renderedUrl) {
    throw new Error(
      `AnkerGames render fallback did not return a DataNodes download URL. ${buildAnkerGamesCandidateSummary(
        {
          signedPageUrl: params.signedPageUrl,
          stableDownloadUrl: params.context.stableDownloadUrl,
        },
      )}`,
    );
  }

  const normalizedRenderedUrl =
    normalizeAbsoluteUrl(renderedUrl, params.referrerUrl) ??
    trimUrlCandidate(renderedUrl);
  if (isAnkerGamesDirectDownloadUrl(normalizedRenderedUrl)) {
    return trimUrlCandidate(normalizedRenderedUrl);
  }
  if (isAnkerGamesProxyDownloadUrl(normalizedRenderedUrl)) {
    return resolveAnkerGamesProxyDownloadUrl({
      context: params.context,
      proxyDepth: params.proxyDepth,
      proxyUrl: normalizedRenderedUrl,
      referrerUrl: params.referrerUrl,
      visitedProxyUrls: params.visitedProxyUrls,
    });
  }

  throw new Error(
    `AnkerGames render fallback did not return a DataNodes download URL. ${buildAnkerGamesCandidateSummary(
      {
        directUrls: [normalizedRenderedUrl],
        signedPageUrl: params.signedPageUrl,
        stableDownloadUrl: params.context.stableDownloadUrl,
      },
    )}`,
  );
}

async function resolveAnkerGamesProxyDownloadUrl(params: {
  context: ResolveAnkerGamesDownloadContext;
  proxyDepth: number;
  proxyUrl: string;
  referrerUrl: string;
  visitedProxyUrls: Set<string>;
}): Promise<string> {
  const normalizedProxyUrl =
    normalizeAbsoluteUrl(params.proxyUrl, params.referrerUrl) ??
    trimUrlCandidate(params.proxyUrl);
  if (!isAnkerGamesProxyDownloadUrl(normalizedProxyUrl)) {
    throw new Error(
      `AnkerGames proxy resolver received a non-proxy URL. ${buildAnkerGamesCandidateSummary(
        {
          directUrls: [normalizedProxyUrl],
          stableDownloadUrl: params.context.stableDownloadUrl,
        },
      )}`,
    );
  }
  if (params.visitedProxyUrls.has(normalizedProxyUrl)) {
    throw new Error(
      `AnkerGames proxy resolver looped before reaching DataNodes. ${buildAnkerGamesCandidateSummary(
        {
          proxyUrls: Array.from(params.visitedProxyUrls),
          stableDownloadUrl: params.context.stableDownloadUrl,
        },
      )}`,
    );
  }
  if (params.proxyDepth >= ANKERGAMES_PROXY_MAX_DEPTH) {
    throw new Error(
      `AnkerGames proxy resolver exceeded ${ANKERGAMES_PROXY_MAX_DEPTH} hops before reaching DataNodes. ${buildAnkerGamesCandidateSummary(
        {
          proxyUrls: Array.from(params.visitedProxyUrls),
          stableDownloadUrl: params.context.stableDownloadUrl,
        },
      )}`,
    );
  }

  params.visitedProxyUrls.add(normalizedProxyUrl);
  let fetchedCandidates: AnkerGamesDownloadCandidates = {
    directUrls: [],
    proxyUrls: [normalizedProxyUrl],
  };

  try {
    const proxyResponse = await params.context.fetch(normalizedProxyUrl, {
      credentials: 'include',
      headers: {
        Accept:
          'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
      referrer: params.referrerUrl,
    });
    const responseUrl = proxyResponse.url
      ? trimUrlCandidate(proxyResponse.url)
      : null;
    if (responseUrl && isAnkerGamesDirectDownloadUrl(responseUrl)) {
      return responseUrl;
    }
    if (
      responseUrl &&
      responseUrl !== normalizedProxyUrl &&
      isAnkerGamesProxyDownloadUrl(responseUrl)
    ) {
      return resolveAnkerGamesProxyDownloadUrl({
        context: params.context,
        proxyDepth: params.proxyDepth + 1,
        proxyUrl: responseUrl,
        referrerUrl: normalizedProxyUrl,
        visitedProxyUrls: params.visitedProxyUrls,
      });
    }

    const locationUrl = proxyResponse.headers.get('location');
    if (locationUrl) {
      const normalizedLocationUrl =
        normalizeAbsoluteUrl(locationUrl, normalizedProxyUrl) ??
        trimUrlCandidate(locationUrl);
      if (isAnkerGamesDirectDownloadUrl(normalizedLocationUrl)) {
        return normalizedLocationUrl;
      }
      if (isAnkerGamesProxyDownloadUrl(normalizedLocationUrl)) {
        return resolveAnkerGamesProxyDownloadUrl({
          context: params.context,
          proxyDepth: params.proxyDepth + 1,
          proxyUrl: normalizedLocationUrl,
          referrerUrl: normalizedProxyUrl,
          visitedProxyUrls: params.visitedProxyUrls,
        });
      }
    }

    if (!proxyResponse.ok) {
      throw new Error(
        `AnkerGames proxy download page failed with ${proxyResponse.status}.`,
      );
    }

    fetchedCandidates = extractAnkerGamesDownloadCandidates(
      await proxyResponse.text(),
    );
    const directUrl = fetchedCandidates.directUrls[0] ?? null;
    if (directUrl) {
      return directUrl;
    }
    for (const proxyUrl of fetchedCandidates.proxyUrls) {
      if (proxyUrl !== normalizedProxyUrl) {
        return resolveAnkerGamesProxyDownloadUrl({
          context: params.context,
          proxyDepth: params.proxyDepth + 1,
          proxyUrl,
          referrerUrl: normalizedProxyUrl,
          visitedProxyUrls: params.visitedProxyUrls,
        });
      }
    }
  } catch {
    throw new Error(
      `AnkerGames proxy download page did not resolve to a direct DataNodes download URL. ${buildAnkerGamesCandidateSummary(
        {
          proxyUrls: Array.from(params.visitedProxyUrls),
          signedPageUrl: normalizedProxyUrl,
          stableDownloadUrl: params.context.stableDownloadUrl,
        },
      )}`,
    );
  }

  throw new Error(
    `AnkerGames proxy download page did not resolve to a direct DataNodes download URL. ${buildAnkerGamesCandidateSummary(
      {
        directUrls: fetchedCandidates.directUrls,
        proxyUrls: Array.from(
          new Set([
            normalizedProxyUrl,
            ...fetchedCandidates.proxyUrls,
            ...params.visitedProxyUrls,
          ]),
        ),
        signedPageUrl: normalizedProxyUrl,
        stableDownloadUrl: params.context.stableDownloadUrl,
      },
    )}`,
  );
}

export async function resolveAnkerGamesDownloadUrl(
  params: ResolveAnkerGamesDownloadContext,
): Promise<string> {
  const renderDirectUrl = async (
    signedPageUrl: string | null,
    visitedProxyUrls = new Set<string>(),
  ): Promise<string> =>
    resolveRenderedAnkerGamesDownloadUrl({
      context: params,
      proxyDepth: 0,
      referrerUrl: signedPageUrl ?? params.sourceUrl,
      signedPageUrl,
      useStableDownloadUrl: true,
      visitedProxyUrls,
    });

  const resolveProxyUrl = async (
    proxyUrl: string,
    referrerUrl: string,
    visitedProxyUrls = new Set<string>(),
  ): Promise<string> =>
    resolveAnkerGamesProxyDownloadUrl({
      context: params,
      proxyDepth: 0,
      proxyUrl,
      referrerUrl,
      visitedProxyUrls,
    });

  const resolveCandidates = async (
    candidates: AnkerGamesDownloadCandidates,
    referrerUrl: string,
  ): Promise<string | null> => {
    const directUrl = candidates.directUrls[0] ?? null;
    if (directUrl) {
      return directUrl;
    }
    const proxyUrl = candidates.proxyUrls[0] ?? null;
    if (proxyUrl) {
      return resolveProxyUrl(proxyUrl, referrerUrl);
    }
    return null;
  };

  if (isAnkerGamesDirectDownloadUrl(params.stableDownloadUrl)) {
    return trimUrlCandidate(params.stableDownloadUrl);
  }

  if (!isAnkerGamesGeneratedDownloadUrl(params.stableDownloadUrl)) {
    throw new Error(
      `AnkerGames download must start from a generated endpoint or direct DataNodes URL. ${buildAnkerGamesCandidateSummary(
        {
          stableDownloadUrl: params.stableDownloadUrl,
        },
      )}`,
    );
  }

  let normalizedSignedPageUrl: string | null = null;

  try {
    normalizedSignedPageUrl = await requestAnkerGamesSignedPageUrl(params);
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
    const candidates = await fetchAnkerGamesSignedPageCandidates({
      context: params,
      signedPageUrl: normalizedSignedPageUrl,
    });
    const resolvedCandidate = await resolveCandidates(
      candidates,
      normalizedSignedPageUrl,
    );
    if (resolvedCandidate) {
      return resolvedCandidate;
    }
    if (!params.renderSignedDownloadPage) {
      throw new Error(
        `AnkerGames signed page did not include a direct DataNodes download URL. ${buildAnkerGamesCandidateSummary(
          {
            directUrls: candidates.directUrls,
            proxyUrls: candidates.proxyUrls,
            signedPageUrl: normalizedSignedPageUrl,
            stableDownloadUrl: params.stableDownloadUrl,
          },
        )}`,
      );
    }
  } catch (error) {
    if (!params.renderSignedDownloadPage) {
      throw error;
    }
  }

  return renderDirectUrl(normalizedSignedPageUrl);
}

export async function resolveAnkerGamesBrowserDownloadUrl(
  params: ResolveAnkerGamesDownloadContext,
): Promise<string> {
  const stableDownloadUrl = trimUrlCandidate(params.stableDownloadUrl);
  if (isAnkerGamesProxyDownloadUrl(stableDownloadUrl)) {
    return stableDownloadUrl;
  }
  if (isAnkerGamesDirectDownloadUrl(stableDownloadUrl)) {
    return stableDownloadUrl;
  }
  if (!isAnkerGamesGeneratedDownloadUrl(stableDownloadUrl)) {
    throw new Error(
      `AnkerGames curl download must start from a generated endpoint, proxy URL, or direct DataNodes URL. ${buildAnkerGamesCandidateSummary(
        {
          stableDownloadUrl,
        },
      )}`,
    );
  }

  const signedPageUrl = await requestAnkerGamesSignedPageUrl({
    ...params,
    stableDownloadUrl,
  });
  if (
    isAnkerGamesProxyDownloadUrl(signedPageUrl) ||
    isAnkerGamesDirectDownloadUrl(signedPageUrl)
  ) {
    return signedPageUrl;
  }

  try {
    const candidates = await fetchAnkerGamesSignedPageCandidates({
      context: params,
      signedPageUrl,
    });
    const launchUrl = firstAnkerGamesLaunchUrl(candidates);
    if (launchUrl) {
      return launchUrl;
    }
    throw new Error(
      `AnkerGames signed page did not include a curl-ready dlproxy or DataNodes URL. ${buildAnkerGamesCandidateSummary(
        {
          directUrls: candidates.directUrls,
          proxyUrls: candidates.proxyUrls,
          signedPageUrl,
          stableDownloadUrl,
        },
      )}`,
    );
  } catch (error) {
    throw error instanceof Error
      ? error
      : new Error('AnkerGames signed page did not include a curl-ready URL.');
  }
}
