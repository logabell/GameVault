import { load } from 'cheerio';
import type { SteamCandidate } from '@gamevault/shared-types';

import {
  buildSteamSearchQueries,
  filterRelevantSteamCandidates,
  isLikelyNonBaseSteamTitle,
  rankSteamCandidates,
  shouldAutoSelect,
} from './matching.js';
import { resolveSteamLibraryCoverUrl } from './covers.js';

const STORE_SEARCH_URL = 'https://store.steampowered.com/search/';
const STORE_SEARCH_API_URL = 'https://store.steampowered.com/api/storesearch/';
const STORE_APP_DETAILS_API_URL =
  'https://store.steampowered.com/api/appdetails';
const STEAM_COMMUNITY_APP_SEARCH_URL =
  'https://steamcommunity.com/actions/SearchApps/';
const MAX_CANDIDATES_PER_QUERY = 12;

type SteamCandidateSource =
  | 'steam_community_api'
  | 'steam_store_api'
  | 'steam_store_html';

type RawSteamCandidate = Omit<
  SteamCandidate,
  'normalizedTitle' | 'score' | 'reasons'
> & {
  appType?: string | null;
  matchedQuery: string;
  source: SteamCandidateSource;
};

interface SteamAppDetails {
  releaseDate: string | null;
  type: string | null;
}

export interface SteamSearchResult {
  autoSelected: boolean;
  candidates: SteamCandidate[];
  queryTitle: string;
  searchQueries: string[];
}

export interface SteamSearchOptions {
  queryTitle?: string | null;
}

function buildSearchPlan(
  sourceTitle: string,
  options: SteamSearchOptions = {},
): {
  rankingQuery: string;
  searchQueries: string[];
} {
  const querySeed = options.queryTitle?.trim() || sourceTitle;
  const searchQueries = buildSteamSearchQueries(querySeed);

  return {
    rankingQuery: searchQueries[0] ?? querySeed,
    searchQueries: searchQueries.length > 0 ? searchQueries : [querySeed],
  };
}

function steamHeaders(): HeadersInit {
  return {
    Accept: 'application/json, text/html;q=0.9, */*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 GameVault/0.1',
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

async function searchSteamStoreApi(
  query: string,
  fetchImpl: typeof fetch,
): Promise<RawSteamCandidate[]> {
  const searchUrl = new URL(STORE_SEARCH_API_URL);
  searchUrl.searchParams.set('term', query);
  searchUrl.searchParams.set('category1', '998');
  searchUrl.searchParams.set('cc', 'us');
  searchUrl.searchParams.set('l', 'en');

  const response = await fetchImpl(searchUrl, {
    headers: steamHeaders(),
  });

  if (!response.ok) {
    throw new Error(`Steam store API search failed with ${response.status}`);
  }

  const payload = asRecord(await response.json());
  const items = Array.isArray(payload?.items) ? payload.items : [];

  return items.slice(0, MAX_CANDIDATES_PER_QUERY).flatMap((item) => {
    const record = asRecord(item);
    const appId = numberOrNull(record?.id);
    const title = stringOrNull(record?.name);
    if (!appId || !title) {
      return [];
    }

    return [
      {
        appId,
        coverUrl: stringOrNull(record?.tiny_image),
        matchedQuery: query,
        releaseDate: stringOrNull(record?.released),
        source: 'steam_store_api' as const,
        title,
      },
    ];
  });
}

async function searchSteamStoreHtml(
  query: string,
  fetchImpl: typeof fetch,
): Promise<RawSteamCandidate[]> {
  const searchUrl = new URL(STORE_SEARCH_URL);
  searchUrl.searchParams.set('term', query);
  searchUrl.searchParams.set('category1', '998');
  searchUrl.searchParams.set('ndl', '1');

  const response = await fetchImpl(searchUrl, {
    headers: steamHeaders(),
  });

  if (!response.ok) {
    throw new Error(`Steam search failed with ${response.status}`);
  }

  const html = await response.text();
  const $ = load(html);
  const results: RawSteamCandidate[] = [];

  $('.search_result_row').each((_, element) => {
    const rawAppIdText =
      $(element).attr('data-ds-appid') ??
      $(element)
        .attr('href')
        ?.match(/\/app\/(\d+)/)?.[1];
    const appIdText = rawAppIdText?.split(',')[0]?.trim();
    const title = $(element).find('.title').text().trim();
    if (!appIdText || !title) {
      return;
    }

    results.push({
      appId: Number(appIdText),
      coverUrl: $(element).find('img').attr('src') ?? null,
      matchedQuery: query,
      releaseDate: $(element).find('.search_released').text().trim() || null,
      source: 'steam_store_html',
      title,
    });
  });

  return results.slice(0, MAX_CANDIDATES_PER_QUERY);
}

async function searchSteamCommunityApps(
  query: string,
  fetchImpl: typeof fetch,
): Promise<RawSteamCandidate[]> {
  const response = await fetchImpl(
    `${STEAM_COMMUNITY_APP_SEARCH_URL}${encodeURIComponent(query)}`,
    {
      headers: steamHeaders(),
    },
  );

  if (!response.ok) {
    throw new Error(`Steam Community app search failed with ${response.status}`);
  }

  const payload = await response.json();
  const items = Array.isArray(payload) ? payload : [];
  return items.slice(0, MAX_CANDIDATES_PER_QUERY).flatMap((item) => {
    const record = asRecord(item);
    const appId =
      numberOrNull(record?.appid) ??
      (typeof record?.appid === 'string' ? Number(record.appid) : null);
    const title = stringOrNull(record?.name);
    if (!appId || !title) {
      return [];
    }

    return [
      {
        appId,
        coverUrl: stringOrNull(record?.logo) ?? stringOrNull(record?.icon),
        matchedQuery: query,
        releaseDate: null,
        source: 'steam_community_api' as const,
        title,
      },
    ];
  });
}

async function fetchAppDetails(
  appId: number,
  fetchImpl: typeof fetch,
): Promise<SteamAppDetails> {
  const detailsUrl = new URL(STORE_APP_DETAILS_API_URL);
  detailsUrl.searchParams.set('appids', String(appId));
  detailsUrl.searchParams.set('cc', 'us');
  detailsUrl.searchParams.set('l', 'en');

  const response = await fetchImpl(detailsUrl, {
    headers: steamHeaders(),
  });

  if (!response.ok) {
    return {
      releaseDate: null,
      type: null,
    };
  }

  const payload = asRecord(await response.json());
  const entry = asRecord(payload?.[String(appId)]);
  const data = asRecord(entry?.data);
  const releaseDate = asRecord(data?.release_date);
  return {
    releaseDate: stringOrNull(releaseDate?.date),
    type: stringOrNull(data?.type),
  };
}

async function attachKnownAppDetails(
  candidates: RawSteamCandidate[],
  fetchImpl: typeof fetch,
): Promise<RawSteamCandidate[]> {
  const detailsById = new Map<number, Promise<SteamAppDetails>>();
  await Promise.all(
    candidates.map(async (candidate) => {
      if (candidate.appType) {
        detailsById.set(
          candidate.appId,
          Promise.resolve({
            releaseDate: candidate.releaseDate ?? null,
            type: candidate.appType,
          }),
        );
        return;
      }

      if (detailsById.has(candidate.appId)) {
        return;
      }

      detailsById.set(
        candidate.appId,
        fetchAppDetails(candidate.appId, fetchImpl),
      );
    }),
  );

  return Promise.all(
    candidates.map(async (candidate) => {
      const details = await detailsById.get(candidate.appId);
      return {
        ...candidate,
        appType: details?.type ?? candidate.appType ?? null,
        releaseDate: candidate.releaseDate ?? details?.releaseDate ?? null,
      };
    }),
  );
}

function dedupeCandidates(
  candidates: RawSteamCandidate[],
): RawSteamCandidate[] {
  const byAppId = new Map<number, RawSteamCandidate>();

  for (const candidate of candidates) {
    const existing = byAppId.get(candidate.appId);
    if (!existing) {
      byAppId.set(candidate.appId, candidate);
      continue;
    }

    byAppId.set(candidate.appId, {
      ...existing,
      appType: existing.appType ?? candidate.appType,
      coverUrl: existing.coverUrl ?? candidate.coverUrl,
      releaseDate: existing.releaseDate ?? candidate.releaseDate,
    });
  }

  return [...byAppId.values()];
}

function onlyBaseGames(candidates: RawSteamCandidate[]): RawSteamCandidate[] {
  return candidates.filter((candidate) => {
    if (candidate.appType) {
      return candidate.appType === 'game';
    }

    return !isLikelyNonBaseSteamTitle(candidate.title);
  });
}

async function attachSteamLibraryCovers(
  candidates: SteamCandidate[],
  fetchImpl: typeof fetch,
): Promise<SteamCandidate[]> {
  return Promise.all(
    candidates.map(async (candidate) => ({
      ...candidate,
      coverUrl:
        (await resolveSteamLibraryCoverUrl(
          candidate.appId,
          fetchImpl,
        ).catch(() => null)) ?? null,
    })),
  );
}

async function fetchCandidatesForQuery(
  query: string,
  fetchImpl: typeof fetch,
): Promise<RawSteamCandidate[]> {
  try {
    const apiCandidates = await searchSteamStoreApi(query, fetchImpl);
    if (apiCandidates.length > 0) {
      return apiCandidates;
    }
  } catch {
    // Try the next public Steam search surface.
  }

  try {
    const communityCandidates = await searchSteamCommunityApps(query, fetchImpl);
    if (communityCandidates.length > 0) {
      return communityCandidates;
    }
  } catch {
    // Fall back to scraping the store search page below.
  }

  try {
    return await searchSteamStoreHtml(query, fetchImpl);
  } catch {
    return [];
  }
}

export async function searchSteamStore(
  query: string,
  fetchImpl: typeof fetch = fetch,
  options: SteamSearchOptions = {},
): Promise<SteamCandidate[]> {
  const { rankingQuery, searchQueries } = buildSearchPlan(query, options);
  const rawCandidates: RawSteamCandidate[] = [];

  for (const searchQuery of searchQueries) {
    rawCandidates.push(
      ...(await fetchCandidatesForQuery(searchQuery, fetchImpl)),
    );
  }

  const typedCandidates = await attachKnownAppDetails(
    dedupeCandidates(rawCandidates),
    fetchImpl,
  );
  const baseGameCandidates = onlyBaseGames(typedCandidates);
  const candidates = filterRelevantSteamCandidates(
    rankSteamCandidates(rankingQuery, baseGameCandidates),
  );
  return attachSteamLibraryCovers(candidates, fetchImpl);
}

export async function resolveSteamMatch(
  query: string,
  fetchImpl: typeof fetch = fetch,
  options: SteamSearchOptions = {},
): Promise<SteamSearchResult> {
  const { rankingQuery, searchQueries } = buildSearchPlan(query, options);
  const candidates = await searchSteamStore(query, fetchImpl, options);
  return {
    autoSelected: shouldAutoSelect(candidates),
    candidates,
    queryTitle: rankingQuery,
    searchQueries,
  };
}

export function normalizeSteamSearchQuery(input: string): string {
  return buildSteamSearchQueries(input)[0] ?? input.trim();
}
