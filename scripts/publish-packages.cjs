const { execFileSync } = require('node:child_process');
const { mkdtempSync, readFileSync, readdirSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');

// pnpm packs workspace dependencies into registry versions; npm 11 publishes
// those tarballs using GitHub Actions OIDC instead of pnpm 10's token auth.
const registry = 'https://registry.npmjs.org/';
const output = mkdtempSync(join(tmpdir(), 'mcp-knot-publish-'));
try {
  for (const directory of ['share', 'protocol', 'core', 'cli']) {
    const cwd = resolve('packages', directory);
    const pkg = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8'));
    let versions;
    try {
      versions = JSON.parse(
        execFileSync('npm', ['view', pkg.name, 'versions', '--json', `--registry=${registry}`], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
        }),
      );
    } catch (error) {
      let response;
      try {
        response = JSON.parse(error.stdout?.toString() || error.stderr?.toString());
      } catch {
        throw error;
      }
      if (response.error?.code !== 'E404') throw error;
      throw new Error(
        `${pkg.name} does not exist on npm. Create its first version with an interactive npm login, then configure its Trusted Publisher for publish.yml.`,
        { cause: error },
      );
    }
    if ((Array.isArray(versions) ? versions : [versions]).includes(pkg.version)) {
      console.log(`Skipping ${pkg.name}@${pkg.version}: already published.`);
      continue;
    }
    const destination = join(output, directory);
    execFileSync('pnpm', ['pack', '--pack-destination', destination], { cwd, stdio: 'inherit' });
    const tarball = join(
      destination,
      readdirSync(destination).find((file) => file.endsWith('.tgz')),
    );
    execFileSync('npm', ['publish', tarball, '--access', 'public', `--registry=${registry}`], {
      stdio: 'inherit',
    });
    const tag = `${pkg.name}@${pkg.version}`;
    execFileSync('git', ['tag', tag], { stdio: 'inherit' });
    // changesets/action recognizes this output and pushes package tags/releases.
    console.log(`New tag: ${tag}`);
  }
} finally {
  rmSync(output, { recursive: true, force: true });
}
