import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';

const hostName = 'com.vaulttrack.desktop';
const args = Object.fromEntries(
  process.argv.slice(2).map((entry) => {
    const [key, value] = entry.replace(/^--/, '').split('=');
    return [key, value ?? 'true'];
  }),
);

const extensionId = args['extension-id'];
if (!extensionId) {
  throw new Error('Pass --extension-id=<loaded extension id>');
}

const requestedBrowsers = (args.browser ?? 'both')
  .split(',')
  .map((entry) => entry.trim().toLowerCase())
  .filter(Boolean);
const browsers = requestedBrowsers.includes('both')
  ? ['chrome', 'edge']
  : requestedBrowsers;

const localAppData =
  process.env.LOCALAPPDATA ??
  resolve(import.meta.dirname, '..', '..', '..', '.vaulttrack-native-host');
const nativeHostBundlePath = resolve(import.meta.dirname, '../dist/native-host/index.cjs');
const nativeHostDir = join(localAppData, 'VaultTrack', 'NativeHost');
const launcherPath = join(nativeHostDir, 'vaulttrack-native-host.cmd');
const manifestPath = join(nativeHostDir, `${hostName}.json`);

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
      rejectPromise(new Error(`${command} ${args.join(' ')} failed with exit code ${code}`));
    });
  });
}

await mkdir(nativeHostDir, { recursive: true });
await writeFile(
  launcherPath,
  `@echo off\r\n"${process.execPath}" "${nativeHostBundlePath}" %*\r\n`,
);
await writeFile(
  manifestPath,
  JSON.stringify(
    {
      allowed_origins: [`chrome-extension://${extensionId}/`],
      description: 'VaultTrack Native Messaging Host',
      name: hostName,
      path: launcherPath,
      type: 'stdio',
    },
    null,
    2,
  ),
);

for (const browser of browsers) {
  const registryPath =
    browser === 'edge'
      ? `HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts\\${hostName}`
      : `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${hostName}`;

  await runRegCommand(
    'reg.exe',
    ['delete', `${registryPath}"`, '/f'],
    { ignoreFailure: true },
  );
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

console.log(`Registered ${hostName} for ${browsers.join(', ')} using ${manifestPath}`);
