import { access, mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { execFile } from 'node:child_process';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

function normalizeTitle(input: string): string {
  return input
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

export interface ImportFolderCandidate {
  folderName: string;
  normalizedTitle: string;
  rootPath: string;
  title: string;
}

export function sanitizePathSegment(input: string): string {
  // Intentional: strip Windows-invalid path characters and ASCII control chars.
  // eslint-disable-next-line no-control-regex
  return input.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '').trim();
}

export async function pathExists(target: string): Promise<boolean> {
  try {
    await access(target, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export async function directoryHasEntries(target: string): Promise<boolean> {
  try {
    return (await readdir(target)).length > 0;
  } catch {
    return false;
  }
}

async function isDirectoryPath(target: string): Promise<boolean> {
  try {
    return (await stat(target)).isDirectory();
  } catch {
    return false;
  }
}

async function findFilesWithExtension(
  rootPath: string,
  extension: string,
): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(rootPath, { withFileTypes: true });
  } catch {
    return [];
  }

  const matches: string[] = [];
  for (const entry of entries) {
    const entryPath = resolve(join(rootPath, entry.name));
    if (entry.isDirectory()) {
      matches.push(...(await findFilesWithExtension(entryPath, extension)));
    } else if (
      entry.isFile() &&
      entry.name.toLowerCase().endsWith(extension.toLowerCase())
    ) {
      matches.push(entryPath);
    }
  }
  return matches;
}

async function dismountIsoImages(isoPaths: string[]): Promise<string[]> {
  if (isoPaths.length === 0 || process.platform !== 'win32') {
    return [];
  }

  const script = `
$ErrorActionPreference = 'Stop'
$imagePaths = @()
if ($env:VAULTTRACK_ISO_PATHS) {
  $imagePaths = $env:VAULTTRACK_ISO_PATHS | ConvertFrom-Json
}
foreach ($imagePath in $imagePaths) {
  $image = Get-DiskImage -ImagePath $imagePath -ErrorAction SilentlyContinue
  if ($image -and $image.Attached) {
    Dismount-DiskImage -ImagePath $imagePath -ErrorAction Stop | Out-Null
    Write-Output $imagePath
  }
}
`;
  const { stdout } = await execFileAsync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      script,
    ],
    {
      env: {
        ...process.env,
        VAULTTRACK_ISO_PATHS: JSON.stringify(isoPaths),
      },
      windowsHide: true,
    },
  );
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

export async function dismountIsoImagesUnderPath(params: {
  rootPath: string;
  runDismount?: (isoPaths: string[]) => Promise<string[]>;
}): Promise<string[]> {
  const isoPaths = await findFilesWithExtension(
    resolve(params.rootPath),
    '.iso',
  );
  return (params.runDismount ?? dismountIsoImages)(isoPaths);
}

export async function planLibraryPaths(params: {
  canonicalTitle: string;
  rootLibraryPath: string;
  releaseSuffix: string;
  sourceKind: 'elamigos' | 'steamrip';
}): Promise<{
  extractPath: string;
  finalPath: string;
  stagePath: string;
  stageRootPath: string;
}> {
  const safeTitle = sanitizePathSegment(params.canonicalTitle);
  const safeStageName = sanitizePathSegment(
    `${params.canonicalTitle}_${params.releaseSuffix}`,
  );
  const stageRootPath = resolve(join(params.rootLibraryPath, '_STAGING'));
  const stagePath = resolve(join(stageRootPath, safeStageName));
  const finalPath = resolve(join(params.rootLibraryPath, safeTitle));
  const extractPath =
    params.sourceKind === 'steamrip'
      ? resolve(join(stageRootPath, safeTitle, 'contents'))
      : stagePath;

  return { extractPath, finalPath, stagePath, stageRootPath };
}

export function planSteamRipExtractPathFromJob(params: {
  finalPath: string;
  stagePath: string;
}): string {
  return resolve(
    join(dirname(params.stagePath), basename(params.finalPath), 'contents'),
  );
}

export async function ensureDirectory(target: string): Promise<void> {
  await mkdir(target, { recursive: true });
}

export async function stageMove(params: {
  finalPath: string;
  stagePath: string;
}): Promise<void> {
  await ensureDirectory(resolve(join(params.finalPath, '..')));
  await rename(params.stagePath, params.finalPath);
}

function assertPathInside(parentPath: string, targetPath: string): void {
  const relativePath = relative(resolve(parentPath), resolve(targetPath));
  if (
    relativePath === '' ||
    relativePath.startsWith('..') ||
    isAbsolute(relativePath)
  ) {
    throw new Error(`Refusing to operate outside ${parentPath}`);
  }
}

async function moveDirectoryContents(
  sourcePath: string,
  targetPath: string,
): Promise<void> {
  await ensureDirectory(targetPath);
  const entries = await readdir(sourcePath, { withFileTypes: true });

  for (const entry of entries) {
    const fromPath = resolve(join(sourcePath, entry.name));
    const toPath = resolve(join(targetPath, entry.name));
    assertPathInside(sourcePath, fromPath);
    assertPathInside(targetPath, toPath);

    if (entry.isDirectory() && (await isDirectoryPath(toPath))) {
      await moveDirectoryContents(fromPath, toPath);
      continue;
    }

    if (await pathExists(toPath)) {
      throw new Error(`Refusing to overwrite existing staged file: ${toPath}`);
    }

    await rename(fromPath, toPath);
  }

  await rm(sourcePath, { force: true, recursive: true });
}

export async function normalizeDuplicateNestedFolder(params: {
  nestedFolderName: string;
  rootPath: string;
}): Promise<boolean> {
  const rootPath = resolve(params.rootPath);
  const nestedFolderName = params.nestedFolderName.trim();
  if (!nestedFolderName) {
    return false;
  }

  const nestedPath = resolve(join(rootPath, nestedFolderName));
  if (!(await isDirectoryPath(nestedPath))) {
    return false;
  }

  assertPathInside(rootPath, nestedPath);
  await moveDirectoryContents(nestedPath, rootPath);
  return true;
}

function isSteamRipExtraFolder(folderName: string): boolean {
  return ['_commonredist', '__macosx'].includes(folderName.toLowerCase());
}

function isSteamRipExtraFile(fileName: string): boolean {
  const lower = fileName.toLowerCase();
  const stem = lower.replace(/\.[^.]+$/, '');
  return (
    lower.endsWith('.url') ||
    (lower.endsWith('.txt') && /(?:read[\s_-]*me|instruction)/i.test(stem))
  );
}

async function collectDirectories(params: {
  depth: number;
  maxDepth: number;
  rootPath: string;
}): Promise<Array<{ depth: number; name: string; path: string }>> {
  if (params.depth > params.maxDepth) {
    return [];
  }

  const entries = await readdir(params.rootPath, { withFileTypes: true });
  const directories = entries.filter(
    (entry) => entry.isDirectory() && !isSteamRipExtraFolder(entry.name),
  );
  const results: Array<{ depth: number; name: string; path: string }> = [];

  for (const entry of directories) {
    const childPath = resolve(join(params.rootPath, entry.name));
    results.push({ depth: params.depth, name: entry.name, path: childPath });
    results.push(
      ...(await collectDirectories({
        depth: params.depth + 1,
        maxDepth: params.maxDepth,
        rootPath: childPath,
      })),
    );
  }

  return results;
}

async function collectSteamRipPayloadGameFolders(params: {
  depth: number;
  maxDepth: number;
  rootPath: string;
}): Promise<Array<{ depth: number; name: string; path: string }>> {
  if (params.depth > params.maxDepth) {
    return [];
  }

  const entries = await readdir(params.rootPath, { withFileTypes: true });
  const nonExtraDirectories = entries.filter(
    (entry) => entry.isDirectory() && !isSteamRipExtraFolder(entry.name),
  );
  const unexpectedFiles = entries.filter(
    (entry) => entry.isFile() && !isSteamRipExtraFile(entry.name),
  );
  const hasSteamRipExtra = entries.some((entry) =>
    entry.isDirectory()
      ? isSteamRipExtraFolder(entry.name)
      : entry.isFile() && isSteamRipExtraFile(entry.name),
  );

  const results: Array<{ depth: number; name: string; path: string }> = [];
  if (
    hasSteamRipExtra &&
    nonExtraDirectories.length === 1 &&
    unexpectedFiles.length === 0
  ) {
    const gameDirectory = nonExtraDirectories[0]!;
    return [
      {
        depth: params.depth + 1,
        name: gameDirectory.name,
        path: resolve(join(params.rootPath, gameDirectory.name)),
      },
    ];
  }

  for (const entry of nonExtraDirectories) {
    results.push(
      ...(await collectSteamRipPayloadGameFolders({
        depth: params.depth + 1,
        maxDepth: params.maxDepth,
        rootPath: resolve(join(params.rootPath, entry.name)),
      })),
    );
  }

  return results;
}

function isSteamRipVersionedTitleFolder(
  folderName: string,
  expectedTitle: string,
): boolean {
  const normalizedName = normalizeTitle(folderName);
  if (!normalizedName.startsWith(`${expectedTitle} `)) {
    return false;
  }

  const suffix = normalizedName.slice(expectedTitle.length).trim();
  return /^(?:v\s*\d|version\s+\d|build\s+\d|update\s+\d|patch\s+\d)/i.test(
    suffix,
  );
}

async function findSteamRipContentFolder(params: {
  canonicalTitle: string;
  extractPath: string;
}): Promise<string> {
  const payloadGameFolders = await collectSteamRipPayloadGameFolders({
    depth: 0,
    maxDepth: 4,
    rootPath: params.extractPath,
  });
  if (payloadGameFolders.length === 1) {
    return payloadGameFolders[0]!.path;
  }
  if (payloadGameFolders.length > 1) {
    throw new Error(
      `Found multiple plausible SteamRIP game folders for ${params.canonicalTitle}: ${payloadGameFolders
        .map((entry) => entry.path)
        .join(', ')}`,
    );
  }

  const directories = await collectDirectories({
    depth: 0,
    maxDepth: 4,
    rootPath: params.extractPath,
  });
  const expectedTitle = normalizeTitle(params.canonicalTitle);
  const exactMatch = directories
    .filter((entry) => normalizeTitle(entry.name) === expectedTitle)
    .sort((left, right) => right.depth - left.depth)[0];
  if (exactMatch) {
    return exactMatch.path;
  }

  const versionedMatches = directories.filter((entry) =>
    isSteamRipVersionedTitleFolder(entry.name, expectedTitle),
  );
  if (versionedMatches.length === 1) {
    return versionedMatches[0]!.path;
  }
  if (versionedMatches.length > 1) {
    throw new Error(
      `Found multiple plausible SteamRIP game folders for ${params.canonicalTitle}: ${versionedMatches
        .map((entry) => entry.path)
        .join(', ')}`,
    );
  }

  throw new Error(
    `Unable to find extracted SteamRIP game folder for ${params.canonicalTitle}.`,
  );
}

export async function finalizeSteamRipExtraction(params: {
  canonicalTitle: string;
  extractPath: string;
  finalPath: string;
  stageRootPath: string;
}): Promise<void> {
  const safeTitle = sanitizePathSegment(params.canonicalTitle);
  const expectedFinalPath = resolve(
    join(resolve(params.stageRootPath, '..'), safeTitle),
  );
  const finalPath = resolve(params.finalPath);
  if (finalPath !== expectedFinalPath) {
    throw new Error(
      `Unexpected final SteamRIP library path: ${params.finalPath}`,
    );
  }

  const extractWorkspacePath = resolve(join(params.extractPath, '..'));
  assertPathInside(params.stageRootPath, extractWorkspacePath);
  assertPathInside(dirname(finalPath), finalPath);

  const contentFolderPath = await findSteamRipContentFolder({
    canonicalTitle: params.canonicalTitle,
    extractPath: params.extractPath,
  });
  assertPathInside(params.extractPath, contentFolderPath);

  await ensureDirectory(dirname(finalPath));
  await rm(finalPath, { force: true, recursive: true });
  await rename(contentFolderPath, finalPath);
  await rm(extractWorkspacePath, { force: true, recursive: true });
}

export async function removeKnownLibraryPaths(params: {
  finalPath?: string | null;
  rootLibraryPath: string;
  stagePath?: string | null;
}): Promise<string[]> {
  const rootLibraryPath = resolve(params.rootLibraryPath);
  const candidates = new Set<string>();

  if (params.finalPath) {
    candidates.add(resolve(params.finalPath));
  }

  if (params.stagePath) {
    const stagePath = resolve(params.stagePath);
    candidates.add(stagePath);
    candidates.add(resolve(`${stagePath}_full`));
    candidates.add(resolve(`${stagePath}_update`));

    if (params.finalPath) {
      candidates.add(
        resolve(join(dirname(stagePath), basename(params.finalPath))),
      );
    }
  }

  const deletedPaths: string[] = [];
  for (const candidate of candidates) {
    assertPathInside(rootLibraryPath, candidate);
    await rm(candidate, { force: true, recursive: true });
    deletedPaths.push(candidate);
  }

  return deletedPaths;
}

export async function removeKnownStagingPaths(params: {
  extractionPath?: string | null;
  rootLibraryPath: string;
  stagePath?: string | null;
}): Promise<string[]> {
  const rootLibraryPath = resolve(params.rootLibraryPath);
  const candidates = new Set<string>();

  if (params.stagePath) {
    const stagePath = resolve(params.stagePath);
    candidates.add(stagePath);
    candidates.add(resolve(`${stagePath}_full`));
    candidates.add(resolve(`${stagePath}_update`));
  }

  if (params.extractionPath) {
    candidates.add(resolve(join(params.extractionPath, '..')));
  }

  const deletedPaths: string[] = [];
  for (const candidate of candidates) {
    assertPathInside(rootLibraryPath, candidate);
    await rm(candidate, { force: true, recursive: true });
    deletedPaths.push(candidate);
  }

  return deletedPaths;
}

export async function scanImportFolders(params: {
  listDirectoryNames?: (rootLibraryPath: string) => Promise<string[]>;
  rootLibraryPath: string;
}): Promise<ImportFolderCandidate[]> {
  const listDirectoryNames =
    params.listDirectoryNames ??
    (async (rootLibraryPath: string) => {
      const entries = await readdir(rootLibraryPath, { withFileTypes: true });
      return entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
    });

  const names = await listDirectoryNames(params.rootLibraryPath);
  return names
    .filter((name) => name !== '_STAGING')
    .map((folderName) => ({
      folderName,
      normalizedTitle: normalizeTitle(folderName),
      rootPath: resolve(join(params.rootLibraryPath, folderName)),
      title: folderName,
    }));
}
