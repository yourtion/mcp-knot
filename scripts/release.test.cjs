const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('node:child_process');
const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, cpSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { nextVersion, versionFiles } = require('./release-common.cjs');
const { alreadyPublished, publishAll } = require('./publish-packages.cjs');
const { validateManifest } = require('./release-packages.cjs');
const source = __dirname;
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'knot-release-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cwd = join(root, 'repo');
  mkdirSync(cwd);
  const git = (...args) =>
    execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-b', 'main');
  git('config', 'user.name', 'Release Test');
  git('config', 'user.email', 'release@example.invalid');
  execFileSync('git', ['init', '--bare', join(root, 'remote.git')], { stdio: 'ignore' });
  git('remote', 'add', 'origin', join(root, 'remote.git'));
  mkdirSync(join(cwd, 'scripts'));
  for (const name of ['release.cjs', 'release-common.cjs'])
    cpSync(join(source, name), join(cwd, 'scripts', name));
  for (const file of versionFiles) {
    mkdirSync(join(cwd, file, '..'), { recursive: true });
    writeFileSync(
      join(cwd, file),
      JSON.stringify({ name: file, version: '1.2.3' }, null, 2) + '\n',
    );
  }
  git('add', '.');
  git('commit', '-m', 'initial');
  const bin = join(root, 'bin');
  mkdirSync(bin);
  // This stub replaces only expensive validation. Git operations use real local repositories.
  writeFileSync(
    join(bin, 'pnpm'),
    '#!/bin/sh\n[ "$*" = "run release:validate" ] || exit 9\nexit "${VALIDATION_EXIT:-0}"\n',
    { mode: 0o755 },
  );
  const call = (...args) =>
    spawnSync(process.execPath, [join(cwd, 'scripts/release.cjs'), ...args], {
      cwd,
      encoding: 'utf8',
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
    });
  return { cwd, git, call, root, bin };
}
function ok(result) {
  assert.equal(result.status, 0, result.stderr || result.stdout);
}
function fails(result, pattern) {
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, pattern);
}

test('stable incremental versions', () => {
  assert.equal(nextVersion('1.2.3', 'patch'), '1.2.4');
  assert.equal(nextVersion('1.2.3', 'minor'), '1.3.0');
  assert.equal(nextVersion('1.2.3', 'major'), '2.0.0');
  assert.equal(nextVersion('1.2.3', '2.4.6'), '2.4.6');
  for (const value of ['1.2.3', '0.9.9', '01.2.4', 'v2.0.0', '2.0.0-rc.1', '2.0', undefined]) {
    assert.throws(() => nextVersion('1.2.3', value));
  }
});
test('prepare commits only version files, tag follows commit, push sends exact refs', (t) => {
  const { git, call } = fixture(t);
  ok(call('prepare', 'minor'));
  assert.equal(git('log', '-1', '--format=%s'), 'chore: release v1.3.0');
  assert.equal(git('rev-parse', 'HEAD'), git('rev-parse', 'v1.3.0^{commit}'));
  assert.deepEqual(
    git('diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD').split('\n').toSorted(),
    [...versionFiles].toSorted(),
  );
  assert.equal(git('status', '--porcelain'), '');
  assert.equal(git('ls-remote', '--tags', 'origin'), '');
  git('tag', '-a', 'unrelated', '-m', 'unrelated');
  git('config', 'push.followTags', 'true');
  ok(call('check', 'v1.3.0'));
  ok(call('push'));
  ok(call('push'));
  assert.match(git('ls-remote', 'origin', 'refs/heads/main'), /refs\/heads\/main/);
  assert.match(git('ls-remote', '--tags', 'origin'), /refs\/tags\/v1.3.0/);
  assert.doesNotMatch(git('ls-remote', '--tags', 'origin'), /unrelated/);
});
test('dirty tracked, staged and untracked files block preparation', (t) => {
  const { cwd, git, call } = fixture(t);
  writeFileSync(join(cwd, 'extra'), 'dirty');
  fails(call('prepare', 'patch'), /clean/);
  git('add', 'extra');
  fails(call('prepare', 'patch'), /clean/);
  git('commit', '-m', 'extra');
  writeFileSync(join(cwd, 'extra'), 'changed');
  fails(call('prepare', 'patch'), /clean/);
});
test('wrong branch and detached HEAD block preparation and push', (t) => {
  const { git, call } = fixture(t);
  git('checkout', '-b', 'feature');
  fails(call('prepare', 'patch'), /main/);
  fails(call('push'), /main/);
  git('checkout', '--detach');
  fails(call('prepare', 'patch'), /main/);
});
test('mismatched versions, invalid target and tag mismatch are rejected', (t) => {
  const { cwd, git, call } = fixture(t);
  fails(call('prepare', '1.2.3'), /increase/);
  fails(call('prepare', 'v2.0.0'), /Invalid/);
  fails(call('check', 'v9.0.0'), /does not match/);
  const file = join(cwd, versionFiles[0]);
  writeFileSync(file, readFileSync(file, 'utf8').replace('1.2.3', '1.2.4'));
  git('add', '.');
  git('commit', '-m', 'mismatch');
  fails(call('prepare', 'patch'), /must match/);
});
test('duplicate local and remote tags and unreachable remote stop before edits', (t) => {
  const { git, call } = fixture(t);
  git('tag', 'v1.2.4');
  fails(call('prepare', 'patch'), /already exists/);
  git('push', 'origin', 'refs/tags/v1.2.4');
  git('tag', '-d', 'v1.2.4');
  fails(call('prepare', 'patch'), /Remote tag already exists/);
  git('remote', 'set-url', 'origin', '/nonexistent/knot-release.git');
  fails(call('prepare', 'patch'), /ls-remote/);
  assert.equal(git('status', '--porcelain'), '');
});
test('failed validation restores versions without commit or tag', (t) => {
  const { bin, git, call } = fixture(t);
  const head = git('rev-parse', 'HEAD');
  writeFileSync(join(bin, 'pnpm'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  fails(call('prepare', 'patch'), /release:validate/);
  assert.equal(git('rev-parse', 'HEAD'), head);
  assert.equal(git('tag'), '');
  assert.equal(git('status', '--porcelain'), '');
});
test('push rejects non-release commit, missing or moved tag, dirty tree', (t) => {
  const { cwd, git, call } = fixture(t);
  fails(call('push'), /release commit/);
  ok(call('prepare', 'patch'));
  git('tag', '-d', 'v1.2.4');
  fails(call('push'), /rev-parse/);
  git('tag', 'v1.2.4', 'HEAD^');
  fails(call('push'), /point to HEAD/);
  git('tag', '-f', 'v1.2.4', 'HEAD');
  writeFileSync(join(cwd, 'extra'), 'dirty');
  fails(call('push'), /clean/);
});
test('push rejects release commit with unrelated changes', (t) => {
  const { cwd, git, call } = fixture(t);
  ok(call('prepare', 'patch'));
  writeFileSync(join(cwd, 'extra'), 'unexpected');
  git('add', '.');
  git('commit', '--amend', '--no-edit');
  git('tag', '-f', 'v1.2.4', 'HEAD');
  fails(call('push'), /Unexpected release commit files/);
});
const pkg = { name: '@mcp-core/test', version: '1.2.3' };
function registryError(code, field = 'stdout') {
  const error = new Error(code);
  error[field] = JSON.stringify({ error: { code } });
  return error;
}
test('registry exact match and first-publish E404, errors fail closed', () => {
  assert.equal(
    alreadyPublished(pkg, () => '"1.2.3"'),
    true,
  );
  for (const field of ['stdout', 'stderr'])
    assert.equal(
      alreadyPublished(pkg, () => {
        throw registryError('E404', field);
      }),
      false,
    );
  for (const code of ['E401', 'E403', 'E500', 'ENOTFOUND', 'ETIMEDOUT']) {
    assert.throws(
      () =>
        alreadyPublished(pkg, () => {
          throw registryError(code);
        }),
      new RegExp(code),
    );
  }
  assert.throws(() => alreadyPublished(pkg, () => '"1.2.4"'), /Unexpected/);
  assert.throws(() => alreadyPublished(pkg, () => 'not json'));
});
test('partial publication skips exact versions and preserves order; failure stops later packages', () => {
  const artifacts = ['share', 'protocol', 'core', 'cli'].map((name) => ({
    pkg: { ...pkg, name },
    tarball: `${name}.tgz`,
  }));
  const published = [];
  const execute = (_, args) => {
    if (args[0] === 'view') {
      assert.match(args[1], /@1\.2\.3$/);
      if (args[1].startsWith('share@')) return '"1.2.3"';
      throw registryError('E404');
    }
    published.push(args[1]);
  };
  publishAll(artifacts, execute);
  assert.deepEqual(published, ['protocol.tgz', 'core.tgz', 'cli.tgz']);
  const attempted = [];
  assert.throws(
    () =>
      publishAll(artifacts, (command, args) => {
        if (args[0] === 'publish') {
          attempted.push(args[1]);
          throw new Error('publish denied');
        }
        return execute(command, args);
      }),
    /publish denied/,
  );
  assert.deepEqual(attempted, ['protocol.tgz']);
});
test('artifact checks reject missing exports, workspace versions and leaked tests', () => {
  const manifest = { ...pkg, main: 'dist/index.js', exports: { './extra': './dist/extra.js' } };
  assert.throws(
    () => validateManifest(manifest, ['package/dist/index.js'], manifest, []),
    /missing published entry/,
  );
  const simple = { ...pkg, main: 'dist/index.js' };
  for (const field of [
    'dependencies',
    'optionalDependencies',
    'peerDependencies',
    'devDependencies',
  ]) {
    assert.throws(
      () =>
        validateManifest(
          { ...simple, [field]: { other: 'workspace:*' } },
          ['package/dist/index.js'],
          simple,
          [],
        ),
      /workspace/,
    );
  }
  assert.throws(
    () =>
      validateManifest(simple, ['package/dist/index.js', 'package/dist/foo.test.js'], simple, []),
    /test files/,
  );
});

test('atomic push rejection leaves remote release tag absent', (t) => {
  const { git, call } = fixture(t);
  ok(call('prepare', 'patch'));
  const remoteCommit = git('commit-tree', 'HEAD^{tree}', '-p', 'HEAD^', '-m', 'remote change');
  git('push', 'origin', `${remoteCommit}:refs/heads/main`);
  fails(call('push'), /failed to push|rejected/);
  assert.equal(git('ls-remote', '--tags', 'origin'), '');
  assert.equal(git('ls-remote', 'origin', 'refs/heads/main').split('\t')[0], remoteCommit);
});
test('unexpected validation files are retained for review without release refs', (t) => {
  const { cwd, bin, git, call } = fixture(t);
  writeFileSync(join(bin, 'pnpm'), '#!/bin/sh\nprintf unexpected > unexpected.txt\n', {
    mode: 0o755,
  });
  fails(call('prepare', 'patch'), /unexpected files/);
  assert.equal(readFileSync(join(cwd, 'unexpected.txt'), 'utf8'), 'unexpected');
  assert.equal(git('tag'), '');
  assert.equal(git('diff'), '');
  assert.equal(git('log', '-1', '--format=%s'), 'initial');
});
test('push rejects non-version changes inside an allowed manifest', (t) => {
  const { cwd, git, call } = fixture(t);
  ok(call('prepare', 'patch'));
  const file = join(cwd, versionFiles[0]);
  const manifest = JSON.parse(readFileSync(file, 'utf8'));
  manifest.description = 'unexpected';
  writeFileSync(file, JSON.stringify(manifest));
  git('add', '.');
  git('commit', '--amend', '--no-edit');
  git('tag', '-f', 'v1.2.4', 'HEAD');
  fails(call('push'), /Non-version changes/);
});
test('fully published release performs no publish and registry errors stop the sequence', () => {
  const artifacts = ['share', 'protocol', 'core', 'cli'].map((name) => ({
    pkg: { ...pkg, name },
    tarball: `${name}.tgz`,
  }));
  let reads = 0;
  publishAll(artifacts, (_, args) => {
    assert.equal(args[0], 'view');
    reads++;
    return '"1.2.3"';
  });
  assert.equal(reads, 4);
  reads = 0;
  assert.throws(
    () =>
      publishAll(artifacts, (_, args) => {
        assert.equal(args[0], 'view');
        reads++;
        throw registryError('E401');
      }),
    /E401/,
  );
  assert.equal(reads, 1);
});
