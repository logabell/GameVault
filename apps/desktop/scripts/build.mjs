import {
  copyFile,
  mkdir,
  readdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import esbuild from 'esbuild';

const rootDir = resolve(import.meta.dirname, '..');
const distDir = join(rootDir, 'dist');
const srcDir = join(rootDir, 'src');

await mkdir(join(distDir, 'main'), { recursive: true });
await mkdir(join(distDir, 'renderer'), { recursive: true });
await mkdir(join(distDir, 'native-host'), { recursive: true });

async function copyDirectory(from, to) {
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

async function buildAndCopyExtension() {
  await import(
    pathToFileURL(resolve(rootDir, '..', 'extension', 'scripts', 'build.mjs'))
      .href
  );

  const extensionDistDir = resolve(rootDir, '..', 'extension', 'dist');
  const bundledExtensionDir = join(distDir, 'extension');
  await rm(bundledExtensionDir, { force: true, recursive: true });
  await copyDirectory(extensionDistDir, bundledExtensionDir);
}

await Promise.all([
  esbuild.build({
    bundle: true,
    entryPoints: [join(srcDir, 'main', 'index.ts')],
    external: ['electron', 'sql.js', 'jdownloader-connect', '7zip-bin-full'],
    format: 'cjs',
    outfile: join(distDir, 'main', 'index.cjs'),
    platform: 'node',
    sourcemap: true,
    target: 'node22',
  }),
  esbuild.build({
    bundle: true,
    entryPoints: [join(srcDir, 'main', 'preload.ts')],
    external: ['electron'],
    format: 'cjs',
    outfile: join(distDir, 'main', 'preload.cjs'),
    platform: 'node',
    sourcemap: true,
    target: 'node22',
  }),
  esbuild.build({
    bundle: true,
    entryPoints: [join(srcDir, 'native-host', 'index.ts')],
    external: ['electron'],
    format: 'cjs',
    outfile: join(distDir, 'native-host', 'index.cjs'),
    platform: 'node',
    sourcemap: true,
    target: 'node22',
  }),
  esbuild.build({
    bundle: true,
    entryPoints: [join(srcDir, 'renderer', 'index.tsx')],
    format: 'esm',
    outfile: join(distDir, 'renderer', 'index.js'),
    platform: 'browser',
    sourcemap: true,
    target: 'chrome124',
  }),
]);

await copyFile(
  join(srcDir, 'renderer', 'index.html'),
  join(distDir, 'renderer', 'index.html'),
);
await copyFile(
  join(srcDir, 'renderer', 'styles.css'),
  join(distDir, 'renderer', 'styles.css'),
);
await copyDirectory(join(srcDir, 'assets'), join(distDir, 'assets'));
await buildAndCopyExtension();
await copyFile(
  resolve(rootDir, '../../node_modules/sql.js/dist/sql-wasm.wasm'),
  join(distDir, 'main', 'sql-wasm.wasm'),
);

const packageJson = JSON.parse(
  await readFile(resolve(rootDir, 'package.json'), 'utf8'),
);
const runtimeDependencies = ['7zip-bin-full', 'sql.js'];
const distPackageJson = {
  name: packageJson.name,
  version: packageJson.version,
  private: packageJson.private,
  description: packageJson.description,
  productName: packageJson.productName,
  type: packageJson.type,
  main: './main/index.cjs',
  dependencies: Object.fromEntries(
    runtimeDependencies
      .map((dependency) => [
        dependency,
        packageJson.dependencies?.[dependency],
      ])
      .filter((entry) => Boolean(entry[1])),
  ),
};
await writeFile(
  join(distDir, 'package.json'),
  JSON.stringify(distPackageJson, null, 2),
);
