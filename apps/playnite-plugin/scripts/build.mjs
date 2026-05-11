import { spawn } from 'node:child_process';
import { access, copyFile, mkdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

// Playnite 6.x SDK releases are backwards compatible within the major line.
// Build against 6.0.0 so the plugin loads on both older and newer Playnite 10 builds.
const sdkVersion = process.env.PLAYNITE_SDK_VERSION ?? '6.0.0';
const rootDir = resolve(import.meta.dirname, '..');
const outputDir = join(rootDir, 'bin', 'Release', 'net462');
const sdkCacheDir = join(rootDir, '.playnite-sdk');
const sdkPackagePath = join(sdkCacheDir, `PlayniteSDK.${sdkVersion}.nupkg`);
const sdkZipPath = join(sdkCacheDir, `PlayniteSDK.${sdkVersion}.zip`);
const sdkExtractPath = join(sdkCacheDir, `PlayniteSDK.${sdkVersion}`);
const sdkDllPath = join(sdkExtractPath, 'lib', 'net462', 'Playnite.SDK.dll');
const cscPath = 'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe';

async function pathExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function run(command, args) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      stdio: 'inherit',
      windowsHide: true,
    });
    child.once('error', rejectPromise);
    child.once('exit', (code) => {
      if (code === 0) {
        resolvePromise();
        return;
      }
      rejectPromise(
        new Error(`${command} ${args.join(' ')} failed with exit code ${code}`),
      );
    });
  });
}

async function ensurePlayniteSdk() {
  await mkdir(sdkCacheDir, { recursive: true });
  if (!(await pathExists(sdkPackagePath))) {
    const response = await fetch(
      `https://www.nuget.org/api/v2/package/PlayniteSDK/${sdkVersion}`,
    );
    if (!response.ok) {
      throw new Error(
        `Unable to download PlayniteSDK ${sdkVersion}: ${response.status}`,
      );
    }
    await writeFile(sdkPackagePath, Buffer.from(await response.arrayBuffer()));
  }
  if (!(await pathExists(sdkDllPath))) {
    await rm(sdkExtractPath, { force: true, recursive: true });
    await mkdir(sdkExtractPath, { recursive: true });
    await copyFile(sdkPackagePath, sdkZipPath);
    await run('powershell.exe', [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      `Expand-Archive -LiteralPath '${sdkZipPath.replaceAll("'", "''")}' -DestinationPath '${sdkExtractPath.replaceAll("'", "''")}' -Force`,
    ]);
  }
}

async function buildPlugin() {
  if (!(await pathExists(cscPath))) {
    throw new Error(`C# compiler was not found at ${cscPath}.`);
  }
  await ensurePlayniteSdk();
  await rm(outputDir, { force: true, recursive: true });
  await mkdir(outputDir, { recursive: true });
  await run(cscPath, [
    '/nologo',
    '/target:library',
    '/optimize+',
    `/out:${join(outputDir, 'GameVault.Playnite.dll')}`,
    `/reference:${sdkDllPath}`,
    '/reference:System.Drawing.dll',
    '/reference:System.Runtime.Serialization.dll',
    join(rootDir, 'GameVaultLibraryPlugin.cs'),
  ]);
  await copyFile(
    join(rootDir, 'extension.yaml'),
    join(outputDir, 'extension.yaml'),
  );
}

await buildPlugin();
