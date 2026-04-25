import { readdir, readFile } from 'node:fs/promises';
import { join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

import type {
  BrowserExtensionInstall,
  BrowserExtensionInstallStatus,
  BrowserTarget,
} from '@gamevault/shared-types';
import { FIREFOX_EXTENSION_ID } from '@gamevault/shared-types';

interface DirectoryEntry {
  isDirectory(): boolean;
  name: string;
}

export interface BrowserExtensionDetectionOptions {
  env?: NodeJS.ProcessEnv;
  extensionPath?: string | null;
  firefoxExtensionId?: string;
  manifestName?: string;
  now?: () => Date;
  readDirectory?: (path: string) => Promise<DirectoryEntry[]>;
  readTextFile?: (path: string) => Promise<string>;
}

const DEFAULT_MANIFEST_NAME = 'GameVault';
const BROWSER_LABELS: Record<BrowserTarget, string> = {
  chrome: 'Chrome',
  edge: 'Edge',
  firefox: 'Firefox',
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function normalizeManifestName(value: string): string {
  return value.trim().toLowerCase();
}

function normalizePathForCompare(value: string): string {
  return normalize(value)
    .replace(/[\\/]+$/g, '')
    .toLowerCase();
}

function knownChromiumUserDataRoots(
  env: NodeJS.ProcessEnv,
): Array<{ browser: 'chrome' | 'edge'; userDataPath: string }> {
  const localAppData =
    env.LOCALAPPDATA ??
    (env.USERPROFILE ? join(env.USERPROFILE, 'AppData', 'Local') : null);
  if (!localAppData?.trim()) {
    return [];
  }

  return [
    {
      browser: 'chrome',
      userDataPath: join(localAppData, 'Google', 'Chrome', 'User Data'),
    },
    {
      browser: 'edge',
      userDataPath: join(localAppData, 'Microsoft', 'Edge', 'User Data'),
    },
  ];
}

async function listProfilePreferenceFiles(params: {
  browser: 'chrome' | 'edge';
  readDirectory: (path: string) => Promise<DirectoryEntry[]>;
  userDataPath: string;
}): Promise<
  Array<{
    browser: 'chrome' | 'edge';
    preferencesPath: string;
    profileName: string;
  }>
> {
  let entries: DirectoryEntry[];
  try {
    entries = await params.readDirectory(params.userDataPath);
  } catch {
    return [];
  }

  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({
      browser: params.browser,
      preferencesPath: join(params.userDataPath, entry.name, 'Preferences'),
      profileName: entry.name,
    }));
}

function knownFirefoxProfilesRoot(env: NodeJS.ProcessEnv): string | null {
  const appData =
    env.APPDATA ??
    (env.USERPROFILE ? join(env.USERPROFILE, 'AppData', 'Roaming') : null);
  return appData?.trim()
    ? join(appData, 'Mozilla', 'Firefox', 'Profiles')
    : null;
}

async function listFirefoxExtensionFiles(params: {
  profilesRoot: string | null;
  readDirectory: (path: string) => Promise<DirectoryEntry[]>;
}): Promise<
  Array<{
    browser: 'firefox';
    extensionsPath: string;
    profileName: string;
  }>
> {
  if (!params.profilesRoot) {
    return [];
  }

  let entries: DirectoryEntry[];
  try {
    entries = await params.readDirectory(params.profilesRoot);
  } catch {
    return [];
  }

  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({
      browser: 'firefox' as const,
      extensionsPath: join(params.profilesRoot!, entry.name, 'extensions.json'),
      profileName: entry.name,
    }));
}

function getExtensionSettings(preferences: unknown): Record<string, unknown> {
  if (!isRecord(preferences)) {
    return {};
  }
  const extensions = preferences.extensions;
  if (!isRecord(extensions)) {
    return {};
  }
  const settings = extensions.settings;
  return isRecord(settings) ? settings : {};
}

function parseInstallationsFromPreferences(params: {
  browser: 'chrome' | 'edge';
  expectedExtensionPath: string | null;
  preferences: unknown;
  preferencesPath: string;
  profileName: string;
  targetManifestName: string;
}): BrowserExtensionInstall[] {
  const settings = getExtensionSettings(params.preferences);
  const installations: BrowserExtensionInstall[] = [];

  for (const [extensionId, rawSetting] of Object.entries(settings)) {
    if (!/^[a-p]{32}$/.test(extensionId) || !isRecord(rawSetting)) {
      continue;
    }

    const installPath =
      typeof rawSetting.path === 'string' ? rawSetting.path : null;
    const manifest = isRecord(rawSetting.manifest) ? rawSetting.manifest : null;
    const manifestName =
      manifest && typeof manifest.name === 'string' ? manifest.name : null;
    const state =
      typeof rawSetting.state === 'number' ? rawSetting.state : null;
    const pathMatches =
      Boolean(params.expectedExtensionPath) &&
      Boolean(installPath) &&
      normalizePathForCompare(installPath!) === params.expectedExtensionPath;
    const manifestNameMatches =
      Boolean(manifestName) &&
      normalizeManifestName(manifestName!) === params.targetManifestName;

    if (!pathMatches && !manifestNameMatches) {
      continue;
    }

    installations.push({
      browser: params.browser,
      enabled: state !== 0,
      extensionId,
      installPath,
      manifestName,
      preferencesPath: params.preferencesPath,
      profileName: params.profileName,
      state,
    });
  }

  return installations;
}

function getFirefoxAddons(extensionsJson: unknown): unknown[] {
  if (!isRecord(extensionsJson)) {
    return [];
  }
  return Array.isArray(extensionsJson.addons) ? extensionsJson.addons : [];
}

function filePathFromFirefoxUri(value: string | null): string | null {
  if (!value) {
    return null;
  }
  const unwrapped = value.startsWith('jar:')
    ? value.replace(/^jar:/, '').split('!/')[0]!
    : value;
  if (!unwrapped.startsWith('file:')) {
    return null;
  }
  try {
    return normalize(fileURLToPath(unwrapped));
  } catch {
    return null;
  }
}

function getFirefoxInstallPath(addon: Record<string, unknown>): string | null {
  for (const key of ['path', 'rootURI', 'sourceURI']) {
    const value = addon[key];
    if (typeof value !== 'string') {
      continue;
    }
    if (/^file:|^jar:file:/i.test(value)) {
      const filePath = filePathFromFirefoxUri(value);
      if (filePath) {
        return filePath;
      }
      continue;
    }
    return value;
  }
  return null;
}

function getFirefoxManifestName(addon: Record<string, unknown>): string | null {
  const defaultLocale = isRecord(addon.defaultLocale)
    ? addon.defaultLocale
    : null;
  if (typeof defaultLocale?.name === 'string') {
    return defaultLocale.name;
  }
  return typeof addon.name === 'string' ? addon.name : null;
}

function parseFirefoxInstallations(params: {
  expectedExtensionPath: string | null;
  extensionsJson: unknown;
  extensionsPath: string;
  firefoxExtensionId: string;
  profileName: string;
  targetManifestName: string;
}): BrowserExtensionInstall[] {
  return getFirefoxAddons(params.extensionsJson).flatMap((rawAddon) => {
    if (!isRecord(rawAddon)) {
      return [];
    }
    const extensionId =
      typeof rawAddon.id === 'string' ? rawAddon.id.trim() : null;
    if (!extensionId) {
      return [];
    }
    const addonType = typeof rawAddon.type === 'string' ? rawAddon.type : null;
    if (addonType && addonType !== 'extension') {
      return [];
    }

    const installPath = getFirefoxInstallPath(rawAddon);
    const manifestName = getFirefoxManifestName(rawAddon);
    const pathMatches =
      Boolean(params.expectedExtensionPath) &&
      Boolean(installPath) &&
      normalizePathForCompare(installPath!) === params.expectedExtensionPath;
    const idMatches = extensionId === params.firefoxExtensionId;
    const manifestNameMatches =
      Boolean(manifestName) &&
      normalizeManifestName(manifestName!) === params.targetManifestName;

    if (!idMatches && !pathMatches && !manifestNameMatches) {
      return [];
    }

    const enabled =
      typeof rawAddon.active === 'boolean'
        ? rawAddon.active
        : !rawAddon.userDisabled && !rawAddon.appDisabled;

    return [
      {
        browser: 'firefox',
        enabled,
        extensionId,
        installPath,
        manifestName,
        preferencesPath: params.extensionsPath,
        profileName: params.profileName,
        state: enabled ? 1 : 0,
      } satisfies BrowserExtensionInstall,
    ];
  });
}

function buildMessage(installations: BrowserExtensionInstall[]): string {
  if (!installations.length) {
    return 'GameVault extension was not found in Chrome, Edge, or Firefox. Load the unpacked extension, then refresh detection.';
  }

  const enabledCount = installations.filter(
    (install) => install.enabled,
  ).length;
  const firstInstall = installations[0]!;
  const firstLocation = `${BROWSER_LABELS[firstInstall.browser]} ${firstInstall.profileName}`;

  if (installations.length === 1) {
    return firstInstall.enabled
      ? `GameVault extension is installed in ${firstLocation}.`
      : `GameVault extension is installed in ${firstLocation}, but it is disabled.`;
  }

  if (!enabledCount) {
    return `GameVault extension is installed in ${installations.length} browser profiles, but all are disabled.`;
  }

  if (enabledCount < installations.length) {
    return `GameVault extension is installed in ${installations.length} browser profiles; ${enabledCount} ${
      enabledCount === 1 ? 'is' : 'are'
    } enabled.`;
  }

  return `GameVault extension is installed in ${installations.length} browser profiles.`;
}

export async function detectBrowserExtension(
  options: BrowserExtensionDetectionOptions = {},
): Promise<BrowserExtensionInstallStatus> {
  const env = options.env ?? process.env;
  const now = options.now ?? (() => new Date());
  const readDirectory: (path: string) => Promise<DirectoryEntry[]> =
    options.readDirectory ??
    ((path: string) => readdir(path, { withFileTypes: true }));
  const readTextFile: (path: string) => Promise<string> =
    options.readTextFile ?? ((path: string) => readFile(path, 'utf8'));
  const expectedExtensionPath = options.extensionPath?.trim()
    ? normalizePathForCompare(options.extensionPath)
    : null;
  const targetManifestName = normalizeManifestName(
    options.manifestName ?? DEFAULT_MANIFEST_NAME,
  );
  const firefoxExtensionId = options.firefoxExtensionId ?? FIREFOX_EXTENSION_ID;

  const profilePreferenceFiles = (
    await Promise.all(
      knownChromiumUserDataRoots(env).map((root) =>
        listProfilePreferenceFiles({
          browser: root.browser,
          readDirectory,
          userDataPath: root.userDataPath,
        }),
      ),
    )
  ).flat();
  const firefoxExtensionFiles = await listFirefoxExtensionFiles({
    profilesRoot: knownFirefoxProfilesRoot(env),
    readDirectory,
  });

  const installations = (
    await Promise.all([
      ...profilePreferenceFiles.map(async (profile) => {
        try {
          const preferences = JSON.parse(
            await readTextFile(profile.preferencesPath),
          ) as unknown;
          return parseInstallationsFromPreferences({
            browser: profile.browser,
            expectedExtensionPath,
            preferences,
            preferencesPath: profile.preferencesPath,
            profileName: profile.profileName,
            targetManifestName,
          });
        } catch {
          return [];
        }
      }),
      ...firefoxExtensionFiles.map(async (profile) => {
        try {
          const extensionsJson = JSON.parse(
            await readTextFile(profile.extensionsPath),
          ) as unknown;
          return parseFirefoxInstallations({
            expectedExtensionPath,
            extensionsJson,
            extensionsPath: profile.extensionsPath,
            firefoxExtensionId,
            profileName: profile.profileName,
            targetManifestName,
          });
        } catch {
          return [];
        }
      }),
    ])
  )
    .flat()
    .sort(
      (left, right) =>
        left.browser.localeCompare(right.browser) ||
        left.profileName.localeCompare(right.profileName) ||
        left.extensionId.localeCompare(right.extensionId),
    );

  return {
    checkedAt: now().toISOString(),
    detected: installations.length > 0,
    enabled: installations.some((install) => install.enabled),
    installations,
    message: buildMessage(installations),
  };
}
