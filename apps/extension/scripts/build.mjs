import { watch } from 'node:fs';
import { copyFile, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import esbuild from 'esbuild';

const rootDir = resolve(import.meta.dirname, '..');
const distDir = join(rootDir, 'dist');
const srcDir = join(rootDir, 'src');
const isWatchMode = process.argv.includes('--watch');

await mkdir(join(distDir, 'background'), { recursive: true });
await mkdir(join(distDir, 'content'), { recursive: true });
await mkdir(join(distDir, 'popup'), { recursive: true });

const staticAssetCopies = [
  [join(srcDir, 'manifest.json'), join(distDir, 'manifest.json')],
  [join(srcDir, 'popup', 'index.html'), join(distDir, 'popup.html')],
  [join(srcDir, 'popup', 'styles.css'), join(distDir, 'styles.css')],
];

async function copyStaticAssets() {
  await Promise.all(
    staticAssetCopies.map(([from, to]) => copyFile(from, to)),
  );
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
      target: 'chrome124',
    }),
    esbuild.context({
      bundle: true,
      entryPoints: [join(srcDir, 'content', 'index.ts')],
      format: 'esm',
      outfile: join(distDir, 'content.js'),
      platform: 'browser',
      sourcemap: true,
      target: 'chrome124',
    }),
    esbuild.context({
      bundle: true,
      entryPoints: [join(srcDir, 'content', 'steamdb.ts')],
      format: 'esm',
      outfile: join(distDir, 'steamdb-content.js'),
      platform: 'browser',
      sourcemap: true,
      target: 'chrome124',
    }),
    esbuild.context({
      bundle: true,
      entryPoints: [join(srcDir, 'popup', 'index.tsx')],
      format: 'esm',
      outfile: join(distDir, 'popup.js'),
      platform: 'browser',
      sourcemap: true,
      target: 'chrome124',
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
    target: 'chrome124',
  }),
  esbuild.build({
    bundle: true,
    entryPoints: [join(srcDir, 'content', 'index.ts')],
    format: 'esm',
    outfile: join(distDir, 'content.js'),
    platform: 'browser',
    sourcemap: true,
    target: 'chrome124',
  }),
  esbuild.build({
    bundle: true,
    entryPoints: [join(srcDir, 'content', 'steamdb.ts')],
    format: 'esm',
    outfile: join(distDir, 'steamdb-content.js'),
    platform: 'browser',
    sourcemap: true,
    target: 'chrome124',
  }),
  esbuild.build({
    bundle: true,
    entryPoints: [join(srcDir, 'popup', 'index.tsx')],
    format: 'esm',
    outfile: join(distDir, 'popup.js'),
    platform: 'browser',
    sourcemap: true,
    target: 'chrome124',
    }),
  ]);

  await copyStaticAssets();
}
