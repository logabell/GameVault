import {
  getPatchHistoryKey,
  mergePatchHistory,
  type SteamPatchCandidate,
} from '@vaulttrack/shared-types';

export function getSteamPatchMergeKey(patch: SteamPatchCandidate): string {
  return getPatchHistoryKey(patch);
}

export function mergeSteamPatchLists(
  current: SteamPatchCandidate[],
  next: SteamPatchCandidate[],
): SteamPatchCandidate[] {
  return mergePatchHistory([...current, ...next]);
}
