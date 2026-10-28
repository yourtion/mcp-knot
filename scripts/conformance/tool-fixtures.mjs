import { createRequire } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

// Resolve workspace dependencies without adding test servers to production builds.
const require = createRequire(new URL('../../backend/package.json', import.meta.url));
export const loadBackendDependency = (name) => import(pathToFileURL(require.resolve(name)).href);
const { McpServer } = await loadBackendDependency('@modelcontextprotocol/server');
const { serveStdio } = await loadBackendDependency('@modelcontextprotocol/server/stdio');
const { z } = await loadBackendDependency('zod/v4');

const image = {
  type: 'image',
  mimeType: 'image/png',
  data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aE2kAAAAASUVORK5CYII=',
};

// Names intentionally omit test_: server ID "test" gives the real Hub names
// test_simple_text, etc. No aliases or changes to production tool naming.
export const fixtureResults = {
  simple_text: { content: [{ type: 'text', text: 'This is a simple text response for testing.' }] },
  image_content: { content: [image] },
  audio_content: {
    content: [
      {
        type: 'audio',
        mimeType: 'audio/wav',
        data: 'UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=',
      },
    ],
  },
  embedded_resource: {
    content: [
      {
        type: 'resource',
        resource: {
          uri: 'test://embedded-resource',
          mimeType: 'text/plain',
          text: 'This is an embedded resource content.',
        },
      },
    ],
  },
  multiple_content_types: {
    content: [
      { type: 'text', text: 'Multiple content types test:' },
      image,
      {
        type: 'resource',
        resource: {
          uri: 'test://mixed-content-resource',
          mimeType: 'application/json',
          text: JSON.stringify({ test: 'data', value: 123 }),
        },
      },
    ],
  },
  error_handling: {
    isError: true,
    content: [{ type: 'text', text: 'This tool intentionally returns an error for testing' }],
  },
};

export const fixtureToolNames = [...Object.keys(fixtureResults), 'tool_with_progress'];

function createFixtureServer() {
  const server = new McpServer({ name: 'conformance-tool-fixtures', version: '1.0.0' });
  for (const [name, result] of Object.entries(fixtureResults)) {
    server.registerTool(
      name,
      { description: `Isolated conformance fixture: ${name}`, inputSchema: z.object({}) },
      async () => structuredClone(result),
    );
  }
  server.registerTool(
    'tool_with_progress',
    { description: 'Isolated progress-notification fixture', inputSchema: z.object({}) },
    async (_args, context) => {
      const token = context.mcpReq._meta?.progressToken;
      for (const progress of [0, 50, 100]) {
        if (token !== undefined) {
          await context.mcpReq.notify({
            method: 'notifications/progress',
            params: { progressToken: token, progress, total: 100 },
          });
        }
        await delay(50);
      }
      return { content: [{ type: 'text', text: 'Progress reporting complete.' }] };
    },
  );
  return server;
}

if (process.argv[2] === 'serve') {
  // A modern upstream exercises the Hub's legacy/modern ingress translation.
  serveStdio(createFixtureServer, { legacy: 'reject' });
}
