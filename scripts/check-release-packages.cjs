const { execFileSync } = require('node:child_process');
const { mkdtempSync, readdirSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');

const output = mkdtempSync(join(tmpdir(), 'mcp-knot-pack-'));
try {
  for (const directory of ['share', 'protocol', 'core', 'cli']) {
    const destination = join(output, directory);
    execFileSync('pnpm', ['pack', '--pack-destination', destination], {
      cwd: resolve('packages', directory),
      stdio: 'pipe',
    });
    const tarball = join(
      destination,
      readdirSync(destination).find((file) => file.endsWith('.tgz')),
    );
    const entries = execFileSync('tar', ['-tzf', tarball], { encoding: 'utf8' }).trim().split('\n');
    const pkg = JSON.parse(
      execFileSync('tar', ['-xOzf', tarball, 'package/package.json'], { encoding: 'utf8' }),
    );
    for (const target of [pkg.main, pkg.types, ...Object.values(pkg.bin || {})]) {
      if (!entries.includes(`package/${target.replace(/^\.\//, '')}`)) {
        throw new Error(`${pkg.name}: missing published entry ${target}`);
      }
    }
    if (Object.values(pkg.dependencies || {}).some((version) => version.startsWith('workspace:'))) {
      throw new Error(`${pkg.name}: unresolved workspace dependency in tarball`);
    }
    if (entries.some((file) => /\.(test|spec)\.[cm]?js$/.test(file))) {
      throw new Error(`${pkg.name}: test files included in tarball`);
    }
    console.log(
      `Validated ${pkg.name}@${pkg.version}: package entries and dependencies are ready to publish.`,
    );
  }
} finally {
  rmSync(output, { recursive: true, force: true });
}
