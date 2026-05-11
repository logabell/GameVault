import { describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  assertSafePlaynitePluginInstallTarget,
  buildPlayniteManifest,
  getPlayniteExecutableExclusionReason,
  scanPlayniteExecutableSelection,
} from '../src/main/services/playnite.js';
import type {
  PlayniteExecutableSelectionRecord,
  TrackedItemView,
} from '@gamevault/shared-types';
import { TrackedItemStatus, TrackedItemTrackingStatus } from '@gamevault/shared-types';

async function makeTempInstall(name: string): Promise<string> {
  const tempRoot = await mkdtemp(join(tmpdir(), 'gamevault-playnite-'));
  const installPath = join(tempRoot, name);
  await mkdir(installPath, { recursive: true });
  return installPath;
}

async function touch(path: string, size = 128 * 1024): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, Buffer.alloc(size, 0));
}

async function writeText(path: string, value: string): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, value);
}

async function cleanupInstall(installPath: string): Promise<void> {
  await rm(join(installPath, '..'), { force: true, recursive: true });
}

describe('Playnite executable selection', () => {
  it('prefers Unity root executable over crash handler', async () => {
    const installPath = await makeTempInstall('A Little to the Left');
    try {
      await touch(join(installPath, 'UnityCrashHandler64.exe'), 2 * 1024 * 1024);
      await touch(join(installPath, 'A Little To The Left.exe'), 600 * 1024);
      await mkdir(join(installPath, 'A Little To The Left_Data'));

      const selection = await scanPlayniteExecutableSelection({
        installPath,
        steamAppId: 1629520,
        steamTitle: 'A Little to the Left',
        title: 'A Little to the Left',
        trackedItemId: 'item-1',
      });

      expect(selection.status).toBe('auto_selected');
      expect(selection.confidence).toBe('high');
      expect(selection.selectedExePath).toBe(
        join(installPath, 'A Little To The Left.exe'),
      );
    } finally {
      await cleanupInstall(installPath);
    }
  });

  it('prefers Unreal Win64 shipping executable even when it is tiny', async () => {
    const installPath = await makeTempInstall('Satisfactory');
    try {
      await touch(
        join(installPath, 'Engine', 'Extras', 'Redist', 'en-us', 'UEPrereqSetup_x64.exe'),
        48 * 1024 * 1024,
      );
      await touch(
        join(installPath, 'Engine', 'Binaries', 'Win64', 'CrashReportClient.exe'),
        24 * 1024 * 1024,
      );
      await touch(
        join(
          installPath,
          'Engine',
          'Binaries',
          'Win64',
          'FactoryGameSteam-Win64-Shipping.exe',
        ),
        280 * 1024,
      );

      const selection = await scanPlayniteExecutableSelection({
        installPath,
        steamAppId: 526870,
        steamTitle: 'Satisfactory',
        title: 'Satisfactory',
        trackedItemId: 'item-1',
      });

      expect(selection.selectedExePath).toBe(
        join(
          installPath,
          'Engine',
          'Binaries',
          'Win64',
          'FactoryGameSteam-Win64-Shipping.exe',
        ),
      );
    } finally {
      await cleanupInstall(installPath);
    }
  });

  it('penalizes friend, trial, and dev variants', async () => {
    const installPath = await makeTempInstall('A Way Out');
    try {
      await touch(join(installPath, 'Haze1', 'Binaries', 'Win64', 'AWayOut_friend.exe'), 260 * 1024 * 1024);
      await touch(join(installPath, 'Haze1', 'Binaries', 'Win64', 'AWayOut.exe'), 230 * 1024 * 1024);

      const selection = await scanPlayniteExecutableSelection({
        installPath,
        steamAppId: 1222700,
        steamTitle: 'A Way Out',
        title: 'A Way Out',
        trackedItemId: 'item-1',
      });

      expect(selection.selectedExePath).toBe(
        join(installPath, 'Haze1', 'Binaries', 'Win64', 'AWayOut.exe'),
      );
    } finally {
      await cleanupInstall(installPath);
    }
  });

  it('prefers the standard 64-bit Hades executable over Vulkan and x86 variants', async () => {
    const installPath = await makeTempInstall('Hades');
    try {
      await touch(join(installPath, 'x64Vk', 'Hades.exe'), 470 * 1024);
      await writeText(
        join(installPath, 'x64Vk', 'steam_settings', 'steam_appid.txt'),
        '1145360',
      );
      await touch(join(installPath, 'x64', 'Hades.exe'), 470 * 1024);
      await writeText(
        join(installPath, 'x64', 'steam_settings', 'steam_appid.txt'),
        '1145360',
      );
      await touch(join(installPath, 'x86', 'Hades.exe'), 450 * 1024);
      await writeText(
        join(installPath, 'x86', 'steam_settings', 'steam_appid.txt'),
        '1145360',
      );

      const selection = await scanPlayniteExecutableSelection({
        installPath,
        steamAppId: 1145360,
        steamTitle: 'Hades',
        title: 'Hades',
        trackedItemId: 'item-1',
      });

      expect(selection.selectedExePath).toBe(join(installPath, 'x64', 'Hades.exe'));
    } finally {
      await cleanupInstall(installPath);
    }
  });

  it('recognizes common title acronyms with roman numeral suffixes', async () => {
    const installPath = await makeTempInstall('The Last of Us Part II Remastered');
    try {
      await touch(join(installPath, 'launcher.exe'), 2 * 1024 * 1024);
      await touch(join(installPath, 'tlou-ii-l.exe'), 60 * 1024 * 1024);
      await touch(join(installPath, 'tlou-ii.exe'), 60 * 1024 * 1024);

      const selection = await scanPlayniteExecutableSelection({
        installPath,
        steamAppId: 2531310,
        steamTitle: 'The Last of Us Part II Remastered',
        title: 'The Last of Us Part II Remastered',
        trackedItemId: 'item-1',
      });

      expect(selection.status).toBe('auto_selected');
      expect(selection.confidence).toBe('high');
      expect(selection.selectedExePath).toBe(join(installPath, 'tlou-ii.exe'));
    } finally {
      await cleanupInstall(installPath);
    }
  });

  it('auto-selects one positive candidate when only zero-score utilities remain', async () => {
    const installPath = await makeTempInstall('theHunter Call of the Wild');
    try {
      await touch(join(installPath, 'theHunterCotW_F.exe'), 37 * 1024 * 1024);
      await touch(
        join(installPath, '_CommonRedist', 'DirectX', 'dxwebsetup.exe'),
        285 * 1024,
      );
      await touch(
        join(
          installPath,
          '_CommonRedist',
          'vcredist',
          '2019',
          'VC_redist.x64.exe',
        ),
        14 * 1024 * 1024,
      );
      await touch(join(installPath, 'CrashDialog.exe'), 166 * 1024);

      const selection = await scanPlayniteExecutableSelection({
        installPath,
        steamAppId: 518790,
        steamTitle: 'theHunter: Call of the Wild™',
        title: 'theHunter: Call of the Wild™',
        trackedItemId: 'item-1',
      });

      expect(selection.status).toBe('auto_selected');
      expect(selection.confidence).toBe('high');
      expect(selection.selectedExePath).toBe(
        join(installPath, 'theHunterCotW_F.exe'),
      );
    } finally {
      await cleanupInstall(installPath);
    }
  });

  it('auto-selects Elden Ring over bonus apps and anti-cheat launchers', async () => {
    const installPath = await makeTempInstall('ELDEN RING');
    const guidePath = join(
      installPath,
      'AdvGuide',
      'ELDEN RING Adventure Guide.exe',
    );
    const artbookPath = join(
      installPath,
      'ArtbookOST',
      'ELDEN RING Digital Artbook & Soundtrack.exe',
    );
    const gamePath = join(installPath, 'Game', 'eldenring.exe');
    try {
      await touch(guidePath, 639 * 1024);
      await mkdir(
        join(installPath, 'AdvGuide', 'ELDEN RING Adventure Guide_Data'),
      );
      await touch(artbookPath, 639 * 1024);
      await mkdir(
        join(
          installPath,
          'ArtbookOST',
          'ELDEN RING Digital Artbook & Soundtrack_Data',
        ),
      );
      await touch(
        join(installPath, 'Game', 'EasyAntiCheat', 'easyanticheat_eos_setup.exe'),
        938 * 1024,
      );
      await touch(join(installPath, 'Game', 'start_protected_game.exe'), 4 * 1024 * 1024);
      await touch(gamePath, 83 * 1024 * 1024);

      const selection = await scanPlayniteExecutableSelection({
        installPath,
        previousSelection: {
          candidates: [],
          confidence: 'high',
          reviewedAt: '2026-05-10T12:00:00.000Z',
          selectedExePath: guidePath,
          status: 'reviewed',
          steamAppId: 1245620,
          trackedItemId: 'item-1',
          updatedAt: '2026-05-10T12:00:00.000Z',
        },
        steamAppId: 1245620,
        steamTitle: 'ELDEN RING',
        title: 'ELDEN RING',
        trackedItemId: 'item-1',
      });

      const reviewable = selection.candidates.filter(
        (candidate) => !candidate.excluded && candidate.score > 0,
      );

      expect(selection.status).toBe('auto_selected');
      expect(selection.confidence).toBe('high');
      expect(selection.selectedExePath).toBe(gamePath);
      expect(reviewable.map((candidate) => candidate.fileName)).toEqual([
        'eldenring.exe',
      ]);
      expect(
        selection.candidates.find(
          (candidate) => candidate.fullPath === guidePath,
        )?.excluded,
      ).toBe(true);
      expect(
        selection.candidates.find(
          (candidate) => candidate.fullPath === artbookPath,
        )?.excluded,
      ).toBe(true);
    } finally {
      await cleanupInstall(installPath);
    }
  });

  it('auto-selects 64-bit sibling executable folders over root launchers', async () => {
    const installPath = await makeTempInstall('Crypt of the NecroDancer');
    const selectedPath = join(
      installPath,
      'Necrodancer64',
      'Necrodancer.exe',
    );
    try {
      await touch(join(installPath, 'NecroDancer.exe'), 4.6 * 1024 * 1024);
      await touch(join(installPath, 'Necrodancer', 'Necrodancer.exe'), 10 * 1024 * 1024);
      await touch(selectedPath, 12 * 1024 * 1024);
      await writeText(
        join(installPath, 'Necrodancer64', 'steam_appid.txt'),
        '247080',
      );
      await touch(join(installPath, 'Necrodancer64', 'BsSndRpt64.exe'), 490 * 1024);
      await touch(join(installPath, 'Necrodancer', 'BsSndRpt.exe'), 390 * 1024);
      await touch(join(installPath, 'data', 'custom_music', 'beatdown.exe'), 72 * 1024);
      await touch(join(installPath, 'data', 'essentia', 'beattracker.exe'), 7 * 1024 * 1024);

      const selection = await scanPlayniteExecutableSelection({
        installPath,
        steamAppId: 247080,
        steamTitle: 'Crypt of the NecroDancer',
        title: 'Crypt of the NecroDancer',
        trackedItemId: 'item-1',
      });

      const reviewable = selection.candidates.filter(
        (candidate) => !candidate.excluded && candidate.score > 0,
      );

      expect(selection.status).toBe('auto_selected');
      expect(selection.selectedExePath).toBe(selectedPath);
      expect(reviewable.map((candidate) => candidate.relativePath)).toEqual([
        join('Necrodancer64', 'Necrodancer.exe'),
        'NecroDancer.exe',
        join('Necrodancer', 'Necrodancer.exe'),
      ]);
      expect(
        selection.candidates.find((candidate) =>
          candidate.relativePath.endsWith('BsSndRpt64.exe'),
        )?.excluded,
      ).toBe(true);
      expect(
        selection.candidates.find((candidate) =>
          candidate.relativePath.endsWith('beattracker.exe'),
        )?.excluded,
      ).toBe(true);
    } finally {
      await cleanupInstall(installPath);
    }
  });

  it('auto-selects base executable over renderer-suffixed alternatives', async () => {
    const installPath = await makeTempInstall("Baldur's Gate 3");
    const selectedPath = join(installPath, 'bin', 'bg3.exe');
    const dx11Path = join(installPath, 'bin', 'bg3_dx11.exe');
    try {
      await touch(selectedPath, 102 * 1024 * 1024);
      await touch(dx11Path, 99 * 1024 * 1024);
      await writeText(join(installPath, 'bin', 'steam_appid.txt'), '1086940');
      await touch(
        join(installPath, 'Launcher', 'DriverVersionChecker.exe'),
        27 * 1024,
      );
      await touch(join(installPath, 'Launcher', 'LayersChecker.exe'), 26 * 1024);

      const selection = await scanPlayniteExecutableSelection({
        installPath,
        previousSelection: {
          candidates: [],
          confidence: 'low',
          reviewedAt: '2026-05-10T12:00:00.000Z',
          selectedExePath: dx11Path,
          status: 'reviewed',
          steamAppId: 1086940,
          trackedItemId: 'item-1',
          updatedAt: '2026-05-10T12:00:00.000Z',
        },
        steamAppId: 1086940,
        steamTitle: "Baldur's Gate 3",
        title: "Baldur's Gate 3",
        trackedItemId: 'item-1',
      });

      const reviewable = selection.candidates.filter(
        (candidate) => !candidate.excluded && candidate.score > 0,
      );

      expect(selection.status).toBe('auto_selected');
      expect(selection.confidence).toBe('high');
      expect(selection.selectedExePath).toBe(selectedPath);
      expect(reviewable.map((candidate) => candidate.relativePath)).toEqual([
        join('bin', 'bg3.exe'),
      ]);
      expect(
        selection.candidates.find((candidate) => candidate.fullPath === dx11Path)
          ?.excluded,
      ).toBe(true);
    } finally {
      await cleanupInstall(installPath);
    }
  });

  it('marks a game missing when only a renderer variant remains', async () => {
    const installPath = await makeTempInstall("Baldur's Gate 3");
    const dx11Path = join(installPath, 'bin', 'bg3_dx11.exe');
    try {
      await touch(dx11Path, 99 * 1024 * 1024);
      await writeText(join(installPath, 'bin', 'steam_appid.txt'), '1086940');
      await touch(
        join(installPath, 'Launcher', 'DriverVersionChecker.exe'),
        27 * 1024,
      );

      const selection = await scanPlayniteExecutableSelection({
        installPath,
        steamAppId: 1086940,
        steamTitle: "Baldur's Gate 3",
        title: "Baldur's Gate 3",
        trackedItemId: 'item-1',
      });

      expect(selection.status).toBe('missing');
      expect(selection.confidence).toBe('none');
      expect(selection.selectedExePath).toBeNull();
      expect(
        selection.candidates.find((candidate) => candidate.fullPath === dx11Path)
          ?.excluded,
      ).toBe(true);
      expect(
        selection.candidates.filter(
          (candidate) => !candidate.excluded && candidate.score > 0,
        ),
      ).toEqual([]);
    } finally {
      await cleanupInstall(installPath);
    }
  });

  it('does not use leftover helper executables as launch targets', async () => {
    const installPath = await makeTempInstall('A Way Out');
    try {
      await touch(
        join(installPath, 'Haze1', 'Binaries', 'Win64', 'AWayOut_friend.exe'),
        260 * 1024 * 1024,
      );
      await touch(join(installPath, 'editor.exe'), 2 * 1024 * 1024);
      await touch(
        join(installPath, 'bin', 'x64', 'REDEngineErrorReporter.exe'),
        8 * 1024 * 1024,
      );
      await touch(
        join(installPath, 'Engine', 'Binaries', 'Win64', 'UnrealCEFSubProcess.exe'),
        300 * 1024,
      );
      await touch(
        join(installPath, 'Sources', 'Bin', 'SnowrunnerResourceConverter.exe'),
        3 * 1024 * 1024,
      );
      await touch(join(installPath, 'noita_dev.exe'), 20 * 1024 * 1024);

      const selection = await scanPlayniteExecutableSelection({
        installPath,
        steamAppId: 1222700,
        steamTitle: 'A Way Out',
        title: 'A Way Out',
        trackedItemId: 'item-1',
      });

      expect(selection.status).toBe('missing');
      expect(selection.confidence).toBe('none');
      expect(selection.selectedExePath).toBeNull();
      expect(selection.candidates.every((candidate) => candidate.excluded)).toBe(
        true,
      );
    } finally {
      await cleanupInstall(installPath);
    }
  });

  it('classifies cached helper launch paths as excluded', () => {
    expect(
      getPlayniteExecutableExclusionReason(
        "D:\\High Seas\\Baldur's Gate 3\\bin\\bg3_dx11.exe",
        "D:\\High Seas\\Baldur's Gate 3",
      ),
    ).toBe('Alternate renderer variant');
    expect(
      getPlayniteExecutableExclusionReason(
        'D:\\High Seas\\Cyberpunk 2077\\bin\\x64\\REDEngineErrorReporter.exe',
        'D:\\High Seas\\Cyberpunk 2077',
      ),
    ).toBe('Crash/error reporting helper');
    expect(
      getPlayniteExecutableExclusionReason(
        'D:\\High Seas\\Barony\\editor.exe',
        'D:\\High Seas\\Barony',
      ),
    ).toBe('Editor executable');
    expect(
      getPlayniteExecutableExclusionReason(
        'D:\\High Seas\\Project Zomboid\\jre\\bin\\keytool.exe',
        'D:\\High Seas\\Project Zomboid',
      ),
    ).toBe('Java runtime tool');
  });

  it('refuses Playnite plugin install targets inside game libraries', () => {
    expect(() =>
      assertSafePlaynitePluginInstallTarget({
        extensionsPath: 'D:\\High Seas',
        pluginInstallPath: 'D:\\High Seas\\GameVault',
        protectedPaths: ['D:\\High Seas'],
      }),
    ).toThrow(/cannot be inside a GameVault library/i);
    expect(() =>
      assertSafePlaynitePluginInstallTarget({
        extensionsPath: 'D:\\High Seas\\Barony',
        pluginInstallPath: 'D:\\High Seas\\Barony\\GameVault',
        protectedPaths: ['D:\\High Seas\\Barony'],
      }),
    ).toThrow(/cannot be inside a GameVault library/i);
    expect(() =>
      assertSafePlaynitePluginInstallTarget({
        extensionsPath: 'C:\\Users\\Logan\\AppData\\Roaming\\Playnite\\Extensions',
        pluginInstallPath:
          'C:\\Users\\Logan\\AppData\\Roaming\\Playnite\\Extensions\\GameVault',
        protectedPaths: ['D:\\High Seas'],
      }),
    ).not.toThrow();
  });
});

describe('Playnite manifest', () => {
  it('exports only games with resolved launch executables', () => {
    const selection: PlayniteExecutableSelectionRecord = {
      candidates: [],
      confidence: 'high',
      reviewedAt: null,
      selectedExePath: 'D:\\High Seas\\Barony\\barony.exe',
      status: 'auto_selected',
      steamAppId: 371970,
      trackedItemId: 'item-1',
      updatedAt: '2026-05-10T12:00:00.000Z',
    };
    const unresolved: PlayniteExecutableSelectionRecord = {
      ...selection,
      selectedExePath: null,
      status: 'needs_review',
      trackedItemId: 'item-2',
    };
    const view = (id: string, appId: number): TrackedItemView =>
      ({
        activity: {},
        currentDownload: null,
        currentWatch: null,
        downloadMirrors: [],
        fileState: {
          finalPath: `D:\\High Seas\\${id}`,
          finalPathExists: true,
        },
        installRecord: {
          installPath: `D:\\High Seas\\${id}`,
          trackedItemId: id,
          updatedAt: '2026-05-10T12:00:00.000Z',
        },
        item: {
          createdAt: '2026-05-10T12:00:00.000Z',
          id,
          normalizedTitle: id,
          steamAppId: appId,
          title: id,
          updatedAt: '2026-05-10T12:00:00.000Z',
        },
        patchMetadataStatus: 'unknown',
        selectedMirror: null,
        sourceMatches: [],
        status: TrackedItemStatus.Installed,
        trackingStatus: TrackedItemTrackingStatus.UpToDate,
      }) as TrackedItemView;

    const manifest = buildPlayniteManifest(
      [view('item-1', 371970), view('item-2', 123)],
      [selection, unresolved],
    );

    expect(manifest.games).toEqual([
      expect.objectContaining({
        executablePath: 'D:\\High Seas\\Barony\\barony.exe',
        source: 'GameVault',
        steamAppId: 371970,
      }),
    ]);
  });
});
