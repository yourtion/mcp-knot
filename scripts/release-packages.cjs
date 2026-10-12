const { execFileSync } = require('node:child_process');
const { mkdirSync, readdirSync, symlinkSync } = require('node:fs');
const { join, resolve, dirname } = require('node:path');
const { pathToFileURL } = require('node:url');
const { directories, readPackage, checkVersions, run } = require('./release-common.cjs');

function exportTargets(value) {
  if (typeof value === 'string') return [value];
  return Object.values(value || {}).flatMap(exportTargets);
}
function validateManifest(pkg, entries, source, packages) {
  if (pkg.name !== source.name || pkg.version !== source.version)
    throw new Error('Packed identity mismatch');
  const bin = typeof pkg.bin === 'string' ? [pkg.bin] : Object.values(pkg.bin || {});
  for (const target of [pkg.main, pkg.types, ...bin, ...exportTargets(pkg.exports)].filter(
    Boolean,
  )) {
    if (!entries.includes(`package/${target.replace(/^\.\//, '')}`)) {
      throw new Error(`${pkg.name}: missing published entry ${target}`);
    }
  }
  for (const field of [
    'dependencies',
    'optionalDependencies',
    'peerDependencies',
    'devDependencies',
  ]) {
    for (const [name, version] of Object.entries(pkg[field] || {})) {
      if (version.startsWith('workspace:'))
        throw new Error(`${pkg.name}: unresolved workspace dependency`);
      if (packages.some((item) => item.name === name) && version !== pkg.version) {
        throw new Error(`${pkg.name}: internal dependency ${name} must equal ${pkg.version}`);
      }
    }
  }
  if (entries.some((file) => /\.(test|spec)\.[cm]?js$|\/(?:__tests__|mocks)\//.test(file))) {
    throw new Error(`${pkg.name}: test files included in tarball`);
  }
}
function packAll(output) {
  checkVersions();
  const packages = directories.map((dir) => readPackage(`packages/${dir}/package.json`));
  const artifacts = directories.map((directory, i) => {
    const destination = join(output, directory);
    execFileSync('pnpm', ['pack', '--pack-destination', destination], {
      cwd: resolve('packages', directory),
      stdio: 'pipe',
    });
    const files = readdirSync(destination).filter((file) => file.endsWith('.tgz'));
    if (files.length !== 1) throw new Error('Expected exactly one tarball');
    const tarball = join(destination, files[0]);
    const entries = run('tar', ['-tzf', tarball]).split('\n');
    const pkg = JSON.parse(run('tar', ['-xOzf', tarball, 'package/package.json']));
    validateManifest(pkg, entries, packages[i], packages);
    const extracted = join(output, 'node_modules', pkg.name);
    mkdirSync(extracted, { recursive: true });
    run('tar', ['-xzf', tarball, '--strip-components=1', '-C', extracted]);
    return { pkg, tarball, extracted, directory };
  });
  // Only external dependencies are borrowed from the installed lockfile. Internal
  // packages resolve to extracted tarballs, never workspace source or dist links.
  for (const { pkg, directory, extracted } of artifacts) {
    for (const name of Object.keys(pkg.dependencies || {})) {
      if (packages.some((item) => item.name === name)) continue;
      const target = join(extracted, 'node_modules', name);
      mkdirSync(dirname(target), { recursive: true });
      symlinkSync(resolve('packages', directory, 'node_modules', name), target, 'dir');
    }
    for (const target of new Set(
      [pkg.main, ...exportTargets(pkg.exports)].filter((value) => value?.endsWith('.js')),
    )) {
      run(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          `await import(${JSON.stringify(pathToFileURL(join(extracted, target)).href)})`,
        ],
        { timeout: 30000 },
      );
    }
    if (directory === 'cli') {
      const output = run(process.execPath, [join(extracted, pkg.bin['mcp-knot']), '--version'], {
        timeout: 30000,
      });
      if (!output.split('\n').includes(`MCP Knot CLI v${pkg.version}`))
        throw new Error(`CLI version mismatch: ${output}`);
      run(process.execPath, [join(extracted, pkg.bin['mcp-knot']), '--help'], { timeout: 30000 });
    }
    console.log(
      `Validated ${pkg.name}@${pkg.version}: tarball entries, dependencies and runtime imports.`,
    );
  }
  return artifacts;
}
module.exports = { packAll, validateManifest };
