import {
  compactSteamPatchHistory,
  type SteamPatchCandidate,
} from '@gamevault/shared-types';

export function mergeSteamPatchLists(
  current: SteamPatchCandidate[],
  next: SteamPatchCandidate[],
): SteamPatchCandidate[] {
  return compactSteamPatchHistory([...current, ...next]);
}
