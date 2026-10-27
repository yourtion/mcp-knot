import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

import { fixtureResults, fixtureToolNames, loadBackendDependency } from './tool-fixtures.mjs';

const { Client, StreamableHTTPClientTransport } = await loadBackendDependency(
  '@modelcontextprotocol/client',
);
const { StdioClientTransport } = await loadBackendDependency('@modelcontextprotocol/client/stdio');
const endpoint = process.argv[2];
if (!endpoint) throw new Error('Usage: node scripts/conformance/verify-tools.mjs <Hub MCP URL>');

for (const era of ['legacy', 'modern']) {
  const client = new Client(
    { name: 'hub-fixture-routing-check', version: '1.0.0' },
    { versionNegotiation: { mode: era === 'legacy' ? 'legacy' : { pin: '2026-07-28' } } },
  );
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(endpoint)));
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    for (const name of fixtureToolNames) {
      assert(names.includes(`test_${name}`), `Hub did not publish namespaced tool test_${name}`);
      assert(!names.includes(name), `Unexpected unprefixed Hub tool: ${name}`);
    }
    for (const [name, expected] of Object.entries(fixtureResults)) {
      const actual = await client.callTool({ name: `test_${name}`, arguments: {} });
      assert.deepEqual(actual.content, expected.content, `${era}: ${name} content changed`);
      assert.equal(!!actual.isError, !!expected.isError, `${era}: ${name} error state changed`);
    }
    console.log(
      `Hub fixture routing (${era}): 7 namespaced tools, 6 contents/error results passed.`,
    );
  } finally {
    await client.close();
  }
}

// A positive direct-upstream control keeps a broken progress fixture from being
// confused with the Hub's known missing progress relay. Official TCK tests the
// Hub path separately and must still report its actual progress failure.
const direct = new Client(
  { name: 'progress-fixture-control', version: '1.0.0' },
  { versionNegotiation: { mode: { pin: '2026-07-28' } } },
);
try {
  await direct.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [fileURLToPath(new URL('./tool-fixtures.mjs', import.meta.url)), 'serve'],
    }),
  );
  const progress = [];
  await direct.callTool(
    { name: 'tool_with_progress', arguments: {} },
    { onprogress: (value) => progress.push(value) },
  );
  assert.deepEqual(
    progress.map(({ progress, total }) => ({ progress, total })),
    [0, 50, 100].map((progress) => ({ progress, total: 100 })),
  );
  console.log('Direct fixture control: 3 progress notifications passed.');
} finally {
  await direct.close();
}
