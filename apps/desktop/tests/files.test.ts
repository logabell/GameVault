import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  finalizeSteamRipExtraction,
  normalizeDuplicateNestedFolder,
  pathExists,
  planLibraryPaths,
  planSteamRipExtractPathFromJob,
  removeKnownLibraryPaths,
  scanImportFolders,
} from '../src/main/services/files.js';

describe('planLibraryPaths', () => {
  it('uses staging suffixes and extracts SteamRIP into a staging contents workspace', async () => {
    const plan = await planLibraryPaths({
      canonicalTitle: 'Frostpunk 2',
      rootLibraryPath: 'C:/Games',
      releaseSuffix: '123456',
      sourceKind: 'steamrip',
    });

    expect(plan.stageRootPath).toBe('C:\\Games\\_STAGING');
    expect(plan.stagePath).toBe('C:\\Games\\_STAGING\\Frostpunk 2_123456');
    expect(plan.finalPath).toBe('C:\\Games\\Frostpunk 2');
    expect(plan.extractPath).toBe('C:\\Games\\_STAGING\\Frostpunk 2\\contents');
  });

  it('keeps ElAmigos extraction inside staging', async () => {
    const plan = await planLibraryPaths({
      canonicalTitle: 'Frostpunk 2',
      rootLibraryPath: 'C:/Games',
      releaseSuffix: '1.5.4.H2',
      sourceKind: 'elamigos',
    });

    expect(plan.stagePath).toBe('C:\\Games\\_STAGING\\Frostpunk 2_1.5.4.H2');
    expect(plan.finalPath).toBe('C:\\Games\\Frostpunk 2');
    expect(plan.extractPath).toBe('C:\\Games\\_STAGING\\Frostpunk 2_1.5.4.H2');
  });

  it('recreates SteamRIP extraction paths from persisted job paths', () => {
    expect(
      planSteamRipExtractPathFromJob({
        finalPath: 'C:/Games/Frostpunk 2',
        stagePath: 'C:/Games/_STAGING/Frostpunk 2_123456',
      }),
    ).toBe('C:\\Games\\_STAGING\\Frostpunk 2\\contents');
  });
});

describe('finalizeSteamRipExtraction', () => {
  it('promotes only the SteamRIP game folder and removes extracted extras', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'vaulttrack-steamrip-'));
    const rootLibraryPath = join(tempRoot, 'High Seas');
    const stageRootPath = join(rootLibraryPath, '_STAGING');
    const extractPath = join(stageRootPath, 'MOUSE P.I. For Hire', 'contents');
    const releasePath = join(extractPath, 'MOUSE P.I. For Hire_1.0.3.8157');
    const gameFolderPath = join(releasePath, 'MOUSE P.I. For Hire');
    const finalPath = join(rootLibraryPath, 'MOUSE P.I. For Hire');

    try {
      await mkdir(join(releasePath, '_CommonRedist'), { recursive: true });
      await mkdir(gameFolderPath, { recursive: true });
      await writeFile(join(gameFolderPath, 'game.exe'), 'game');
      await writeFile(join(releasePath, 'Read_Me_Instructions.txt'), 'readme');
      await writeFile(join(releasePath, 'STEAMRIP.url'), 'url');

      await finalizeSteamRipExtraction({
        canonicalTitle: 'MOUSE P.I. For Hire',
        extractPath,
        finalPath,
        stageRootPath,
      });

      await expect(readFile(join(finalPath, 'game.exe'), 'utf8')).resolves.toBe(
        'game',
      );
      await expect(pathExists(join(finalPath, '_CommonRedist'))).resolves.toBe(
        false,
      );
      await expect(
        pathExists(join(finalPath, 'Read_Me_Instructions.txt')),
      ).resolves.toBe(false);
      await expect(
        pathExists(join(stageRootPath, 'MOUSE P.I. For Hire')),
      ).resolves.toBe(false);
    } finally {
      await rm(tempRoot, { force: true, recursive: true });
    }
  });

  it('promotes a version-suffixed SteamRIP game folder from a release wrapper', async () => {
    const tempRoot = await mkdtemp(
      join(tmpdir(), 'vaulttrack-steamrip-version-'),
    );
    const rootLibraryPath = join(tempRoot, 'High Seas');
    const stageRootPath = join(rootLibraryPath, '_STAGING');
    const extractPath = join(stageRootPath, 'Ziggurat 2', 'contents');
    const releasePath = join(extractPath, 'Ziggurat 2_7873732');
    const gameFolderPath = join(releasePath, 'Ziggurat 2 v15.12.2021');
    const finalPath = join(rootLibraryPath, 'Ziggurat 2');

    try {
      await mkdir(join(releasePath, '_CommonRedist'), { recursive: true });
      await mkdir(gameFolderPath, { recursive: true });
      await writeFile(join(gameFolderPath, 'Ziggurat2.exe'), 'game');
      await writeFile(join(releasePath, 'Read_Me_Instructions.txt'), 'readme');
      await writeFile(join(releasePath, 'STEAMRIP.url'), 'url');

      await finalizeSteamRipExtraction({
        canonicalTitle: 'Ziggurat 2',
        extractPath,
        finalPath,
        stageRootPath,
      });

      await expect(
        readFile(join(finalPath, 'Ziggurat2.exe'), 'utf8'),
      ).resolves.toBe('game');
      await expect(pathExists(join(finalPath, '_CommonRedist'))).resolves.toBe(
        false,
      );
      await expect(
        pathExists(join(finalPath, 'Read_Me_Instructions.txt')),
      ).resolves.toBe(false);
      await expect(pathExists(join(stageRootPath, 'Ziggurat 2'))).resolves.toBe(
        false,
      );
    } finally {
      await rm(tempRoot, { force: true, recursive: true });
    }
  });

  it('promotes the sole non-extra SteamRIP folder even when its name differs from the Steam title', async () => {
    const tempRoot = await mkdtemp(
      join(tmpdir(), 'vaulttrack-steamrip-arbitrary-'),
    );
    const rootLibraryPath = join(tempRoot, 'High Seas');
    const stageRootPath = join(rootLibraryPath, '_STAGING');
    const extractPath = join(stageRootPath, 'Ziggurat 2', 'contents');
    const releasePath = join(extractPath, 'Ziggurat 2_7873732');
    const gameFolderPath = join(releasePath, 'Actual Extracted Game Folder');
    const finalPath = join(rootLibraryPath, 'Ziggurat 2');

    try {
      await mkdir(join(releasePath, '_CommonRedist'), { recursive: true });
      await mkdir(gameFolderPath, { recursive: true });
      await writeFile(join(gameFolderPath, 'Ziggurat2.exe'), 'game');
      await writeFile(join(releasePath, 'Read_Me_Instructions.txt'), 'readme');
      await writeFile(join(releasePath, 'STEAMRIP.url'), 'url');

      await finalizeSteamRipExtraction({
        canonicalTitle: 'Ziggurat 2',
        extractPath,
        finalPath,
        stageRootPath,
      });

      await expect(
        readFile(join(finalPath, 'Ziggurat2.exe'), 'utf8'),
      ).resolves.toBe('game');
      await expect(pathExists(join(finalPath, '_CommonRedist'))).resolves.toBe(
        false,
      );
      await expect(pathExists(join(finalPath, 'STEAMRIP.url'))).resolves.toBe(
        false,
      );
      await expect(pathExists(join(stageRootPath, 'Ziggurat 2'))).resolves.toBe(
        false,
      );
    } finally {
      await rm(tempRoot, { force: true, recursive: true });
    }
  });
});

describe('scanImportFolders', () => {
  it('returns only top level directories', async () => {
    const entries = await scanImportFolders({
      listDirectoryNames: async () => ['Alpha', 'Beta'],
      rootLibraryPath: 'C:/Games',
    });

    expect(entries.map((entry) => entry.title)).toEqual(['Alpha', 'Beta']);
  });
});

describe('normalizeDuplicateNestedFolder', () => {
  it('moves duplicate extracted package folder contents up into the part folder', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'vaulttrack-nested-'));
    const partPath = join(
      tempRoot,
      'High Seas',
      '_STAGING',
      'Cult of the Lamb_21791439',
      'Cult of the Lamb_21791439_update',
    );
    const duplicatePath = join(partPath, 'Cult of the Lamb_21791439_update');

    try {
      await mkdir(join(duplicatePath, 'patch'), { recursive: true });
      await writeFile(join(duplicatePath, 'patch.exe'), 'patch');
      await writeFile(join(duplicatePath, 'patch', 'data.bin'), 'data');

      await expect(
        normalizeDuplicateNestedFolder({
          nestedFolderName: 'Cult of the Lamb_21791439_update',
          rootPath: partPath,
        }),
      ).resolves.toBe(true);

      await expect(readFile(join(partPath, 'patch.exe'), 'utf8')).resolves.toBe(
        'patch',
      );
      await expect(
        readFile(join(partPath, 'patch', 'data.bin'), 'utf8'),
      ).resolves.toBe('data');
      await expect(pathExists(duplicatePath)).resolves.toBe(false);
    } finally {
      await rm(tempRoot, { force: true, recursive: true });
    }
  });
});

describe('removeKnownLibraryPaths', () => {
  it('removes only guarded final and staging paths', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'vaulttrack-cleanup-'));
    const rootLibraryPath = join(tempRoot, 'High Seas');
    const finalPath = join(rootLibraryPath, 'MOUSE P.I. For Hire');
    const stagePath = join(
      rootLibraryPath,
      '_STAGING',
      'MOUSE P.I. For Hire_1.0.3.8157',
    );
    const fullStagePath = join(
      stagePath,
      'MOUSE P.I. For Hire_1.0.3.8157_full',
    );
    const updateStagePath = join(
      stagePath,
      'MOUSE P.I. For Hire_1.0.3.8157_update',
    );
    const steamRipWorkspace = join(
      rootLibraryPath,
      '_STAGING',
      'MOUSE P.I. For Hire',
    );

    try {
      await mkdir(finalPath, { recursive: true });
      await mkdir(stagePath, { recursive: true });
      await mkdir(fullStagePath, { recursive: true });
      await mkdir(updateStagePath, { recursive: true });
      await mkdir(steamRipWorkspace, { recursive: true });
      await writeFile(join(finalPath, 'game.exe'), 'game');
      await writeFile(join(stagePath, 'archive.rar'), 'archive');
      await writeFile(join(fullStagePath, 'full.rar'), 'archive');
      await writeFile(join(updateStagePath, 'update.rar'), 'archive');
      await writeFile(join(steamRipWorkspace, 'readme.txt'), 'readme');

      const deletedPaths = await removeKnownLibraryPaths({
        finalPath,
        rootLibraryPath,
        stagePath,
      });

      expect(deletedPaths).toHaveLength(5);
      await expect(pathExists(finalPath)).resolves.toBe(false);
      await expect(pathExists(stagePath)).resolves.toBe(false);
      await expect(pathExists(fullStagePath)).resolves.toBe(false);
      await expect(pathExists(updateStagePath)).resolves.toBe(false);
      await expect(pathExists(steamRipWorkspace)).resolves.toBe(false);
      await expect(pathExists(rootLibraryPath)).resolves.toBe(true);
    } finally {
      await rm(tempRoot, { force: true, recursive: true });
    }
  });

  it('refuses to delete the library root itself', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'vaulttrack-cleanup-root-'));
    const rootLibraryPath = join(tempRoot, 'High Seas');

    try {
      await mkdir(rootLibraryPath, { recursive: true });
      await expect(
        removeKnownLibraryPaths({
          finalPath: rootLibraryPath,
          rootLibraryPath,
        }),
      ).rejects.toThrow(/Refusing to operate outside/);
      await expect(pathExists(rootLibraryPath)).resolves.toBe(true);
    } finally {
      await rm(tempRoot, { force: true, recursive: true });
    }
  });
});
