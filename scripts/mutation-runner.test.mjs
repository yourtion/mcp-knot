import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repository = fileURLToPath(new URL('..', import.meta.url));
const require = createRequire(import.meta.url);
// Exercise the installed, patched runner against real Vitest collection errors.
const runnerEntry = pathToFileURL(require.resolve('@stryker-mutator/vitest-runner'));
const { VitestTestRunner } = await import(new URL('./vitest-test-runner.js', runnerEntry));
const logger = { isDebugEnabled: () => false, warn() {} };

test('mutation runner preserves failures outside individual test tasks', async (t) => {
  const temporaryRoot = path.join(repository, '.stryker-tmp');
  await mkdir(temporaryRoot, { recursive: true });
  const fixture = await mkdtemp(path.join(temporaryRoot, 'runner-regression-'));
  const originalDirectory = process.cwd();
  const originalNodeEnv = process.env.NODE_ENV;
  const originalVitest = process.env.VITEST;
  const originalExitCode = process.exitCode;
  let runner;
  try {
    const reporter = path.join(fixture, 'quiet-reporter.mjs');
    await writeFile(reporter, 'export default class {}\n');
    await writeFile(
      path.join(fixture, 'vitest.config.mjs'),
      `export default { test: { root: ${JSON.stringify(fixture)}, include: ['*.test.mjs'], reporters: [${JSON.stringify(reporter)}] } };`,
    );
    await writeFile(
      path.join(fixture, 'subject.mjs'),
      `const mutant = globalThis.__stryker__?.activeMutant;
if (mutant === 'import-error') throw new Error('mutant broke module initialization');
export const answer = mutant === 'assertion-error' ? 41 : 42;
`,
    );
    await writeFile(
      path.join(fixture, 'subject.test.mjs'),
      `import { test, expect } from 'vitest';
import { answer } from './subject.mjs';
test('answer is correct', () => expect(answer).toBe(42));
test('serialized errors remain reportable', () => {
  if (globalThis.__stryker__?.activeMutant === 'unhandled-error') {
    process.emit('unhandledRejection', Object.assign(Object.create(null), { message: 'serialized rejection' }));
  }
});
`,
    );
    await writeFile(
      path.join(fixture, 'unrelated.test.mjs'),
      `import { test, expect } from 'vitest';
test('unrelated test still passes', () => expect(true).toBe(true));
`,
    );
    process.chdir(fixture);
    const createRunner = () =>
      new VitestTestRunner(
        { vitest: { configFile: path.join(fixture, 'vitest.config.mjs'), related: false } },
        logger,
        '__stryker__',
      );
    runner = createRunner();
    await runner.init();
    const dryRunOptions = { coverageAnalysis: 'perTest', timeout: 30000, disableBail: false };
    const mutantRun = (id) =>
      runner.mutantRun({
        activeMutant: { id },
        mutantActivation: 'static',
        reloadEnvironment: true,
        sandboxFileName: path.join(fixture, 'subject.mjs'),
        timeout: 30000,
        disableBail: false,
      });

    await t.test('healthy baseline executes all tests', async () => {
      const result = await runner.dryRun(dryRunOptions);
      assert.equal(result.status, 'complete');
      assert.equal(result.tests.length, 3);
    });
    await t.test('import failure cannot survive alongside passing tests', async () => {
      const result = await mutantRun('import-error');
      assert.equal(result.status, 'error');
      assert.match(result.errorMessage, /mutant broke module initialization/);
    });
    await t.test('serialized unhandled rejection cannot crash error formatting', async () => {
      const result = await mutantRun('unhandled-error');
      assert.equal(result.status, 'error');
      assert.match(result.errorMessage, /serialized rejection/);
    });
    await t.test('ordinary assertion failures still kill mutants', async () => {
      const result = await mutantRun('assertion-error');
      assert.equal(result.status, 'killed');
      assert.ok(result.killedBy.length > 0);
    });
    await t.test('a clean run after errors still executes and survives', async () => {
      const result = await mutantRun('unchanged');
      assert.equal(result.status, 'survived');
      assert.equal(result.nrOfTests, 3);
    });
    await t.test('broken baseline fails before mutation testing', async () => {
      await runner.dispose();
      await writeFile(path.join(fixture, 'subject.mjs'), "throw new Error('broken baseline');\n");
      runner = createRunner();
      await runner.init();
      const result = await runner.dryRun(dryRunOptions);
      assert.equal(result.status, 'error');
      assert.match(result.errorMessage, /broken baseline/);
    });
  } finally {
    await runner?.dispose();
    process.chdir(originalDirectory);
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
    if (originalVitest === undefined) delete process.env.VITEST;
    else process.env.VITEST = originalVitest;
    // The deliberately failing embedded Vitest runs set the host's exit code.
    process.exitCode = originalExitCode;
    await rm(fixture, { recursive: true, force: true });
  }
});
