import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  extractSingleStagedZipArchive,
  finalizePortableArchiveExtraction,
  finalizeSteamRipExtraction,
  hasPortableArchiveContentFolder,
  normalizeDuplicateNestedFolder,
  pathHasContent,
  pathExists,
  planLibraryPaths,
  planPortableArchiveExtractPathFromJob,
  planSteamRipExtractPathFromJob,
  removeKnownLibraryPaths,
  renameLibraryFolder,
  scanImportFolders,
} from '../src/main/services/files.js';

describe('pathHasContent', () => {
  it('requires directories to contain at least one entry', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'gamevault-content-'));
    try {
      const emptyFolder = join(tempRoot, 'Schedule I');
      const filledFolder = join(tempRoot, 'Hades');
      const filePath = join(tempRoot, 'readme.txt');
      await mkdir(emptyFolder, { recursive: true });
      await mkdir(filledFolder, { recursive: true });
      await writeFile(join(filledFolder, 'Hades.exe'), 'game');
      await writeFile(filePath, 'file');

      await expect(pathHasContent(emptyFolder)).resolves.toBe(false);
      await expect(pathHasContent(filledFolder)).resolves.toBe(true);
      await expect(pathHasContent(filePath)).resolves.toBe(true);
      await expect(pathHasContent(join(tempRoot, 'missing'))).resolves.toBe(
        false,
      );
    } finally {
      await rm(tempRoot, { force: true, recursive: true });
    }
  });
});

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

  it('extracts AnkerGames into the package staging folder', async () => {
    const plan = await planLibraryPaths({
      canonicalTitle: 'Shape of Dreams',
      rootLibraryPath: 'C:/Games',
      releaseSuffix: '22630308',
      sourceKind: 'ankergames',
    });

    expect(plan.stagePath).toBe(
      'C:\\Games\\_STAGING\\Shape of Dreams_22630308',
    );
    expect(plan.finalPath).toBe('C:\\Games\\Shape of Dreams');
    expect(plan.extractPath).toBe(
      'C:\\Games\\_STAGING\\Shape of Dreams_22630308',
    );
  });

  it('recreates SteamRIP extraction paths from persisted job paths', () => {
    expect(
      planSteamRipExtractPathFromJob({
        finalPath: 'C:/Games/Frostpunk 2',
        stagePath: 'C:/Games/_STAGING/Frostpunk 2_123456',
      }),
    ).toBe('C:\\Games\\_STAGING\\Frostpunk 2\\contents');
  });

  it('recreates AnkerGames extraction paths from persisted job paths', () => {
    expect(
      planPortableArchiveExtractPathFromJob({
        finalPath: 'C:/Games/Shape of Dreams',
        sourceKind: 'ankergames',
        stagePath: 'C:/Games/_STAGING/Shape of Dreams_22630308',
      }),
    ).toBe('C:\\Games\\_STAGING\\Shape of Dreams_22630308');
  });
});

describe('finalizeSteamRipExtraction', () => {
  it('promotes only the SteamRIP game folder and removes extracted extras', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'gamevault-steamrip-'));
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
      join(tmpdir(), 'gamevault-steamrip-version-'),
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
      join(tmpdir(), 'gamevault-steamrip-arbitrary-'),
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

  it('promotes the AnkerGames game folder and preserves its Run Me helper', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'gamevault-ankergames-'));
    const rootLibraryPath = join(tempRoot, 'High Seas');
    const stageRootPath = join(rootLibraryPath, '_STAGING');
    const extractPath = join(stageRootPath, 'Shape of Dreams_22630308');
    const gameFolderPath = join(extractPath, 'Shape of Dreams');
    const finalPath = join(rootLibraryPath, 'Shape of Dreams');

    try {
      await mkdir(gameFolderPath, { recursive: true });
      await writeFile(join(gameFolderPath, 'ShapeOfDreams.exe'), 'game');
      await writeFile(join(extractPath, 'Read Me.txt'), 'readme');
      await writeFile(
        join(extractPath, 'AnkerGames - Free Pre-installed PC Games.url'),
        'url',
      );
      await writeFile(join(extractPath, 'Run me!.bat'), 'bat');
      await writeFile(
        join(extractPath, 'Shape-Of-Dreams-AnkerGames.zip'),
        'zip',
      );

      await finalizePortableArchiveExtraction({
        canonicalTitle: 'Shape of Dreams',
        extractPath,
        finalPath,
        sourceKind: 'ankergames',
        stageRootPath,
      });

      await expect(
        readFile(join(finalPath, 'ShapeOfDreams.exe'), 'utf8'),
      ).resolves.toBe('game');
      await expect(pathExists(join(finalPath, 'Read Me.txt'))).resolves.toBe(
        false,
      );
      await expect(
        readFile(join(finalPath, 'Run me!.bat'), 'utf8'),
      ).resolves.toBe('bat');
      await expect(pathExists(extractPath)).resolves.toBe(false);
    } finally {
      await rm(tempRoot, { force: true, recursive: true });
    }
  });

  it('does not treat an empty AnkerGames game folder as extracted content', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'gamevault-empty-anker-'));
    const rootLibraryPath = join(tempRoot, 'High Seas');
    const stageRootPath = join(rootLibraryPath, '_STAGING');
    const extractPath = join(stageRootPath, 'Shape of Dreams_22630308');
    const gameFolderPath = join(extractPath, 'Shape of Dreams');
    const finalPath = join(rootLibraryPath, 'Shape of Dreams');

    try {
      await mkdir(gameFolderPath, { recursive: true });
      await writeFile(join(extractPath, 'Read Me.txt'), 'readme');
      await writeFile(join(extractPath, 'Run me!.bat'), 'bat');
      await writeFile(
        join(extractPath, 'Shape-Of-Dreams-AnkerGames.zip'),
        'zip',
      );

      await expect(
        hasPortableArchiveContentFolder({
          canonicalTitle: 'Shape of Dreams',
          extractPath,
          sourceKind: 'ankergames',
        }),
      ).resolves.toBe(false);
      await expect(
        finalizePortableArchiveExtraction({
          canonicalTitle: 'Shape of Dreams',
          extractPath,
          finalPath,
          sourceKind: 'ankergames',
          stageRootPath,
        }),
      ).rejects.toThrow(
        'Unable to find extracted AnkerGames game folder for Shape of Dreams.',
      );
      await expect(pathExists(finalPath)).resolves.toBe(false);
      await expect(pathExists(extractPath)).resolves.toBe(true);
    } finally {
      await rm(tempRoot, { force: true, recursive: true });
    }
  });

  it('replaces an existing non-empty install folder after staged extraction is valid', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'gamevault-existing-'));
    const rootLibraryPath = join(tempRoot, 'High Seas');
    const stageRootPath = join(rootLibraryPath, '_STAGING');
    const extractPath = join(stageRootPath, 'Shape of Dreams_22630308');
    const gameFolderPath = join(extractPath, 'Shape of Dreams');
    const finalPath = join(rootLibraryPath, 'Shape of Dreams');

    try {
      await mkdir(gameFolderPath, { recursive: true });
      await writeFile(join(gameFolderPath, 'ShapeOfDreams.exe'), 'game');
      await mkdir(finalPath, { recursive: true });
      await writeFile(join(finalPath, 'existing.txt'), 'keep');

      await finalizePortableArchiveExtraction({
        canonicalTitle: 'Shape of Dreams',
        extractPath,
        finalPath,
        sourceKind: 'ankergames',
        stageRootPath,
      });
      await expect(
        readFile(join(finalPath, 'ShapeOfDreams.exe'), 'utf8'),
      ).resolves.toBe('game');
      await expect(pathExists(join(finalPath, 'existing.txt'))).resolves.toBe(
        false,
      );
      await expect(pathExists(extractPath)).resolves.toBe(false);
    } finally {
      await rm(tempRoot, { force: true, recursive: true });
    }
  });
});

describe('extractSingleStagedZipArchive', () => {
  it('extracts the only top-level staged zip into the staging folder', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'gamevault-zip-'));
    try {
      const extractPath = join(tempRoot, 'Shape of Dreams_22630308');
      await mkdir(extractPath, { recursive: true });
      const zipPath = join(extractPath, 'Shape-Of-Dreams-AnkerGames.zip');
      await writeFile(zipPath, 'zip');
      const runExtract = vi.fn(
        async (_zipPath: string, destination: string) => {
          await mkdir(join(destination, 'Shape of Dreams'), {
            recursive: true,
          });
          await writeFile(
            join(destination, 'Shape of Dreams', 'ShapeOfDreams.exe'),
            'game',
          );
        },
      );

      await expect(
        extractSingleStagedZipArchive({ extractPath, runExtract }),
      ).resolves.toBe(zipPath);
      expect(runExtract).toHaveBeenCalledWith(zipPath, extractPath);
      await expect(
        readFile(
          join(extractPath, 'Shape of Dreams', 'ShapeOfDreams.exe'),
          'utf8',
        ),
      ).resolves.toBe('game');
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
    const tempRoot = await mkdtemp(join(tmpdir(), 'gamevault-nested-'));
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
    const tempRoot = await mkdtemp(join(tmpdir(), 'gamevault-cleanup-'));
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
    const tempRoot = await mkdtemp(join(tmpdir(), 'gamevault-cleanup-root-'));
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

describe('renameLibraryFolder', () => {
  const itWindows = process.platform === 'win32' ? it : it.skip;

  itWindows('treats case-only target differences as an existing folder no-op', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'gamevault-rename-case-'));
    const rootLibraryPath = join(tempRoot, 'High Seas');
    const currentPath = join(rootLibraryPath, 'A Little To The Left');
    const targetPath = join(rootLibraryPath, 'A Little to the Left');

    try {
      await mkdir(currentPath, { recursive: true });
      await writeFile(join(currentPath, 'game.exe'), 'game');

      await expect(
        renameLibraryFolder({
          currentPath,
          rootLibraryPath,
          targetPath,
        }),
      ).resolves.toBe(targetPath);
      await expect(readFile(join(currentPath, 'game.exe'), 'utf8')).resolves.toBe(
        'game',
      );
    } finally {
      await rm(tempRoot, { force: true, recursive: true });
    }
  });
});
