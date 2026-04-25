import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type {
  BrowserTarget,
  NativeHostRegistrationResult,
  RegisterExtensionNativeHostPayload,
} from '@gamevault/shared-types';
import { FIREFOX_EXTENSION_ID } from '@gamevault/shared-types';

export const GAMEVAULT_NATIVE_HOST_NAME = 'com.gamevault.desktop';

interface NativeHostRegistrationOptions extends RegisterExtensionNativeHostPayload {
  localAppData?: string;
  nativeHostBundlePath: string;
  now?: () => Date;
  runCommand?: (
    command: string,
    args: string[],
    options?: { ignoreFailure?: boolean },
  ) => Promise<void>;
}

const BROWSER_REGISTRY_PATHS: Record<BrowserTarget, string> = {
  chrome: `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${GAMEVAULT_NATIVE_HOST_NAME}`,
  edge: `HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts\\${GAMEVAULT_NATIVE_HOST_NAME}`,
  firefox: `HKCU\\Software\\Mozilla\\NativeMessagingHosts\\${GAMEVAULT_NATIVE_HOST_NAME}`,
};

function isChromiumBrowser(browser: BrowserTarget): boolean {
  return browser === 'chrome' || browser === 'edge';
}

export function isValidBrowserExtensionId(
  extensionId: string,
  browser: BrowserTarget = 'chrome',
): boolean {
  const trimmed = extensionId.trim();
  if (browser === 'firefox') {
    return trimmed === FIREFOX_EXTENSION_ID;
  }
  return /^[a-p]{32}$/.test(trimmed);
}

function defaultRunCommand(
  command: string,
  args: string[],
  options: { ignoreFailure?: boolean } = {},
): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      stdio: 'ignore',
      windowsHide: true,
    });
    child.once('error', (error) => {
      if (options.ignoreFailure) {
        resolvePromise();
        return;
      }
      rejectPromise(error);
    });
    child.once('exit', (code) => {
      if (code === 0 || options.ignoreFailure) {
        resolvePromise();
        return;
      }
      rejectPromise(
        new Error(`${command} ${args.join(' ')} failed with exit code ${code}`),
      );
    });
  });
}

function normalizeBrowserTargets(browsers: BrowserTarget[]): BrowserTarget[] {
  const normalized = browsers.filter(
    (browser): browser is BrowserTarget =>
      browser === 'chrome' || browser === 'edge' || browser === 'firefox',
  );
  return [...new Set(normalized)];
}

export async function registerExtensionNativeHost(
  options: NativeHostRegistrationOptions,
): Promise<NativeHostRegistrationResult> {
  const extensionId = options.extensionId.trim();
  const browsers = normalizeBrowserTargets(options.browsers);
  if (!browsers.length) {
    throw new Error(
      'Choose at least one browser for native host registration.',
    );
  }
  const chromiumBrowsers = browsers.filter(isChromiumBrowser);
  const includesFirefox = browsers.includes('firefox');
  if (includesFirefox && chromiumBrowsers.length) {
    throw new Error('Register Firefox separately from Chrome and Edge.');
  }
  if (includesFirefox && !isValidBrowserExtensionId(extensionId, 'firefox')) {
    throw new Error(`Use the Firefox add-on ID ${FIREFOX_EXTENSION_ID}.`);
  }
  if (chromiumBrowsers.length && !isValidBrowserExtensionId(extensionId)) {
    throw new Error('Enter a valid Chrome or Edge extension ID.');
  }

  const runCommand = options.runCommand ?? defaultRunCommand;
  const localAppData =
    options.localAppData ??
    process.env.LOCALAPPDATA ??
    join(process.cwd(), '.gamevault-native-host');
  const nativeHostDir = join(localAppData, 'GameVault', 'NativeHost');
  const launcherPath = join(nativeHostDir, 'gamevault-native-host.cmd');
  const chromiumManifestPath = join(
    nativeHostDir,
    `${GAMEVAULT_NATIVE_HOST_NAME}.chromium.json`,
  );
  const firefoxManifestPath = join(
    nativeHostDir,
    `${GAMEVAULT_NATIVE_HOST_NAME}.firefox.json`,
  );
  const manifestPaths: Partial<Record<BrowserTarget, string>> = {};

  await mkdir(nativeHostDir, { recursive: true });
  await writeFile(
    launcherPath,
    `@echo off\r\n"${process.execPath}" "${options.nativeHostBundlePath}" %*\r\n`,
  );
  if (chromiumBrowsers.length) {
    await writeFile(
      chromiumManifestPath,
      JSON.stringify(
        {
          allowed_origins: [`chrome-extension://${extensionId}/`],
          description: 'GameVault Native Messaging Host',
          name: GAMEVAULT_NATIVE_HOST_NAME,
          path: launcherPath,
          type: 'stdio',
        },
        null,
        2,
      ),
    );
    for (const browser of chromiumBrowsers) {
      manifestPaths[browser] = chromiumManifestPath;
    }
  }
  if (includesFirefox) {
    await writeFile(
      firefoxManifestPath,
      JSON.stringify(
        {
          allowed_extensions: [FIREFOX_EXTENSION_ID],
          description: 'GameVault Native Messaging Host',
          name: GAMEVAULT_NATIVE_HOST_NAME,
          path: launcherPath,
          type: 'stdio',
        },
        null,
        2,
      ),
    );
    manifestPaths.firefox = firefoxManifestPath;
  }

  for (const browser of browsers) {
    const registryPath = BROWSER_REGISTRY_PATHS[browser];
    await runCommand('reg.exe', ['delete', registryPath, '/f'], {
      ignoreFailure: true,
    });
    await runCommand('reg.exe', [
      'add',
      registryPath,
      '/ve',
      '/t',
      'REG_SZ',
      '/d',
      manifestPaths[browser]!,
      '/f',
    ]);
  }

  return {
    browsers,
    extensionId,
    launcherPath,
    manifestPath: manifestPaths[browsers[0]!]!,
    manifestPaths,
    registeredAt: (options.now ?? (() => new Date()))().toISOString(),
  };
}
