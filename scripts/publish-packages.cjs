const { execFileSync } = require('node:child_process');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { packAll } = require('./release-packages.cjs');
const registry = 'https://registry.npmjs.org/';

function alreadyPublished(pkg, execute = execFileSync) {
  let result;
  try {
    result = execute(
      'npm',
      ['view', `${pkg.name}@${pkg.version}`, 'version', '--json', `--registry=${registry}`],
      {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
  } catch (error) {
    // Only an explicit registry E404 means absent (including the first publish).
    // Auth, connection, timeout and malformed responses must stop the release.
    for (const value of [error.stdout, error.stderr]) {
      let response;
      try {
        response = JSON.parse(value?.toString());
      } catch {
        continue;
      }
      if (response.error?.code === 'E404') return false;
    }
    throw error;
  }
  if (JSON.parse(result) !== pkg.version)
    throw new Error(`Unexpected registry version for ${pkg.name}`);
  return true;
}
function publishAll(artifacts, execute = execFileSync) {
  for (const { pkg, tarball } of artifacts) {
    if (alreadyPublished(pkg, execute)) {
      console.log(`Skipping ${pkg.name}@${pkg.version}: already published.`);
      continue;
    }
    // pnpm has converted workspace dependencies in the validated tarball.
    // npm 11 supplies GitHub Actions OIDC; no package tags or Git writes here.
    execute('npm', ['publish', tarball, '--access', 'public', `--registry=${registry}`], {
      stdio: 'inherit',
    });
  }
}
if (require.main === module) {
  const output = mkdtempSync(join(tmpdir(), 'mcp-knot-publish-'));
  try {
    publishAll(packAll(output));
  } finally {
    rmSync(output, { recursive: true, force: true });
  }
}
module.exports = { alreadyPublished, publishAll };
