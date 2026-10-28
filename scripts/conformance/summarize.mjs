import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// Classify observed failures, not scenario names alone. A later payload/transport
// regression must not be mislabeled as the fixture missing in an older run.
function classify(name, results) {
  const errors = results.filter((r) => r.status === 'FAILURE').map((r) => r.errorMessage ?? '');
  if (errors.some((message) => /MCP error -32602: Tool test_\S+ not found/.test(message))) {
    return 'missing-test-tool';
  }
  if (errors.some((message) => /MCP error -32602: Resource not found: test:\/\//.test(message))) {
    return 'missing-test-resource';
  }
  if (errors.some((message) => /MCP error -32601: Method not found/.test(message))) {
    return 'method-not-found';
  }
  if (name === 'dns-rebinding-protection' && errors.length) return 'host-origin-validation';
  if (
    errors.length === 0 &&
    name === 'server-sse-multiple-streams' &&
    results.some(
      (r) => r.status === 'WARNING' && r.details?.message?.includes('did not provide session ID'),
    )
  ) {
    return 'optional-session-warning';
  }
  return 'unclassified';
}

const checkStatuses = new Set(['SUCCESS', 'FAILURE', 'WARNING', 'INFO']);

export function summarizeReports(reports) {
  if (!reports.length) throw new Error('No conformance reports found');
  const seen = new Set();
  const checks = { passed: 0, failed: 0, warnings: 0, informational: 0 };
  const counts = { passed: 0, failed: 0, warnings: 0, informational: 0 };
  const scenarios = reports.map(({ name, checks: results }) => {
    if (typeof name !== 'string' || !name || seen.has(name)) {
      throw new Error(`Invalid or duplicate scenario: ${name}`);
    }
    seen.add(name);
    if (!Array.isArray(results) || !results.length) {
      throw new Error(`Empty or invalid checks for ${name}`);
    }
    for (const result of results) {
      if (!result || !checkStatuses.has(result.status)) {
        throw new Error(`Invalid check status for ${name}`);
      }
      const key = {
        SUCCESS: 'passed',
        FAILURE: 'failed',
        WARNING: 'warnings',
        INFO: 'informational',
      }[result.status];
      checks[key]++;
    }
    const status = results.some((r) => r.status === 'FAILURE')
      ? 'failed'
      : results.some((r) => r.status === 'WARNING')
        ? 'warnings'
        : results.some((r) => r.status === 'SUCCESS')
          ? 'passed'
          : 'informational';
    counts[status]++;
    return {
      name,
      status,
      category: classify(name, results),
      checks: results,
    };
  });
  return { counts, checks, scenarios: scenarios.toSorted((a, b) => a.name.localeCompare(b.name)) };
}

export async function summarizeDirectory(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const reports = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const match = /^server-(.+)-\d{4}-\d{2}-\d{2}T/.exec(entry.name);
    if (!match) continue;
    const checks = JSON.parse(await readFile(join(directory, entry.name, 'checks.json'), 'utf8'));
    reports.push({ name: match[1], checks });
  }
  return summarizeReports(reports);
}

async function main(directory) {
  if (!directory) throw new Error('Usage: node scripts/conformance/summarize.mjs <results-dir>');
  const report = await summarizeDirectory(directory);
  await writeFile(join(directory, 'summary.json'), JSON.stringify(report, null, 2) + '\n');
  const { passed, failed, warnings, informational } = report.counts;
  process.stdout.write(
    `Conformance scenarios: ${passed} passed, ${failed} failed, ${warnings} warning-only, ${informational} informational.\n`,
  );
  for (const scenario of report.scenarios) {
    if (scenario.status === 'passed' || scenario.status === 'informational') continue;
    process.stdout.write(`  ${scenario.status}: ${scenario.name} [${scenario.category}]\n`);
  }
  // Reporting is independent of acceptance. The caller must keep the original
  // TCK exit status, including any expected-failure/stale-baseline checks.
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv[2]).catch((error) => {
    process.stderr.write(`Conformance report error: ${error.message}\n`);
    process.exitCode = 2;
  });
}
