import type { SteamPatchCandidate } from '@vaulttrack/shared-types';

import { getSteamPatchKey } from './patch-matching.js';

function normalizePatchLink(link: string | null | undefined): string | null {
  const trimmed = link?.trim();
  if (!trimmed) return null;

  try {
    const parsedUrl = new URL(trimmed);
    parsedUrl.hash = '';
    parsedUrl.search = '';
    return parsedUrl.toString().replace(/\/$/, '');
  } catch {
    return trimmed.replace(/[?#].*$/, '').replace(/\/$/, '');
  }
}

export function getSteamPatchMergeKey(patch: SteamPatchCandidate): string {
  if (patch.selectionSource !== 'manual' && patch.buildId) {
    return `build:${patch.buildId}`;
  }

  const normalizedLink = normalizePatchLink(patch.link);
  if (patch.selectionSource !== 'manual' && normalizedLink) {
    return `link:${normalizedLink}`;
  }

  return `patch:${getSteamPatchKey(patch)}`;
}

function shouldReplaceSteamPatch(
  existing: SteamPatchCandidate,
  incoming: SteamPatchCandidate,
): boolean {
  const existingSource = existing.selectionSource ?? 'rss';
  const incomingSource = incoming.selectionSource ?? 'rss';

  if (existingSource !== 'rss' && incomingSource === 'rss') {
    return true;
  }

  if (existingSource === 'rss' && incomingSource !== 'rss') {
    return false;
  }

  return true;
}

export function mergeSteamPatchLists(
  current: SteamPatchCandidate[],
  next: SteamPatchCandidate[],
): SteamPatchCandidate[] {
  const byKey = new Map<string, SteamPatchCandidate>();

  for (const patch of [...current, ...next]) {
    const key = getSteamPatchMergeKey(patch);
    const existing = byKey.get(key);
    if (!existing || shouldReplaceSteamPatch(existing, patch)) {
      byKey.set(key, patch);
    }
  }

  return Array.from(byKey.values());
}
