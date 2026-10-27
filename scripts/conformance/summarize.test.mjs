import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { summarizeDirectory, summarizeReports } from './summarize.mjs';

test('distinguishes failed, warning-only and successful scenarios and checks', () => {
  const report = summarizeReports([
    { name: 'tools-list', checks: [{ status: 'SUCCESS' }] },
    {
      name: 'dns-rebinding-protection',
      checks: [{ status: 'SUCCESS' }, { status: 'FAILURE', errorMessage: 'invalid host accepted' }],
    },
    {
      name: 'server-sse-multiple-streams',
      checks: [{ status: 'WARNING', details: { message: 'Server did not provide session ID' } }],
    },
    { name: 'future-info', checks: [{ status: 'INFO' }] },
  ]);
  assert.deepEqual(report.counts, { passed: 1, failed: 1, warnings: 1, informational: 1 });
  assert.deepEqual(report.checks, { passed: 2, failed: 1, warnings: 1, informational: 1 });
  assert.equal(report.scenarios[0].status, 'failed');
  assert.equal(report.scenarios[0].checks[1].errorMessage, 'invalid host accepted');
  assert.equal(report.scenarios.find((s) => s.name === 'future-info').category, 'unclassified');
  assert.equal(
    report.scenarios.find((s) => s.name === 'server-sse-multiple-streams').category,
    'optional-session-warning',
  );
});

test('diagnostic category cannot turn a failure or warning into a pass', () => {
  const report = summarizeReports([
    { name: 'tools-call-image', checks: [{ status: 'FAILURE' }] },
    {
      name: 'server-sse-multiple-streams',
      checks: [
        { status: 'FAILURE', errorMessage: 'GROUP_NOT_FOUND during concurrent requests' },
        { status: 'WARNING', details: { message: 'Server did not provide session ID' } },
      ],
    },
    { name: 'unknown-new-scenario', checks: [{ status: 'FAILURE' }] },
  ]);
  assert.equal(report.counts.failed, 3);
  assert.equal(report.counts.passed, 0);
  assert.equal(report.counts.warnings, 0);
  assert.equal(
    report.scenarios.find((s) => s.name === 'server-sse-multiple-streams').category,
    'unclassified',
  );
});

test('classifies actual errors without labeling later payload failures as missing fixtures', () => {
  const report = (errorMessage) =>
    summarizeReports([{ name: 'tools-call-image', checks: [{ status: 'FAILURE', errorMessage }] }])
      .scenarios[0];
  assert.equal(
    report('Failed: MCP error -32602: Tool test_image_content not found').category,
    'missing-test-tool',
  );
  assert.equal(report('Image data is invalid').category, 'unclassified');
  assert.equal(report('Failed: MCP error -32601: Method not found').category, 'method-not-found');
});

test('rejects missing, duplicate, empty and malformed reports', () => {
  for (const reports of [
    [],
    [{ name: 'test', checks: [] }],
    [{ name: 'test', checks: [{ status: 'SKIPPED' }] }],
    [{ name: 'test', checks: [null] }],
    [{ name: '', checks: [{ status: 'SUCCESS' }] }],
    [
      { name: 'test', checks: [{ status: 'SUCCESS' }] },
      { name: 'test', checks: [{ status: 'SUCCESS' }] },
    ],
  ]) {
    assert.throws(() => summarizeReports(reports));
  }
});

test('reads real directory layout, preserves hyphenated names and ignores unrelated files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'conformance-summary-'));
  try {
    const folder = join(root, 'server-tools-call-image-2026-10-27T12-43-36-850Z');
    await mkdir(folder);
    await writeFile(join(folder, 'checks.json'), JSON.stringify([{ status: 'FAILURE' }]));
    await writeFile(join(root, 'summary.json'), '{}');
    const report = await summarizeDirectory(root);
    assert.equal(report.scenarios[0].name, 'tools-call-image');
    assert.equal(report.counts.failed, 1);
    await rm(join(folder, 'checks.json'));
    await assert.rejects(summarizeDirectory(root));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
