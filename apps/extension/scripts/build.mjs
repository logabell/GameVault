import { watch } from 'node:fs';
import { copyFile, mkdir, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import esbuild from 'esbuild';

const rootDir = resolve(import.meta.dirname, '..');
const distDir = join(rootDir, 'dist');
const srcDir = join(rootDir, 'src');
const isWatchMode = process.argv.includes('--watch');
const browserTargets = ['chrome124', 'firefox128'];

await mkdir(join(distDir, 'background'), { recursive: true });
await mkdir(join(distDir, 'content'), { recursive: true });
await mkdir(join(distDir, 'popup'), { recursive: true });

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

const staticAssetCopies = [
  [join(srcDir, 'manifest.json'), join(distDir, 'manifest.json')],
  [join(srcDir, 'popup', 'index.html'), join(distDir, 'popup.html')],
  [join(srcDir, 'popup', 'styles.css'), join(distDir, 'styles.css')],
];

async function copyStaticAssets() {
  await Promise.all([
    ...staticAssetCopies.map(([from, to]) => copyFile(from, to)),
    copyDirectory(join(srcDir, 'icons'), join(distDir, 'icons')),
  ]);
}

if (isWatchMode) {
  const contexts = await Promise.all([
    esbuild.context({
      bundle: true,
      entryPoints: [join(srcDir, 'background', 'index.ts')],
      format: 'esm',
      outfile: join(distDir, 'background.js'),
      platform: 'browser',
      sourcemap: true,
      target: browserTargets,
    }),
    esbuild.context({
      bundle: true,
      entryPoints: [join(srcDir, 'content', 'index.ts')],
      format: 'esm',
      outfile: join(distDir, 'content.js'),
      platform: 'browser',
      sourcemap: true,
      target: browserTargets,
    }),
    esbuild.context({
      bundle: true,
      entryPoints: [join(srcDir, 'content', 'steamdb.ts')],
      format: 'esm',
      outfile: join(distDir, 'steamdb-content.js'),
      platform: 'browser',
      sourcemap: true,
      target: browserTargets,
    }),
    esbuild.context({
      bundle: true,
      entryPoints: [join(srcDir, 'popup', 'index.tsx')],
      format: 'esm',
      outfile: join(distDir, 'popup.js'),
      platform: 'browser',
      sourcemap: true,
      target: browserTargets,
    }),
  ]);

  await Promise.all(contexts.map((context) => context.watch()));
  await copyStaticAssets();

  watch(srcDir, { recursive: true }, async (_eventType, filename) => {
    if (!filename) {
      return;
    }

    if (
      filename === 'manifest.json' ||
      filename === 'icons' ||
      filename.startsWith('icons/') ||
      filename.startsWith('icons\\') ||
      filename === join('popup', 'index.html') ||
      filename === join('popup', 'styles.css')
    ) {
      try {
        await copyStaticAssets();
        console.log(`[extension] copied ${filename}`);
      } catch (error) {
        console.error('[extension] static asset copy failed', error);
      }
    }
  });

  console.log('[extension] watch mode active');
  await new Promise(() => {});
} else {
  await Promise.all([
    esbuild.build({
      bundle: true,
      entryPoints: [join(srcDir, 'background', 'index.ts')],
      format: 'esm',
      outfile: join(distDir, 'background.js'),
      platform: 'browser',
      sourcemap: true,
      target: browserTargets,
    }),
    esbuild.build({
      bundle: true,
      entryPoints: [join(srcDir, 'content', 'index.ts')],
      format: 'esm',
      outfile: join(distDir, 'content.js'),
      platform: 'browser',
      sourcemap: true,
      target: browserTargets,
    }),
    esbuild.build({
      bundle: true,
      entryPoints: [join(srcDir, 'content', 'steamdb.ts')],
      format: 'esm',
      outfile: join(distDir, 'steamdb-content.js'),
      platform: 'browser',
      sourcemap: true,
      target: browserTargets,
    }),
    esbuild.build({
      bundle: true,
      entryPoints: [join(srcDir, 'popup', 'index.tsx')],
      format: 'esm',
      outfile: join(distDir, 'popup.js'),
      platform: 'browser',
      sourcemap: true,
      target: browserTargets,
    }),
  ]);

  await copyStaticAssets();
}
