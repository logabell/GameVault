import { describe, expect, it } from 'vitest';
import { FIREFOX_EXTENSION_ID } from '@gamevault/shared-types';

import {
  canConfirmJDownloaderStep,
  canConfirmMyJDownloaderStep,
  getDesktopHealthMenuTitle,
  getEmptyLibraryState,
  getWorstHealthColor,
  isValidExtensionSetupId,
  shouldShowFirstLaunchOnboarding,
} from '../src/renderer/onboarding.js';

describe('desktop onboarding helpers', () => {
  it('shows first-launch onboarding only for empty libraries without prior state', () => {
    expect(shouldShowFirstLaunchOnboarding({}, 0)).toBe(true);
    expect(shouldShowFirstLaunchOnboarding({}, 1)).toBe(false);
    expect(
      shouldShowFirstLaunchOnboarding(
        { onboarding: { skippedAt: '2026-04-24T12:00:00.000Z' } },
        0,
      ),
    ).toBe(false);
    expect(
      shouldShowFirstLaunchOnboarding(
        { onboarding: { completedAt: '2026-04-24T12:00:00.000Z' } },
        0,
      ),
    ).toBe(false);
  });

  it('gates step confirmation from detected status and health', () => {
    expect(
      canConfirmJDownloaderStep({
        checkedAt: '2026-04-24T12:00:00.000Z',
        detected: true,
        installPath: null,
        installed: false,
        message: 'running',
        running: true,
        source: 'process',
      }),
    ).toBe(true);
    expect(canConfirmJDownloaderStep(null)).toBe(false);
    expect(
      canConfirmMyJDownloaderStep({
        desktop: { color: 'green', label: 'Ready', message: 'Ready' },
        devices: [],
        myJDownloader: { color: 'green', label: 'Ready', message: 'Ready' },
      }),
    ).toBe(true);
  });

  it('validates extension IDs and empty library states', () => {
    expect(isValidExtensionSetupId('abcdefghijklmnopabcdefghijklmnop')).toBe(
      true,
    );
    expect(isValidExtensionSetupId('abcdefghijklmnopabcdefghijklmnoq')).toBe(
      false,
    );
    expect(isValidExtensionSetupId(FIREFOX_EXTENSION_ID, 'firefox')).toBe(true);
    expect(isValidExtensionSetupId('not-firefox', 'firefox')).toBe(false);
    expect(getEmptyLibraryState(0, 0)).toBe('start');
    expect(getEmptyLibraryState(2, 0)).toBe('no-results');
    expect(getEmptyLibraryState(2, 1)).toBe('items');
  });

  it('resolves navbar health color and label helpers', () => {
    expect(getWorstHealthColor(['green', 'yellow'])).toBe('yellow');
    expect(getWorstHealthColor(['green', 'red', 'yellow'])).toBe('red');
    expect(getWorstHealthColor([null, undefined, 'green'])).toBe('green');
    expect(getDesktopHealthMenuTitle(null)).toBe('Health status unavailable');
    expect(
      getDesktopHealthMenuTitle({
        extension: {
          color: 'green',
          label: 'Extension connected',
          message: 'Ready',
        },
        jDownloader: { color: 'green', label: 'Ready', message: 'Ready' },
        overall: { color: 'green', label: 'Healthy', message: 'Ready' },
      }),
    ).toBe('Health: Healthy');
  });
});
