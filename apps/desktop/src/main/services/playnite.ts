import { readdir, readFile, stat } from 'node:fs/promises';
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
} from 'node:path';

import type {
  PlayniteExecutableCandidate,
  PlayniteExecutableConfidence,
  PlayniteExecutableSelectionRecord,
  PlayniteExecutableStatus,
  PlayniteLaunchProfile,
  PlayniteManifest,
  PlayniteManifestGame,
  TrackedItemView,
} from '@gamevault/shared-types';

import { buildSteamStoreAppUrl } from '@gamevault/steam-core';

const GAMEVAULT_LIBRARY_NAME = 'GameVault';
const STEAM_APP_ID_FILE = 'steam_appid.txt';
const PLAYNITE_PLUGIN_FOLDER_NAME = 'GameVault';

export interface PlayniteManifestLaunchOptions {
  duoStreamIntegrationEnabled?: boolean;
  duoStreamLauncherScriptPath?: string | null;
  duoStreamUsePlayniteLauncher?: boolean;
}

const NON_GAME_NAME_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /^unins/i, reason: 'Uninstaller' },
  { pattern: /^unitycrashhandler/i, reason: 'Unity crash handler' },
  { pattern: /^vc_redist/i, reason: 'Visual C++ redistributable' },
  { pattern: /^vcredist/i, reason: 'Visual C++ redistributable' },
  { pattern: /^dxwebsetup/i, reason: 'DirectX installer' },
  { pattern: /^ue4?prereqsetup/i, reason: 'Unreal prerequisites installer' },
  { pattern: /^easyanticheat/i, reason: 'Anti-cheat helper' },
  { pattern: /^start[_-]protected[_-]game$/i, reason: 'Anti-cheat launcher' },
  { pattern: /eos[_-]?setup/i, reason: 'EOS setup helper' },
  { pattern: /[-_]friend$/i, reason: 'Friend-pass executable variant' },
  { pattern: /[-_]trial$/i, reason: 'Trial executable variant' },
  { pattern: /[-_]dev$/i, reason: 'Development executable variant' },
  {
    pattern:
      /[_-](?:dx11|dx12|d3d11|d3d12|directx11|directx12|vulkan|vk)$/i,
    reason: 'Alternate renderer variant',
  },
  { pattern: /^rapidcrc/i, reason: 'Checksum utility' },
  { pattern: /crash/i, reason: 'Crash reporting helper' },
  { pattern: /^redengineerrorreporter$/i, reason: 'Crash/error reporting helper' },
  { pattern: /^crs-/i, reason: 'Support/reporting helper' },
  { pattern: /^epicwebhelper/i, reason: 'Web helper' },
  { pattern: /^cefsharp\.browsersubprocess/i, reason: 'Browser subprocess' },
  { pattern: /^unrealcefsubprocess$/i, reason: 'Browser subprocess' },
  { pattern: /^smartsteamloader/i, reason: 'Steam loader wrapper' },
  { pattern: /^activationui$/i, reason: 'Activation helper' },
  { pattern: /^language(?:setup)?/i, reason: 'Language setup utility' },
  { pattern: /^setup/i, reason: 'Setup utility' },
  { pattern: /installer/i, reason: 'Installer' },
  { pattern: /patcher/i, reason: 'Patcher utility' },
  { pattern: /^editor$/i, reason: 'Editor executable' },
  { pattern: /^driverversionchecker$/i, reason: 'Driver version checker' },
  { pattern: /^layerschecker$/i, reason: 'Launcher compatibility checker' },
  { pattern: /^bssndrpt(?:64)?$/i, reason: 'Sound reporting helper' },
  { pattern: /^beat(?:down|tracker)$/i, reason: 'Audio analysis helper' },
  { pattern: /resourceconverter/i, reason: 'Resource converter utility' },
  { pattern: /adventure\s*guide/i, reason: 'Bonus guide app' },
  { pattern: /art\s*book/i, reason: 'Bonus artbook app' },
  { pattern: /soundtrack/i, reason: 'Bonus soundtrack app' },
  { pattern: /^7za$/i, reason: 'Archive utility' },
  { pattern: /^javaw?$/i, reason: 'Java runtime' },
  { pattern: /^j(access|ab|fr|runscript|keytool|kinit|klist|ktab|rmi)/i, reason: 'Java runtime tool' },
  { pattern: /^(?:keytool|kinit|klist|ktab|rmid|rmiregistry)$/i, reason: 'Java runtime tool' },
  { pattern: /^xma2encode$/i, reason: 'Encoding utility' },
  { pattern: /^xwmaencode$/i, reason: 'Encoding utility' },
  { pattern: /^lame$/i, reason: 'Audio utility' },
  { pattern: /^opusenc$/i, reason: 'Audio utility' },
];

const NON_GAME_PATH_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /(^|[\\/])_CommonRedist[\\/]/i, reason: 'Redistributable folder' },
  { pattern: /(^|[\\/])__Installer[\\/]/i, reason: 'Installer folder' },
  { pattern: /(^|[\\/])DotNetCore[\\/]/i, reason: '.NET runtime folder' },
  { pattern: /(^|[\\/])AdvGuide[\\/]/i, reason: 'Bonus guide folder' },
  { pattern: /(^|[\\/])ArtbookOST[\\/]/i, reason: 'Bonus artbook/soundtrack folder' },
  { pattern: /(^|[\\/])Artbook[\\/]/i, reason: 'Bonus artbook folder' },
  { pattern: /(^|[\\/])Soundtrack[\\/]/i, reason: 'Bonus soundtrack folder' },
  { pattern: /(^|[\\/])Bonus(?:Content)?[\\/]/i, reason: 'Bonus content folder' },
  { pattern: /(^|[\\/])EasyAntiCheat[\\/]/i, reason: 'Anti-cheat helper folder' },
  {
    pattern: /(^|[\\/])Engine[\\/]Extras[\\/]Redist[\\/]/i,
    reason: 'Unreal redistributable folder',
  },
  {
    pattern: /(^|[\\/])Launcher[\\/]runtimes[\\/]/i,
    reason: 'Launcher runtime helper',
  },
  { pattern: /(^|[\\/])jre(?:64)?[\\/]bin[\\/]/i, reason: 'Bundled Java runtime' },
  {
    pattern: /(^|[\\/])StreamingAssets[\\/]Patcher[\\/]/i,
    reason: 'Bundled patcher utility',
  },
  {
    pattern: /(^|[\\/])Plugins[\\/]Sentry[\\/]/i,
    reason: 'Sentry crash reporting helper',
  },
  { pattern: /(^|[\\/])BinEditor[\\/]/i, reason: 'Editor tools folder' },
  { pattern: /(^|[\\/])tools?[\\/]/i, reason: 'Tools folder' },
];

const TITLE_STOP_WORDS = new Set([
  'a',
  'an',
  'and',
  'edition',
  'for',
  'of',
  'part',
  'remastered',
  'the',
]);
const ACRONYM_OMIT_WORDS = new Set(['edition', 'part', 'remastered']);

function normalizeText(value: string | null | undefined): string {
  return (value ?? '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function compactText(value: string | null | undefined): string {
  return normalizeText(value).replace(/\s+/g, '');
}

function titleTokens(value: string | null | undefined): string[] {
  return normalizeText(value)
    .split(/\s+/)
    .filter((token) => token.length > 0);
}

function significantTitleTokens(value: string | null | undefined): string[] {
  return titleTokens(value).filter(
    (token) => token.length > 1 && !TITLE_STOP_WORDS.has(token),
  );
}

function titleAcronyms(value: string | null | undefined): Set<string> {
  const tokens = titleTokens(value);
  const significant = significantTitleTokens(value);
  const acronymTokens = tokens.filter(
    (token) => !ACRONYM_OMIT_WORDS.has(token),
  );
  const acronyms = new Set<string>();
  if (tokens.length > 1) {
    acronyms.add(tokens.map((token) => token[0]).join(''));
  }
  if (acronymTokens.length > 1) {
    acronyms.add(acronymTokens.map((token) => token[0]).join(''));
  }
  if (significant.length > 1) {
    acronyms.add(significant.map((token) => token[0]).join(''));
  }
  const romanSuffix = tokens.find((token) => /^[ivx]+$/.test(token));
  const acronymRomanSuffix = acronymTokens.find((token) =>
    /^[ivx]+$/.test(token),
  );
  if (acronymRomanSuffix && acronymTokens.length > 1) {
    acronyms.add(
      acronymTokens
        .filter((token) => token !== acronymRomanSuffix)
        .map((token) => token[0])
        .join('') + acronymRomanSuffix,
    );
  }
  if (romanSuffix && significant.length > 1) {
    acronyms.add(
      significant
        .filter((token) => token !== romanSuffix)
        .map((token) => token[0])
        .join('') + romanSuffix,
    );
  }
  return acronyms;
}

function pathIsInsideOrEqual(parentPath: string, childPath: string): boolean {
  const relativePath = relative(resolve(parentPath), resolve(childPath));
  return (
    !relativePath ||
    (!relativePath.startsWith('..') && !isAbsolute(relativePath))
  );
}

export function assertSafePlaynitePluginInstallTarget(params: {
  extensionsPath: string;
  pluginInstallPath: string;
  protectedPaths?: Array<string | null | undefined>;
}): void {
  const extensionsPath = resolve(params.extensionsPath);
  const pluginInstallPath = resolve(params.pluginInstallPath);
  if (
    basename(pluginInstallPath).toLowerCase() !==
    PLAYNITE_PLUGIN_FOLDER_NAME.toLowerCase()
  ) {
    throw new Error(
      'Refusing to install the Playnite plugin because the target folder is not the GameVault plugin folder.',
    );
  }
  if (
    extensionsPath.toLowerCase() === pluginInstallPath.toLowerCase() ||
    !pathIsInsideOrEqual(extensionsPath, pluginInstallPath)
  ) {
    throw new Error(
      'Refusing to install the Playnite plugin outside the configured Playnite Extensions folder.',
    );
  }

  for (const protectedPath of params.protectedPaths ?? []) {
    const trimmed = protectedPath?.trim();
    if (!trimmed) {
      continue;
    }
    const resolvedProtectedPath = resolve(trimmed);
    if (
      pathIsInsideOrEqual(resolvedProtectedPath, pluginInstallPath) ||
      pathIsInsideOrEqual(pluginInstallPath, resolvedProtectedPath)
    ) {
      throw new Error(
        'The Playnite Extensions folder cannot be inside a GameVault library or installed game folder.',
      );
    }
  }
}

function pathSegments(relativePath: string): string[] {
  return relativePath.split(/[\\/]+/).filter(Boolean);
}

function is64BitFolderSegment(segment: string): boolean {
  return (
    segment === 'x64' ||
    segment === 'win64' ||
    segment === 'amd64' ||
    segment === 'x86_64' ||
    segment === '64bit' ||
    /^[a-z][a-z0-9_-]*64$/.test(segment)
  );
}

function is32BitFolderSegment(segment: string): boolean {
  return (
    segment === 'x86' ||
    segment === 'win32' ||
    segment === '32bit' ||
    /^[a-z][a-z0-9_-]*32$/.test(segment)
  );
}

function rendererVariantBaseStem(stem: string): string | null {
  const match = stem.match(
    /^(.*?)(?:[_-](?:dx11|dx12|d3d11|d3d12|directx11|directx12|vulkan|vk))$/i,
  );
  const baseStem = match?.[1]?.trim() ?? '';
  return baseStem ? baseStem : null;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function listFilesRecursive(rootPath: string): Promise<string[]> {
  const files: string[] = [];
  const walk = async (currentPath: string, isRoot = false) => {
    let entries;
    try {
      entries = await readdir(currentPath, { withFileTypes: true });
    } catch (error) {
      if (isRoot) {
        throw error;
      }
      return;
    }
    await Promise.all(
      entries.map(async (entry) => {
        const entryPath = join(currentPath, entry.name);
        if (entry.isDirectory()) {
          await walk(entryPath);
          return;
        }
        if (entry.isFile()) {
          files.push(entryPath);
        }
      }),
    );
  };
  await walk(rootPath, true);
  return files;
}

async function findSteamAppIdFiles(
  rootPath: string,
  knownFiles?: string[],
): Promise<Map<string, string>> {
  const appIds = new Map<string, string>();
  let files = knownFiles ?? [];
  try {
    files = knownFiles ?? (await listFilesRecursive(rootPath));
  } catch {
    return appIds;
  }
  await Promise.all(
    files
      .filter((filePath) => basename(filePath).toLowerCase() === STEAM_APP_ID_FILE)
      .map(async (filePath) => {
        try {
          const value = (await readFile(filePath, 'utf8')).trim().split(/\s+/)[0];
          if (value) {
            appIds.set(resolve(dirname(filePath)), value);
          }
        } catch {
          // Ignore unreadable release metadata; executable scoring can continue.
        }
      }),
  );
  return appIds;
}

function applyPatternExclusions(
  candidate: PlayniteExecutableCandidate,
): void {
  const stem = basename(candidate.fileName, extname(candidate.fileName));
  for (const { pattern, reason } of NON_GAME_NAME_PATTERNS) {
    if (pattern.test(stem) || pattern.test(candidate.fileName)) {
      candidate.excluded = true;
      candidate.penalties.push(reason);
    }
  }
  for (const { pattern, reason } of NON_GAME_PATH_PATTERNS) {
    if (pattern.test(candidate.relativePath)) {
      candidate.excluded = true;
      candidate.penalties.push(reason);
    }
  }
}

export function getPlayniteExecutableExclusionReason(
  executablePath: string,
  installPath?: string | null,
): string | null {
  const resolvedExecutablePath = resolve(executablePath);
  const relativePath = installPath
    ? relative(resolve(installPath), resolvedExecutablePath)
    : resolvedExecutablePath;
  const candidate: PlayniteExecutableCandidate = {
    excluded: false,
    fileName: basename(resolvedExecutablePath),
    fullPath: resolvedExecutablePath,
    penalties: [],
    reasons: [],
    relativePath,
    score: 0,
    sizeBytes: 0,
  };
  applyPatternExclusions(candidate);
  return candidate.penalties[0] ?? null;
}

function addScore(
  candidate: PlayniteExecutableCandidate,
  points: number,
  label: string,
): void {
  candidate.score += points;
  if (points >= 0) {
    candidate.reasons.push(label);
  } else {
    candidate.penalties.push(label);
  }
}

function suppressAlternateRendererVariants(
  candidates: PlayniteExecutableCandidate[],
): void {
  const candidatesByDirectoryAndStem = new Set(
    candidates
      .filter((candidate) => !candidate.excluded)
      .map((candidate) => {
        const directory = dirname(candidate.relativePath).toLowerCase();
        const stem = basename(
          candidate.fileName,
          extname(candidate.fileName),
        ).toLowerCase();
        return `${directory}\0${stem}`;
      }),
  );

  for (const candidate of candidates) {
    if (candidate.excluded) {
      continue;
    }
    const stem = basename(candidate.fileName, extname(candidate.fileName));
    const baseStem = rendererVariantBaseStem(stem);
    if (!baseStem) {
      continue;
    }
    const directory = dirname(candidate.relativePath).toLowerCase();
    const baseKey = `${directory}\0${baseStem.toLowerCase()}`;
    if (!candidatesByDirectoryAndStem.has(baseKey)) {
      continue;
    }
    candidate.excluded = true;
    candidate.penalties.push('Alternate renderer variant with base executable');
  }
}

function scoreTitleMatch(
  candidate: PlayniteExecutableCandidate,
  titles: string[],
): void {
  const stem = basename(candidate.fileName, extname(candidate.fileName));
  const stemCompact = compactText(stem);
  const stemNormalized = normalizeText(stem);
  for (const title of titles) {
    const titleCompact = compactText(title);
    if (!titleCompact) {
      continue;
    }
    if (stemCompact === titleCompact) {
      addScore(candidate, 75, 'Executable name matches game title');
      return;
    }
    if (titleAcronyms(title).has(stemCompact)) {
      addScore(candidate, 65, 'Executable name matches title acronym');
      return;
    }
    const tokens = significantTitleTokens(title);
    if (tokens.length > 0) {
      const matching = tokens.filter((token) => stemNormalized.includes(token));
      const ratio = matching.length / tokens.length;
      if (ratio >= 0.75) {
        addScore(candidate, 35, 'Executable name matches most title words');
        return;
      }
      if (matching.length > 0) {
        addScore(candidate, 15, 'Executable name matches a title word');
        return;
      }
    }
  }
}

async function scoreStructure(
  candidate: PlayniteExecutableCandidate,
): Promise<void> {
  const segments = pathSegments(candidate.relativePath);
  const stem = basename(candidate.fileName, extname(candidate.fileName));
  const candidateDir = dirname(candidate.fullPath);
  const lowerSegments = segments.map((segment) => segment.toLowerCase());
  const lowerFolderSegments = lowerSegments.slice(0, -1);
  const lowerName = candidate.fileName.toLowerCase();

  if (segments.length === 1) {
    addScore(candidate, 15, 'Executable is in the game folder root');
  } else if (segments.length <= 3) {
    addScore(candidate, 6, 'Executable is near the game folder root');
  }
  if (lowerSegments.includes('game')) {
    addScore(candidate, 45, 'Game content folder');
  }

  if (await pathExists(join(candidateDir, `${stem}_Data`))) {
    addScore(candidate, 110, 'Unity executable with matching data folder');
  }

  const binariesIndex = lowerSegments.indexOf('binaries');
  if (
    binariesIndex >= 0 &&
    lowerSegments[binariesIndex + 1] === 'win64'
  ) {
    addScore(candidate, 75, 'Win64 game binary folder');
    if (/shipping/i.test(candidate.fileName)) {
      addScore(candidate, 20, 'Unreal shipping executable');
    }
    if (lowerSegments[0] !== 'engine') {
      addScore(candidate, 8, 'Game-specific binary folder');
    }
  }

  if (lowerFolderSegments.some(is64BitFolderSegment)) {
    addScore(candidate, 25, '64-bit executable folder');
  }
  if (lowerSegments.includes('x64vk')) {
    addScore(candidate, 15, '64-bit Vulkan variant');
    addScore(candidate, -8, 'Alternate renderer variant');
  }
  if (lowerFolderSegments.some(is32BitFolderSegment)) {
    addScore(candidate, -25, '32-bit executable folder');
  }
  if (/[-_]trial$/i.test(stem)) {
    addScore(candidate, -45, 'Trial executable variant');
  }
  if (/[-_]friend$/i.test(stem)) {
    addScore(candidate, -45, 'Friend-pass executable variant');
  }
  if (/[-_]dev$/i.test(stem)) {
    addScore(candidate, -35, 'Development executable variant');
  }
  if (/[-_]l$/i.test(stem)) {
    addScore(candidate, -12, 'Alternate launcher executable variant');
  }
  if (/launcher/i.test(stem)) {
    addScore(candidate, -35, 'Launcher executable');
  }
  if (/editor/i.test(stem)) {
    addScore(candidate, -45, 'Editor executable');
  }
  if (/server/i.test(stem)) {
    addScore(candidate, -45, 'Server executable');
  }
  if (lowerName.includes('resourceconverter') || lowerName.includes('converter')) {
    addScore(candidate, -45, 'Converter utility');
  }
}

function scoreSteamAppIdProximity(
  candidate: PlayniteExecutableCandidate,
  appIdFiles: Map<string, string>,
  steamAppId?: number | null,
): void {
  if (!steamAppId || appIdFiles.size === 0) {
    return;
  }

  const expected = String(steamAppId);
  const candidateDir = resolve(dirname(candidate.fullPath));
  let hasMatchingAppId = false;
  let isNearMatchingAppId = false;
  for (const [appIdDir, appId] of appIdFiles) {
    if (appId !== expected) {
      continue;
    }
    hasMatchingAppId = true;
    isNearMatchingAppId =
      isNearMatchingAppId ||
      pathIsInsideOrEqual(appIdDir, candidateDir) ||
      pathIsInsideOrEqual(candidateDir, appIdDir);
  }
  if (hasMatchingAppId) {
    addScore(candidate, 12, 'Install folder contains matching steam_appid.txt');
  }
  if (isNearMatchingAppId) {
    addScore(candidate, 20, 'Executable is near matching steam_appid.txt');
  }
}

function scoreSize(candidate: PlayniteExecutableCandidate): void {
  if (candidate.sizeBytes >= 30 * 1024 * 1024) {
    addScore(candidate, 20, 'Large executable');
  } else if (candidate.sizeBytes >= 5 * 1024 * 1024) {
    addScore(candidate, 10, 'Substantial executable size');
  } else if (candidate.sizeBytes < 96 * 1024) {
    addScore(candidate, -10, 'Very small executable');
  }
}

function confidenceForCandidates(
  selected: PlayniteExecutableCandidate | null,
  candidates: PlayniteExecutableCandidate[],
): PlayniteExecutableConfidence {
  if (!selected) {
    return 'none';
  }
  const viable = candidates.filter(
    (candidate) => !candidate.excluded && candidate.score > 0,
  );
  if (viable.length === 1) {
    return 'high';
  }
  const runnerUp = viable.find(
    (candidate) => candidate.fullPath !== selected.fullPath,
  );
  const delta = selected.score - (runnerUp?.score ?? Number.NEGATIVE_INFINITY);
  if (selected.score >= 110 && delta >= 18) {
    return 'high';
  }
  if (selected.score >= 90 && delta >= 28) {
    return 'high';
  }
  if (selected.score >= 80 && delta >= 10) {
    return 'medium';
  }
  if (selected.score >= 55) {
    return 'low';
  }
  return 'none';
}

function statusForConfidence(
  confidence: PlayniteExecutableConfidence,
  hasSelectedCandidate: boolean,
): PlayniteExecutableStatus {
  return confidence === 'high' || confidence === 'medium'
    ? 'auto_selected'
    : confidence === 'none'
      ? hasSelectedCandidate
        ? 'needs_review'
        : 'missing'
      : 'needs_review';
}

export async function scanPlayniteExecutableSelection(params: {
  installPath: string;
  previousSelection?: PlayniteExecutableSelectionRecord | null;
  steamAppId?: number | null;
  steamTitle?: string | null;
  title: string;
  trackedItemId: string;
}): Promise<PlayniteExecutableSelectionRecord> {
  const installPath = resolve(params.installPath);
  const now = new Date().toISOString();
  let allFiles: string[] = [];
  let files: string[] = [];
  try {
    allFiles = await listFilesRecursive(installPath);
    files = allFiles.filter(
      (filePath) => extname(filePath).toLowerCase() === '.exe',
    );
  } catch {
    return {
      candidates: [],
      confidence: 'none',
      reviewedAt: null,
      selectedExePath: null,
      status: 'missing',
      steamAppId: params.steamAppId ?? null,
      trackedItemId: params.trackedItemId,
      updatedAt: now,
    };
  }

  const appIdFiles = await findSteamAppIdFiles(installPath, allFiles);
  const titles = [
    params.steamTitle?.trim(),
    params.title.trim(),
    basename(installPath),
  ].filter((value): value is string => Boolean(value));
  const candidates = (
    await Promise.all(
      files.map(async (filePath): Promise<PlayniteExecutableCandidate | null> => {
        let sizeBytes: number;
        try {
          sizeBytes = (await stat(filePath)).size;
        } catch {
          return null;
        }
        const candidate: PlayniteExecutableCandidate = {
          excluded: false,
          fileName: basename(filePath),
          fullPath: resolve(filePath),
          penalties: [],
          reasons: [],
          relativePath: relative(installPath, filePath),
          score: 0,
          sizeBytes,
        };
        applyPatternExclusions(candidate);
        if (!candidate.excluded) {
          scoreTitleMatch(candidate, titles);
          await scoreStructure(candidate);
          scoreSteamAppIdProximity(candidate, appIdFiles, params.steamAppId);
          scoreSize(candidate);
        }
        return candidate;
      }),
    )
  ).filter((candidate): candidate is PlayniteExecutableCandidate =>
    Boolean(candidate),
  );

  suppressAlternateRendererVariants(candidates);

  candidates.sort((left, right) => {
    if (left.excluded !== right.excluded) {
      return left.excluded ? 1 : -1;
    }
    if (right.score !== left.score) {
      return right.score - left.score;
    }
    return left.relativePath.localeCompare(right.relativePath);
  });

  const selected =
    candidates.find((candidate) => !candidate.excluded && candidate.score > 0) ??
    null;
  const confidence = confidenceForCandidates(selected, candidates);
  const status = statusForConfidence(confidence, Boolean(selected));
  const previous = params.previousSelection;
  if (
    previous?.status === 'reviewed' &&
    previous.selectedExePath &&
    candidates.some(
      (candidate) =>
        resolve(candidate.fullPath).toLowerCase() ===
          resolve(previous.selectedExePath!).toLowerCase() &&
        !candidate.excluded &&
        candidate.score > 0,
    )
  ) {
    return {
      candidates,
      confidence: previous.confidence,
      reviewedAt: previous.reviewedAt ?? now,
      selectedExePath: previous.selectedExePath,
      status: 'reviewed',
      steamAppId: params.steamAppId ?? null,
      trackedItemId: params.trackedItemId,
      updatedAt: now,
    };
  }

  return {
    candidates,
    confidence,
    reviewedAt: null,
    selectedExePath: selected?.fullPath ?? null,
    status,
    steamAppId: params.steamAppId ?? null,
    trackedItemId: params.trackedItemId,
    updatedAt: now,
  };
}

export function buildPlayniteManifest(
  items: TrackedItemView[],
  selections: PlayniteExecutableSelectionRecord[],
  options: PlayniteManifestLaunchOptions = {},
): PlayniteManifest {
  const selectionsByItemId = new Map(
    selections.map((selection) => [selection.trackedItemId, selection]),
  );
  const games: PlayniteManifestGame[] = [];
  for (const view of items) {
    const steamAppId = view.item.steamAppId;
    const installPath = view.installRecord?.installPath ?? view.fileState.finalPath;
    const selection = selectionsByItemId.get(view.item.id);
    const executablePath = selection?.selectedExePath ?? null;
    if (
      !steamAppId ||
      !installPath ||
      !selection ||
      !executablePath ||
      selection.status === 'needs_review' ||
      selection.status === 'missing'
    ) {
      continue;
    }
    const launch = buildPlayniteLaunchProfile({
      executablePath,
      installPath,
      options,
      steamAppId,
      view,
    });
    games.push({
      executablePath,
      executableRelativePath: relative(installPath, executablePath),
      installPath,
      launch,
      source: GAMEVAULT_LIBRARY_NAME,
      steamAppId,
      steamStoreUrl: buildSteamStoreAppUrl(steamAppId),
      steamTitle: view.item.steamTitle ?? null,
      title: view.item.steamTitle ?? view.item.title,
      trackedItemId: view.item.id,
      version: view.installRecord?.installedVersion ?? null,
    });
  }

  games.sort((left, right) => left.title.localeCompare(right.title));
  return {
    generatedAt: new Date().toISOString(),
    games,
    library: GAMEVAULT_LIBRARY_NAME,
    version: 1,
  };
}

function buildPlayniteLaunchProfile(params: {
  executablePath: string;
  installPath: string;
  options: PlayniteManifestLaunchOptions;
  steamAppId: number;
  view: TrackedItemView;
}): PlayniteLaunchProfile {
  const workingDirectory = dirname(params.executablePath);
  const shouldUseDuoStream =
    params.options.duoStreamIntegrationEnabled === true &&
    params.options.duoStreamUsePlayniteLauncher !== false &&
    params.view.onlineFix?.status === 'enabled' &&
    Boolean(params.options.duoStreamLauncherScriptPath?.trim());

  if (!shouldUseDuoStream) {
    return {
      executablePath: params.executablePath,
      mode: 'directExe',
      steamAppId: params.steamAppId,
      workingDirectory,
    };
  }

  return {
    executablePath: params.executablePath,
    launcherScriptPath: params.options.duoStreamLauncherScriptPath ?? null,
    mirrorSteamActiveProcess: true,
    mode: 'duoSteamExe',
    steamAppId: params.steamAppId,
    waitForGameExit: true,
    workingDirectory: params.installPath,
    writeSteamAppId: true,
  };
}
