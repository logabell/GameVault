import { rm } from 'node:fs/promises';

const targets = [
  'apps/desktop/dist',
  'apps/desktop/release',
  'apps/extension/dist',
  'packages/shared-types/dist',
  'packages/source-core/dist',
  'packages/steam-core/dist',
];

await Promise.all(
  targets.map((target) =>
    rm(new URL(`../${target}`, import.meta.url), {
      force: true,
      recursive: true,
    }),
  ),
);
