const { readFileSync, writeFileSync } = require('node:fs');
const { resolve } = require('node:path');
const { isDeepStrictEqual } = require('node:util');
const { versionFiles, run, git, nextVersion, checkVersions } = require('./release-common.cjs');

process.chdir(resolve(__dirname, '..'));
const message = (version) => `chore: release v${version}`;
function cleanMain() {
  if (git('branch', '--show-current') !== 'main') throw new Error('Release requires main branch');
  if (git('status', '--porcelain', '--untracked-files=all'))
    throw new Error('Working tree must be clean');
}
function checkCommit(version, requireTag = true) {
  if (git('log', '-1', '--format=%B') !== message(version))
    throw new Error('HEAD is not the release commit');
  const parents = git('rev-list', '--parents', '-n', '1', 'HEAD').split(' ');
  if (parents.length !== 2) throw new Error('Release commit must have exactly one parent');
  const changed = git('diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD')
    .split('\n')
    .toSorted();
  if (!isDeepStrictEqual(changed, [...versionFiles].toSorted()))
    throw new Error('Unexpected release commit files');
  for (const file of versionFiles) {
    const before = JSON.parse(git('show', `HEAD^:${file}`));
    const after = JSON.parse(git('show', `HEAD:${file}`));
    nextVersion(before.version, version);
    before.version = version;
    if (!isDeepStrictEqual(before, after)) throw new Error(`Non-version changes in ${file}`);
  }
  if (
    requireTag &&
    git('rev-parse', `refs/tags/v${version}^{commit}`) !== git('rev-parse', 'HEAD')
  ) {
    throw new Error('Release tag must point to HEAD');
  }
}
function main() {
  const [command, input, ...extra] = process.argv.slice(2);
  if (
    extra.length ||
    !['prepare', 'push', 'check'].includes(command) ||
    (command !== 'prepare' && command !== 'check' && input)
  ) {
    throw new Error('Usage: release.cjs prepare patch|minor|major|X.Y.Z | push | check vX.Y.Z');
  }
  if (command === 'check') {
    if (!input) throw new Error('Expected release tag');
    checkVersions(input);
    checkCommit(input.slice(1));
    return;
  }
  cleanMain();
  const current = checkVersions();
  if (command === 'push') {
    checkCommit(current);
    // Atomic, explicit refs; never push unrelated tags or partially publish refs.
    run(
      'git',
      [
        'push',
        '--atomic',
        '--no-follow-tags',
        'origin',
        'refs/heads/main:refs/heads/main',
        `refs/tags/v${current}:refs/tags/v${current}`,
      ],
      { stdio: 'inherit' },
    );
    return;
  }
  const next = nextVersion(current, input);
  const tag = `v${next}`;
  if (git('tag', '--list', tag)) throw new Error(`Tag already exists: ${tag}`);
  // Network/auth failures propagate. Do not silently treat an unavailable remote as empty.
  if (git('ls-remote', '--tags', 'origin', `refs/tags/${tag}`))
    throw new Error(`Remote tag already exists: ${tag}`);
  const originals = new Map(versionFiles.map((file) => [file, readFileSync(file, 'utf8')]));
  try {
    for (const [file, text] of originals) {
      const pkg = JSON.parse(text);
      pkg.version = next;
      writeFileSync(file, `${JSON.stringify(pkg, null, 2)}\n`);
    }
    run('pnpm', ['run', 'release:validate'], { stdio: 'inherit' });
    checkVersions(tag);
    const changes = git('diff', '--name-only').split('\n');
    if (
      changes.some((file) => !versionFiles.includes(file)) ||
      git('diff', '--cached', '--name-only') ||
      git('ls-files', '--others', '--exclude-standard')
    ) {
      throw new Error('Validation changed unexpected files; inspect working tree');
    }
  } catch (error) {
    for (const [file, text] of originals) writeFileSync(file, text);
    throw error;
  }
  git('add', '--', ...versionFiles);
  run('git', ['commit', '-m', message(next), '--only', '--', ...versionFiles], {
    stdio: 'inherit',
  });
  cleanMain();
  checkVersions(tag);
  checkCommit(next, false);
  git('tag', '-a', tag, '-m', message(next));
  console.log(`Prepared ${tag}. Review the commit and tag, then run pnpm run release:push.`);
}
try {
  main();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
