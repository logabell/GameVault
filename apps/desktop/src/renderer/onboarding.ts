import { FIREFOX_EXTENSION_ID } from '@gamevault/shared-types';
import type {
  BrowserTarget,
  ConnectionHealthSummary,
  DesktopHealthSummary,
  HealthColor,
  JDownloaderInstallStatus,
  SettingsView,
} from '@gamevault/shared-types';

export type DesktopOnboardingStep =
  | 'jdownloader'
  | 'myjdownloader'
  | 'extension';

type EmptyLibraryState = 'items' | 'no-results' | 'start';

export function shouldShowFirstLaunchOnboarding(
  settings: Pick<SettingsView, 'onboarding'>,
  itemCount: number,
): boolean {
  if (settings.onboarding?.completedAt || settings.onboarding?.skippedAt) {
    return false;
  }
  return itemCount === 0;
}

export function canConfirmJDownloaderStep(
  status: JDownloaderInstallStatus | null,
): boolean {
  return Boolean(status?.detected);
}

export function canConfirmMyJDownloaderStep(
  health: ConnectionHealthSummary | null,
): boolean {
  return health?.myJDownloader.color === 'green';
}

export function getWorstHealthColor(
  colors: Array<HealthColor | null | undefined>,
): HealthColor {
  if (colors.includes('red')) {
    return 'red';
  }
  if (colors.includes('yellow')) {
    return 'yellow';
  }
  return 'green';
}

export function getDesktopHealthMenuTitle(
  health: DesktopHealthSummary | null,
): string {
  return health
    ? `Health: ${health.overall.label}`
    : 'Health status unavailable';
}

export function isValidExtensionSetupId(
  extensionId: string,
  browser: BrowserTarget = 'chrome',
): boolean {
  const trimmed = extensionId.trim();
  if (browser === 'firefox') {
    return trimmed === FIREFOX_EXTENSION_ID;
  }
  return /^[a-p]{32}$/.test(trimmed);
}

export function getEmptyLibraryState(
  itemCount: number,
  visibleItemCount: number,
): EmptyLibraryState {
  if (itemCount === 0) {
    return 'start';
  }
  return visibleItemCount === 0 ? 'no-results' : 'items';
}
