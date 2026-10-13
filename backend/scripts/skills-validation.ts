/** Standalone phase-0 harness; source management and production group wiring follow later. */
import { serve } from '@hono/node-server';
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { Hono } from 'hono';
import { parseArgs } from 'node:util';
import { z } from 'zod/v4';

import {
  loadLocalSkillSnapshot,
  registerSkills,
  SkillCatalog,
} from '../../packages/core/src/skills/index.js';

const { values } = parseArgs({
  options: {
    directory: { type: 'string', multiple: true },
    transport: { type: 'string', default: 'stdio' },
    port: { type: 'string', default: '8182' },
  },
});
if (!values.directory?.length || !['stdio', 'http'].includes(values.transport!)) {
  process.stderr.write(
    'Usage: --directory <skill-root> [--directory <skill-root>] --transport stdio|http [--port 8182]\n',
  );
  process.exit(1);
}
const port = Number(values.port);
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  process.stderr.write('Port must be an integer between 0 and 65535 (0 selects a free port)\n');
  process.exit(1);
}
const snapshots = await Promise.all(
  values.directory.map((directory, index) =>
    loadLocalSkillSnapshot(directory, `validation/source-${index + 1}`),
  ),
);
const catalog = new SkillCatalog(snapshots, 'validation');

function buildServer(): McpServer {
  const server = new McpServer({ name: 'mcp-knot-skills-validation', version: '0.0.1' });
  server.registerTool(
    'echo',
    { inputSchema: z.object({ message: z.string() }) },
    async ({ message }) => ({
      content: [{ type: 'text', text: message }],
    }),
  );
  server.registerResource(
    'hub_version',
    'hub://version',
    { mimeType: 'application/json' },
    async () => ({
      contents: [{ uri: 'hub://version', mimeType: 'application/json', text: '{"phase":0}' }],
    }),
  );
  registerSkills(server, catalog, 1);
  return server;
}

if (values.transport === 'stdio') {
  serveStdio(buildServer, { legacy: 'reject' });
} else {
  const handler = createMcpHandler(buildServer, { legacy: 'reject', responseMode: 'json' });
  const app = new Hono().all('/mcp', (context) => handler.fetch(context.req.raw));
  const listener = serve({ fetch: app.fetch, hostname: '127.0.0.1', port }, (address) => {
    process.stderr.write(`Skills validation MCP endpoint: http://127.0.0.1:${address.port}/mcp\n`);
  });
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => listener.close());
  }
}
