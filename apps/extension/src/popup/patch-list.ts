import {
  mergePatchHistory,
  type SteamPatchCandidate,
} from '@gamevault/shared-types';

export function mergeSteamPatchLists(
  current: SteamPatchCandidate[],
  next: SteamPatchCandidate[],
): SteamPatchCandidate[] {
  return mergePatchHistory([...current, ...next]);
}
