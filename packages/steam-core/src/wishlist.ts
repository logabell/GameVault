import type {
  SteamWishlistMetadata,
  SteamWishlistSyncItem,
} from '@gamevault/shared-types';

const STEAM_WISHLIST_API_URL =
  'https://api.steampowered.com/IWishlistService/GetWishlist/v1/';
const STORE_BROWSE_ITEMS_URL =
  'https://api.steampowered.com/IStoreBrowseService/GetItems/v1/';
const STEAM_ASSET_CDN_BASE =
  'https://shared.akamai.steamstatic.com/store_item_assets/';

type StoreItemAssets = {
  asset_url_format?: unknown;
  header?: unknown;
  hero_capsule?: unknown;
  library_capsule?: unknown;
  library_capsule_2x?: unknown;
  library_hero?: unknown;
  library_hero_2x?: unknown;
  main_capsule?: unknown;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function numberOrNull(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string' || !value.trim()) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function unixTimestampToIso(value: unknown): string | null {
  const timestamp = numberOrNull(value);
  if (!timestamp || timestamp <= 0) return null;
  return new Date(timestamp * 1000).toISOString();
}

function buildStoreAssetUrl(assets: StoreItemAssets): string | null {
  const format = stringOrNull(assets.asset_url_format);
  const filename =
    stringOrNull(assets.library_hero_2x) ??
    stringOrNull(assets.library_hero) ??
    stringOrNull(assets.hero_capsule) ??
    stringOrNull(assets.main_capsule) ??
    stringOrNull(assets.header) ??
    stringOrNull(assets.library_capsule_2x) ??
    stringOrNull(assets.library_capsule);
  if (!format || !filename || !format.includes('${FILENAME}')) {
    return null;
  }

  const assetPath = format.replace('${FILENAME}', filename);
  return assetPath.startsWith('http')
    ? assetPath
    : `${STEAM_ASSET_CDN_BASE}${assetPath.replace(/^\/+/, '')}`;
}

function buildGetItemsUrl(appIds: number[]): URL {
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
        include_basic_info: true,
        include_release: true,
        include_reviews: true,
      },
      ids: appIds.map((appid) => ({ appid })),
    }),
  );
  return url;
}

function appIdFromRecord(record: Record<string, unknown>): number | null {
  return numberOrNull(record.appid) ?? numberOrNull(record.id);
}

export function buildSteamStoreAppUrl(appId: number): string {
  return `https://store.steampowered.com/app/${encodeURIComponent(String(appId))}/`;
}

export function buildSteamWishlistProfileUrl(steamId: string): string {
  return `https://store.steampowered.com/wishlist/profiles/${encodeURIComponent(steamId)}/`;
}

export async function fetchSteamWishlistApiItems(
  steamId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<SteamWishlistSyncItem[]> {
  const url = new URL(STEAM_WISHLIST_API_URL);
  url.searchParams.set('steamid', steamId);

  const response = await fetchImpl(url, {
    headers: {
      Accept: 'application/json',
      'User-Agent': 'GameVault/0.1 (+https://example.invalid/gamevault)',
    },
  });
  if (!response.ok) {
    throw new Error(`Steam wishlist lookup failed with ${response.status}`);
  }

  const payload = asRecord(await response.json());
  const responsePayload = asRecord(payload?.response);
  const items = Array.isArray(responsePayload?.items)
    ? responsePayload.items
    : [];

  return items.flatMap((item) => {
    const record = asRecord(item);
    const appId = record ? appIdFromRecord(record) : null;
    if (!appId) return [];
    return [
      {
        appId,
        dateAdded: unixTimestampToIso(record?.date_added),
        priority: numberOrNull(record?.priority),
      },
    ];
  });
}

export async function fetchSteamWishlistMetadata(
  appIds: number[],
  fetchImpl: typeof fetch = fetch,
): Promise<SteamWishlistMetadata[]> {
  const uniqueAppIds = [...new Set(appIds.filter((appId) => appId > 0))];
  if (uniqueAppIds.length === 0) return [];

  const metadata: SteamWishlistMetadata[] = [];
  const chunkSize = 50;
  for (let index = 0; index < uniqueAppIds.length; index += chunkSize) {
    const chunk = uniqueAppIds.slice(index, index + chunkSize);
    const response = await fetchImpl(buildGetItemsUrl(chunk), {
      headers: {
        Accept: 'application/json',
        'User-Agent': 'GameVault/0.1 (+https://example.invalid/gamevault)',
      },
    });
    if (!response.ok) {
      continue;
    }

    const payload = asRecord(await response.json());
    const responsePayload = asRecord(payload?.response);
    const storeItems = Array.isArray(responsePayload?.store_items)
      ? responsePayload.store_items
      : [];
    for (const item of storeItems) {
      const record = asRecord(item);
      if (!record) continue;
      const appId = appIdFromRecord(record);
      const title = stringOrNull(record.name);
      if (!appId || !title) continue;

      const assets = asRecord(record.assets);
      const release = asRecord(record.release);
      const reviews = asRecord(record.reviews);
      const reviewSummary =
        asRecord(reviews?.summary_filtered) ??
        asRecord(reviews?.summary_language_specific);
      const purchaseOption = asRecord(record.best_purchase_option);

      metadata.push({
        appId,
        coverUrl: assets ? buildStoreAssetUrl(assets) : null,
        priceLabel: stringOrNull(purchaseOption?.formatted_final_price),
        releaseDate: unixTimestampToIso(release?.steam_release_date),
        reviewSummary: stringOrNull(reviewSummary?.review_score_label),
        storeUrl: buildSteamStoreAppUrl(appId),
        title,
      });
    }
  }

  return metadata;
}
