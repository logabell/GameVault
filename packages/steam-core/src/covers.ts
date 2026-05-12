const STORE_BROWSE_ITEMS_URL =
  'https://api.steampowered.com/IStoreBrowseService/GetItems/v1/';
const STEAM_ASSET_CDN_BASE =
  'https://shared.akamai.steamstatic.com/store_item_assets/';
const LEGACY_STEAM_CDN_BASE = 'https://cdn.cloudflare.steamstatic.com';
const MIN_LEGACY_COVER_BYTES = 10000;

interface StoreItemAssets {
  asset_url_format?: unknown;
  header?: unknown;
  hero_capsule?: unknown;
  library_capsule?: unknown;
  library_capsule_2x?: unknown;
  library_hero?: unknown;
  library_hero_2x?: unknown;
  main_capsule?: unknown;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function buildGetItemsUrl(appId: number): URL {
  const url = new URL(STORE_BROWSE_ITEMS_URL);
  url.searchParams.set(
    'input_json',
    JSON.stringify({
      context: {
        country_code: 'US',
        language: 'english',
      },
      data_request: {
        include_assets: true,
      },
      ids: [
        {
          appid: appId,
        },
      ],
    }),
  );
  return url;
}

function buildStoreAssetUrl(
  assets: StoreItemAssets,
  filenames: Array<string | null>,
): string | null {
  const format = stringOrNull(assets.asset_url_format);
  const filename = filenames.find((entry) => entry);
  if (!format || !filename || !format.includes('${FILENAME}')) {
    return null;
  }

  const assetPath = format.replace('${FILENAME}', filename);
  return assetPath.startsWith('http')
    ? assetPath
    : `${STEAM_ASSET_CDN_BASE}${assetPath.replace(/^\/+/, '')}`;
}

function buildStoreLandscapeAssetUrl(assets: StoreItemAssets): string | null {
  return buildStoreAssetUrl(assets, [
    stringOrNull(assets.library_hero_2x),
    stringOrNull(assets.library_hero),
    stringOrNull(assets.hero_capsule),
    stringOrNull(assets.main_capsule),
    stringOrNull(assets.header),
    stringOrNull(assets.library_capsule_2x),
    stringOrNull(assets.library_capsule),
  ]);
}

function buildStorePortraitAssetUrl(assets: StoreItemAssets): string | null {
  return buildStoreAssetUrl(assets, [
    stringOrNull(assets.library_capsule_2x),
    stringOrNull(assets.library_capsule),
  ]);
}

async function resolveCoverFromStoreBrowse(
  appId: number,
  fetchImpl: typeof fetch,
): Promise<string | null> {
  const response = await fetchImpl(buildGetItemsUrl(appId), {
    headers: {
      'User-Agent': 'GameVault/0.1 (+https://example.invalid/gamevault)',
    },
  });
  if (!response.ok) {
    return null;
  }

  const payload = asRecord(await response.json());
  const responsePayload = asRecord(payload?.response);
  const storeItems = Array.isArray(responsePayload?.store_items)
    ? responsePayload.store_items
    : [];
  const item = asRecord(storeItems[0]);
  const assets = asRecord(item?.assets);
  return assets ? buildStoreLandscapeAssetUrl(assets) : null;
}

async function resolvePortraitFromStoreBrowse(
  appId: number,
  fetchImpl: typeof fetch,
): Promise<string | null> {
  const response = await fetchImpl(buildGetItemsUrl(appId), {
    headers: {
      'User-Agent': 'GameVault/0.1 (+https://example.invalid/gamevault)',
    },
  });
  if (!response.ok) {
    return null;
  }

  const payload = asRecord(await response.json());
  const responsePayload = asRecord(payload?.response);
  const storeItems = Array.isArray(responsePayload?.store_items)
    ? responsePayload.store_items
    : [];
  const item = asRecord(storeItems[0]);
  const assets = asRecord(item?.assets);
  return assets ? buildStorePortraitAssetUrl(assets) : null;
}

async function legacyCoverLooksUsable(
  url: string,
  fetchImpl: typeof fetch,
): Promise<boolean> {
  const response = await fetchImpl(url, { method: 'HEAD' });
  if (!response.ok) {
    return false;
  }

  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.toLowerCase().startsWith('image/')) {
    return false;
  }

  const contentLength = Number(response.headers.get('content-length') ?? 0);
  if (Number.isFinite(contentLength) && contentLength > 0) {
    return contentLength >= MIN_LEGACY_COVER_BYTES;
  }

  const imageResponse = await fetchImpl(url);
  if (!imageResponse.ok) {
    return false;
  }

  const imageType = imageResponse.headers.get('content-type') ?? '';
  if (!imageType.toLowerCase().startsWith('image/')) {
    return false;
  }

  return (
    (await imageResponse.arrayBuffer()).byteLength >= MIN_LEGACY_COVER_BYTES
  );
}

async function resolveLegacyCoverUrl(
  appId: number,
  fetchImpl: typeof fetch,
): Promise<string | null> {
  const candidates = [
    `${LEGACY_STEAM_CDN_BASE}/steam/apps/${appId}/library_hero_2x.jpg`,
    `${LEGACY_STEAM_CDN_BASE}/steam/apps/${appId}/library_hero.jpg`,
    `${LEGACY_STEAM_CDN_BASE}/steam/apps/${appId}/hero_capsule.jpg`,
    `${LEGACY_STEAM_CDN_BASE}/steam/apps/${appId}/capsule_616x353.jpg`,
    `${LEGACY_STEAM_CDN_BASE}/steam/apps/${appId}/header.jpg`,
    `${LEGACY_STEAM_CDN_BASE}/steam/apps/${appId}/library_600x900_2x.jpg`,
    `${LEGACY_STEAM_CDN_BASE}/steam/apps/${appId}/library_600x900.jpg`,
  ];

  for (const candidate of candidates) {
    try {
      if (await legacyCoverLooksUsable(candidate, fetchImpl)) {
        return candidate;
      }
    } catch {
      // Try the next candidate.
    }
  }

  return null;
}

async function resolveLegacyPortraitCoverUrl(
  appId: number,
  fetchImpl: typeof fetch,
): Promise<string | null> {
  const candidates = [
    `${LEGACY_STEAM_CDN_BASE}/steam/apps/${appId}/library_600x900_2x.jpg`,
    `${LEGACY_STEAM_CDN_BASE}/steam/apps/${appId}/library_600x900.jpg`,
  ];

  for (const candidate of candidates) {
    try {
      if (await legacyCoverLooksUsable(candidate, fetchImpl)) {
        return candidate;
      }
    } catch {
      // Try the next candidate.
    }
  }

  return null;
}

export function buildSteamLibraryPortraitCoverUrl(
  appId: number | null | undefined,
): string | null {
  if (!Number.isInteger(appId) || !appId || appId <= 0) {
    return null;
  }

  return `${LEGACY_STEAM_CDN_BASE}/steam/apps/${appId}/library_600x900.jpg`;
}

export async function resolveSteamLibraryCoverUrl(
  appId: number,
  fetchImpl: typeof fetch = fetch,
): Promise<string | null> {
  if (!Number.isInteger(appId) || appId <= 0) {
    return null;
  }

  try {
    const storeBrowseCover = await resolveCoverFromStoreBrowse(appId, fetchImpl);
    if (storeBrowseCover) {
      return storeBrowseCover;
    }
  } catch {
    // Fall back to legacy CDN paths below.
  }

  return resolveLegacyCoverUrl(appId, fetchImpl);
}

export async function resolveSteamLibraryPortraitCoverUrl(
  appId: number,
  fetchImpl: typeof fetch = fetch,
): Promise<string | null> {
  if (!Number.isInteger(appId) || appId <= 0) {
    return null;
  }

  try {
    const storeBrowseCover = await resolvePortraitFromStoreBrowse(
      appId,
      fetchImpl,
    );
    if (storeBrowseCover) {
      return storeBrowseCover;
    }
  } catch {
    // Fall back to legacy CDN paths below.
  }

  return resolveLegacyPortraitCoverUrl(appId, fetchImpl);
}

export function isSteamLibraryCoverUrl(url: string | null | undefined): boolean {
  if (!url) {
    return false;
  }

  try {
    const parsed = new URL(url);
    return (
      /(^|\.)steamstatic\.com$/i.test(parsed.hostname) &&
      /\/(?:library_hero(?:_2x)?|hero_capsule|capsule_616x353|header)\.jpg$/i.test(
        parsed.pathname,
      )
    );
  } catch {
    return false;
  }
}

export function isSteamLandscapeArtworkUrl(
  url: string | null | undefined,
): boolean {
  if (!url) {
    return false;
  }

  try {
    const parsed = new URL(url);
    return (
      /(^|\.)steamstatic\.com$/i.test(parsed.hostname) &&
      /\/(?:library_hero(?:_2x)?|hero_capsule(?:_2x)?|capsule_\d+x\d+(?:_2x)?|header(?:_2x)?|main_capsule(?:_2x)?)\.jpg$/i.test(
        parsed.pathname,
      )
    );
  } catch {
    return false;
  }
}
