import { readFile } from 'node:fs/promises';

const workspacePackagePaths = [
  'package.json',
  'apps/desktop/package.json',
  'apps/extension/package.json',
  'packages/shared-types/package.json',
  'packages/source-core/package.json',
  'packages/steam-core/package.json',
];
const extensionManifestPath = 'apps/extension/src/manifest.json';

async function readJson(path) {
  return JSON.parse(
    await readFile(new URL(`../${path}`, import.meta.url), 'utf8'),
  );
}

function allowedTagsForVersion(version) {
  const tags = new Set([`v${version}`]);
  const shortTag = `v${version.replace(/\.0$/, '')}`;
  tags.add(shortTag);
  return tags;
}

const rootPackage = await readJson('package.json');
const releaseVersion = rootPackage.version;
const releaseTag = process.argv[2] ?? process.env.GITHUB_REF_NAME ?? null;
const errors = [];

for (const packagePath of workspacePackagePaths) {
  const packageJson = await readJson(packagePath);
  if (packageJson.version !== releaseVersion) {
    errors.push(
      `${packagePath} is ${packageJson.version}, expected ${releaseVersion}.`,
    );
  }

  for (const sectionName of ['dependencies', 'devDependencies']) {
    const section = packageJson[sectionName] ?? {};
    for (const [dependency, version] of Object.entries(section)) {
      if (dependency.startsWith('@gamevault/') && version !== releaseVersion) {
        errors.push(
          `${packagePath} ${sectionName}.${dependency} is ${version}, expected ${releaseVersion}.`,
        );
      }
    }
  }
}

const extensionManifest = await readJson(extensionManifestPath);
if (extensionManifest.version !== releaseVersion) {
  errors.push(
    `${extensionManifestPath} is ${extensionManifest.version}, expected ${releaseVersion}.`,
  );
}

if (releaseTag) {
  const allowedTags = allowedTagsForVersion(releaseVersion);
  if (!allowedTags.has(releaseTag)) {
    errors.push(
      `Release tag ${releaseTag} does not match ${[...allowedTags].join(' or ')}.`,
    );
  }
}

if (errors.length > 0) {
  throw new Error(`Release version check failed:\n${errors.join('\n')}`);
}

console.log(
  releaseTag
    ? `Release version ${releaseVersion} matches ${releaseTag}.`
    : `Release version ${releaseVersion} is consistent across workspaces.`,
);
