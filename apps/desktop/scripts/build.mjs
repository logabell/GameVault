import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import esbuild from 'esbuild';

const rootDir = resolve(import.meta.dirname, '..');
const distDir = join(rootDir, 'dist');
const srcDir = join(rootDir, 'src');

await mkdir(join(distDir, 'main'), { recursive: true });
await mkdir(join(distDir, 'renderer'), { recursive: true });
await mkdir(join(distDir, 'native-host'), { recursive: true });

await Promise.all([
  esbuild.build({
    bundle: true,
    entryPoints: [join(srcDir, 'main', 'index.ts')],
    external: ['electron', 'sql.js', 'jdownloader-connect'],
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
await copyFile(
  resolve(rootDir, '../../node_modules/sql.js/dist/sql-wasm.wasm'),
  join(distDir, 'main', 'sql-wasm.wasm'),
);

const packageJson = JSON.parse(
  await readFile(resolve(rootDir, 'package.json'), 'utf8'),
);
packageJson.main = './dist/main/index.cjs';
await writeFile(
  join(distDir, 'package.json'),
  JSON.stringify(packageJson, null, 2),
);
