const { execFileSync } = require('node:child_process');
const { readFileSync } = require('node:fs');

const directories = ['share', 'protocol', 'core', 'cli'];
const versionFiles = directories.map((dir) => `packages/${dir}/package.json`);
const run = (command, args, options = {}) =>
  (
    execFileSync(command, args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      ...options,
    }) || ''
  ).trim();
const git = (...args) => run('git', args);
const readPackage = (file) => JSON.parse(readFileSync(file, 'utf8'));
function parseVersion(version) {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) {
    throw new Error(`Invalid stable version: ${version}`);
  }
  return version.split('.').map(BigInt);
}
function nextVersion(current, input) {
  const parts = parseVersion(current);
  const index = ['major', 'minor', 'patch'].indexOf(input);
  if (index >= 0) {
    parts[index] += 1n;
    for (let i = index + 1; i < 3; i++) parts[i] = 0n;
    input = parts.join('.');
  }
  const next = parseVersion(input);
  const previous = parseVersion(current);
  const firstDifference = next.findIndex((part, i) => part !== previous[i]);
  if (firstDifference < 0 || next[firstDifference] < previous[firstDifference]) {
    throw new Error(`Version must increase: ${current} -> ${input}`);
  }
  return input;
}
function checkVersions(tag) {
  const packages = versionFiles.map(readPackage);
  const version = packages[0].version;
  parseVersion(version);
  if (packages.some((pkg) => pkg.private || pkg.version !== version)) {
    throw new Error('Public package versions must match');
  }
  if (tag !== undefined && tag !== `v${version}`) {
    throw new Error(`Tag ${tag} does not match package version v${version}`);
  }
  return version;
}
module.exports = { directories, versionFiles, run, git, readPackage, nextVersion, checkVersions };
