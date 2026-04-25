import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';

const hostName = 'com.gamevault.desktop';
const firefoxExtensionId = 'gamevault@vaulttrack.local';
const args = Object.fromEntries(
  process.argv.slice(2).map((entry) => {
    const [key, value] = entry.replace(/^--/, '').split('=');
    return [key, value ?? 'true'];
  }),
);

const extensionId = args['extension-id'];
const requestedBrowsers = (args.browser ?? 'both')
  .split(',')
  .map((entry) => entry.trim().toLowerCase())
  .filter(Boolean);
const browsers = requestedBrowsers.includes('all')
  ? ['chrome', 'edge', 'firefox']
  : requestedBrowsers.includes('both')
    ? ['chrome', 'edge']
    : [...new Set(requestedBrowsers)];
const chromiumBrowsers = browsers.filter((browser) =>
  ['chrome', 'edge'].includes(browser),
);
if (chromiumBrowsers.length && !extensionId) {
  throw new Error('Pass --extension-id=<loaded extension id>');
}

const localAppData =
  process.env.LOCALAPPDATA ??
  resolve(import.meta.dirname, '..', '..', '..', '.gamevault-native-host');
const nativeHostBundlePath = resolve(
  import.meta.dirname,
  '../dist/native-host/index.cjs',
);
const nativeHostDir = join(localAppData, 'GameVault', 'NativeHost');
const launcherPath = join(nativeHostDir, 'gamevault-native-host.cmd');
const chromiumManifestPath = join(nativeHostDir, `${hostName}.chromium.json`);
const firefoxManifestPath = join(nativeHostDir, `${hostName}.firefox.json`);
const manifestPaths = new Map();

function runRegCommand(command, args, { ignoreFailure = false } = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      stdio: 'inherit',
    });
    child.on('exit', (code) => {
      if (code === 0 || ignoreFailure) {
        resolvePromise(undefined);
        return;
      }
      rejectPromise(
        new Error(`${command} ${args.join(' ')} failed with exit code ${code}`),
      );
    });
  });
}

await mkdir(nativeHostDir, { recursive: true });
await writeFile(
  launcherPath,
  `@echo off\r\n"${process.execPath}" "${nativeHostBundlePath}" %*\r\n`,
);
if (chromiumBrowsers.length) {
  await writeFile(
    chromiumManifestPath,
    JSON.stringify(
      {
        allowed_origins: [`chrome-extension://${extensionId}/`],
        description: 'GameVault Native Messaging Host',
        name: hostName,
        path: launcherPath,
        type: 'stdio',
      },
      null,
      2,
    ),
  );
  for (const browser of chromiumBrowsers) {
    manifestPaths.set(browser, chromiumManifestPath);
  }
}
if (browsers.includes('firefox')) {
  await writeFile(
    firefoxManifestPath,
    JSON.stringify(
      {
        allowed_extensions: [firefoxExtensionId],
        description: 'GameVault Native Messaging Host',
        name: hostName,
        path: launcherPath,
        type: 'stdio',
      },
      null,
      2,
    ),
  );
  manifestPaths.set('firefox', firefoxManifestPath);
}

for (const browser of browsers) {
  const registryPath =
    browser === 'firefox'
      ? `HKCU\\Software\\Mozilla\\NativeMessagingHosts\\${hostName}`
      : browser === 'edge'
        ? `HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts\\${hostName}`
        : `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${hostName}`;
  const manifestPath = manifestPaths.get(browser);
  if (!manifestPath) {
    throw new Error(`Unsupported browser target: ${browser}`);
  }

  await runRegCommand('reg.exe', ['delete', registryPath, '/f'], {
    ignoreFailure: true,
  });
  await runRegCommand('reg.exe', [
    'add',
    registryPath,
    '/ve',
    '/t',
    'REG_SZ',
    '/d',
    manifestPath,
    '/f',
  ]);
}

console.log(
  `Registered ${hostName} for ${browsers.join(', ')} using ${[
    ...new Set(manifestPaths.values()),
  ].join(', ')}`,
);
