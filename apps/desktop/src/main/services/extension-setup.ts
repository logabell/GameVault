import { copyFile, mkdir, readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

export function getAsarUnpackedPath(filePath: string): string {
  return filePath.replace(/([/\\])app\.asar([/\\])/, '$1app.asar.unpacked$2');
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

async function copyDirectory(from: string, to: string): Promise<void> {
  await mkdir(to, { recursive: true });
  const entries = await readdir(from, { withFileTypes: true });
  await Promise.all(
    entries.map((entry) => {
      const source = join(from, entry.name);
      const target = join(to, entry.name);
      return entry.isDirectory()
        ? copyDirectory(source, target)
        : copyFile(source, target);
    }),
  );
}

async function readManifestVersion(
  extensionPath: string,
): Promise<string | null> {
  try {
    const manifest = JSON.parse(
      await readFile(join(extensionPath, 'manifest.json'), 'utf8'),
    ) as { version?: unknown };
    return typeof manifest.version === 'string' ? manifest.version : null;
  } catch {
    return null;
  }
}

export async function prepareBrowserExtensionInstall(params: {
  sourceExtensionPath: string;
  targetExtensionPath: string;
}): Promise<boolean> {
  const sourceManifestExists = await pathExists(
    join(params.sourceExtensionPath, 'manifest.json'),
  );
  if (!sourceManifestExists) {
    return pathExists(join(params.targetExtensionPath, 'manifest.json'));
  }

  const [sourceVersion, targetVersion] = await Promise.all([
    readManifestVersion(params.sourceExtensionPath),
    readManifestVersion(params.targetExtensionPath),
  ]);
  const targetManifestExists = await pathExists(
    join(params.targetExtensionPath, 'manifest.json'),
  );

  if (targetManifestExists && sourceVersion && sourceVersion === targetVersion) {
    return true;
  }

  await copyDirectory(params.sourceExtensionPath, params.targetExtensionPath);
  return pathExists(join(params.targetExtensionPath, 'manifest.json'));
}
