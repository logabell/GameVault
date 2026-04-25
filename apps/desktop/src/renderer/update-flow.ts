import type {
  DownloadMirrorRecord,
  MatchedSourceView,
  SelectedDownloads,
  SourceKind,
  SteamPatchCandidate,
  SupportedSourceKind,
} from '@gamevault/shared-types';
import { getPatchHistoryKey } from '@gamevault/shared-types';

export type UpdateMirrorOption = Pick<
  DownloadMirrorRecord,
  'kind' | 'label' | 'manuallyFailedAt' | 'selectedAt' | 'url'
>;

export interface UpdateMirrorSelectionPlan {
  fullRows: UpdateMirrorOption[];
  fullUrl: string | null;
  patchRows: UpdateMirrorOption[];
  patchUrl: string | null;
  requiresFull: boolean;
  requiresPatch: boolean;
  sharedPatchRows: boolean;
  showFullRows: boolean;
  showPatchRows: boolean;
  sourceKind: SupportedSourceKind;
}

export interface SteamPatchSuggestion {
  key: string;
  label: string;
  score: number;
}

export function normalizeComparableUrl(
  value: string | null | undefined,
): string | null {
  if (!value) return null;
  try {
    const parsedUrl = new URL(value);
    parsedUrl.hash = '';
    return parsedUrl.toString().replace(/\/$/, '').toLowerCase();
  } catch {
    return value.trim().replace(/\/$/, '').toLowerCase() || null;
  }
}

export function haveSharedMirrorUrls(
  fullRows: Array<{ url: string }>,
  patchRows: Array<{ url: string }>,
): boolean {
  if (fullRows.length === 0 || patchRows.length === 0) {
    return false;
  }

  const fullUrls = new Set(
    fullRows
      .map((row) => normalizeComparableUrl(row.url))
      .filter((url): url is string => Boolean(url)),
  );
  return patchRows.every((row) => {
    const url = normalizeComparableUrl(row.url);
    return Boolean(url && fullUrls.has(url));
  });
}

export function findSharedPatchMirrorUrl(
  fullUrl: string | null,
  patchRows: Array<{ url: string }>,
): string | null {
  const normalizedFullUrl = normalizeComparableUrl(fullUrl);
  if (!normalizedFullUrl) {
    return null;
  }

  return (
    patchRows.find(
      (row) => normalizeComparableUrl(row.url) === normalizedFullUrl,
    )?.url ?? null
  );
}

function preferredMirrorUrl(rows: UpdateMirrorOption[]): string | null {
  return (
    rows.find((mirror) => mirror.selectedAt && !mirror.manuallyFailedAt)?.url ??
    rows.find((mirror) => !mirror.manuallyFailedAt)?.url ??
    rows.find((mirror) => mirror.selectedAt)?.url ??
    rows[0]?.url ??
    null
  );
}

export function planUpdateMirrorSelection(params: {
  installedSourceKind: SourceKind | null;
  mirrors: UpdateMirrorOption[];
  sourceKind: SupportedSourceKind;
}): UpdateMirrorSelectionPlan {
  const fullRows = params.mirrors.filter((mirror) => mirror.kind === 'full');
  const patchRows = params.mirrors.filter((mirror) => mirror.kind === 'patch');
  const elamigosPatchAvailable =
    params.sourceKind === 'elamigos' && patchRows.length > 0;
  const requiresPatch = elamigosPatchAvailable;
  const requiresFull =
    params.sourceKind !== 'elamigos' ||
    !elamigosPatchAvailable ||
    params.installedSourceKind !== 'elamigos';
  const sharedPatchRows =
    requiresFull && requiresPatch && haveSharedMirrorUrls(fullRows, patchRows);
  const fullUrl = requiresFull ? preferredMirrorUrl(fullRows) : '';
  const patchUrl = requiresPatch
    ? sharedPatchRows
      ? (findSharedPatchMirrorUrl(fullUrl, patchRows) ?? fullUrl)
      : preferredMirrorUrl(patchRows)
    : null;

  return {
    fullRows,
    fullUrl,
    patchRows,
    patchUrl,
    requiresFull,
    requiresPatch,
    sharedPatchRows,
    showFullRows: requiresFull && fullRows.length > 1,
    showPatchRows:
      requiresPatch && !sharedPatchRows && patchRows.length > 1,
    sourceKind: params.sourceKind,
  };
}

export function selectedDownloadsFromUpdatePlan(
  plan: UpdateMirrorSelectionPlan,
): SelectedDownloads | null {
  if (plan.requiresFull && !plan.fullUrl) {
    return null;
  }
  if (plan.requiresPatch && !plan.patchUrl) {
    return null;
  }

  return {
    fullUrl: plan.requiresFull ? plan.fullUrl! : '',
    patchUrl: plan.requiresPatch ? plan.patchUrl : null,
    sourceKind: plan.sourceKind,
  };
}

export function updatePlanFullUrl(
  plan: UpdateMirrorSelectionPlan,
  fullUrl: string,
): UpdateMirrorSelectionPlan {
  return {
    ...plan,
    fullUrl,
    patchUrl:
      plan.requiresPatch && plan.sharedPatchRows
        ? (findSharedPatchMirrorUrl(fullUrl, plan.patchRows) ?? fullUrl)
        : plan.patchUrl,
  };
}

export function updatePlanPatchUrl(
  plan: UpdateMirrorSelectionPlan,
  patchUrl: string,
): UpdateMirrorSelectionPlan {
  return {
    ...plan,
    patchUrl,
  };
}

function normalizePatchDateKey(
  value: string | null | undefined,
): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  const slashMatch = trimmed.match(
    /(?<month>\d{1,2})\/(?<day>\d{1,2})\/(?<year>\d{4})/,
  );
  if (slashMatch?.groups) {
    return `${slashMatch.groups.year}-${slashMatch.groups.month.padStart(
      2,
      '0',
    )}-${slashMatch.groups.day.padStart(2, '0')}`;
  }

  const dotMatch = trimmed.match(
    /(?<day>\d{1,2})\.(?<month>\d{1,2})\.(?<year>\d{4})/,
  );
  if (dotMatch?.groups) {
    return `${dotMatch.groups.year}-${dotMatch.groups.month.padStart(
      2,
      '0',
    )}-${dotMatch.groups.day.padStart(2, '0')}`;
  }

  const timestamp = new Date(trimmed).getTime();
  if (Number.isNaN(timestamp)) return null;
  return new Date(timestamp).toISOString().slice(0, 10);
}

function normalizePatchSignal(value: string | null | undefined): string {
  return (value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function scorePatchFromSource(
  source: MatchedSourceView,
  patch: SteamPatchCandidate,
): SteamPatchSuggestion | null {
  const snapshot = source.snapshot;
  const sourceDateKey = normalizePatchDateKey(snapshot?.observedPatchDate);
  const patchDateKey =
    normalizePatchDateKey(patch.patchDate) ??
    normalizePatchDateKey(patch.publishedAt);
  const sourceVersion = normalizePatchSignal(snapshot?.observedVersion);
  const sourceBuild = normalizePatchSignal(snapshot?.observedBuildId);
  const patchText = normalizePatchSignal(
    `${patch.patchTitle} ${patch.title} ${patch.buildId ?? ''}`,
  );
  const reasons: string[] = [];
  let score = 0;

  if (sourceDateKey && patchDateKey && sourceDateKey === patchDateKey) {
    score += source.downloadMirrors.some((mirror) => mirror.kind === 'patch')
      ? 100
      : 75;
    reasons.push('source date');
  }

  if (
    sourceBuild &&
    patch.buildId &&
    sourceBuild === normalizePatchSignal(patch.buildId)
  ) {
    score += 120;
    reasons.push('build');
  }

  if (sourceVersion && patchText.includes(sourceVersion)) {
    score += 20;
    reasons.push('version');
  }

  if (score <= 0) {
    return null;
  }

  return {
    key: getPatchHistoryKey(patch),
    label: `Likely match: ${reasons.join(', ')}`,
    score,
  };
}

export function getLikelyPatchForUpdateSource(
  source: MatchedSourceView,
  patches: SteamPatchCandidate[],
): SteamPatchSuggestion | null {
  if (source.matchedPatch) {
    return {
      key: getPatchHistoryKey(source.matchedPatch),
      label: 'Matches selected source',
      score: 1000,
    };
  }

  return (
    patches
      .map((patch) => scorePatchFromSource(source, patch))
      .filter((entry): entry is SteamPatchSuggestion => entry != null)
      .sort((left, right) => right.score - left.score)[0] ?? null
  );
}

export function formatEtaLabel(value: number | null | undefined): string {
  if (value == null || value < 0) return 'ETA unknown';
  if (value === 0) return 'Finishing';
  if (value < 60) return `ETA ${value}s`;

  const minutes = Math.floor(value / 60);
  const seconds = value % 60;
  if (minutes < 60) {
    return seconds > 0 ? `ETA ${minutes}m ${seconds}s` : `ETA ${minutes}m`;
  }

  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes > 0
    ? `ETA ${hours}h ${remainingMinutes}m`
    : `ETA ${hours}h`;
}
