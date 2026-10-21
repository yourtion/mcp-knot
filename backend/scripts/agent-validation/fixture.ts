/** Real loopback backends and production Group router; no model or MCP mocks. */
import { serve } from '@hono/node-server';
import { SkillRepository } from '@mcp-core/mcp-knot-core/skills';
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import { Hono } from 'hono';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod/v4';

import { groupMcpRouter, shutdownGroupMcpRouter } from '../../src/api/mcp/group-router.js';
import {
  createHubService,
  setHubService,
  shutdownCoreServiceManager,
  shutdownHubService,
} from '../../src/services/service-registry.js';
import { resetConfigInstances, saveConfig } from '../../src/utils/config.js';

import type { Server } from 'node:http';

export async function startFixture() {
  const directory = await mkdtemp(join(tmpdir(), 'knot-agent-validation-'));
  const previousConfig = process.env.CONFIG_PATH;
  process.env.CONFIG_PATH = directory;
  resetConfigInstances();
  const calls: Array<{ server: string; tool: string; args: unknown }> = [];
  const requests: Array<{ path: string; method: string; params: unknown }> = [];
  const listeners: ReturnType<typeof serve>[] = [];
  const handlers: ReturnType<typeof createMcpHandler>[] = [];
  async function listen(fetch: (request: Request) => Response | Promise<Response>) {
    const server = serve({ fetch, hostname: '127.0.0.1', port: 0 });
    listeners.push(server);
    if (!server.listening)
      await new Promise<void>((resolve, reject) => {
        server.once('listening', resolve);
        server.once('error', reject);
      });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing TCP address');
    return `http://127.0.0.1:${address.port}`;
  }
  const urls: Record<string, string> = {};
  for (const label of ['alpha', 'beta']) {
    const handler = createMcpHandler(
      () => {
        const server = new McpServer({ name: `controlled-${label}`, version: '1' });
        server.registerTool(
          'echo',
          {
            description: 'Read-only echo of a message and the sum of two numbers.',
            inputSchema: z.object({ message: z.string(), a: z.number(), b: z.number() }),
          },
          async (args) => {
            calls.push({ server: label, tool: 'echo', args });
            return {
              content: [
                {
                  type: 'text' as const,
                  text: JSON.stringify({
                    backend: label,
                    message: args.message,
                    sum: args.a + args.b,
                  }),
                },
              ],
            };
          },
        );
        server.registerTool(
          'fail',
          {
            description: 'Return a deliberate harmless domain error for validation.',
            inputSchema: z.object({}),
          },
          async (args) => {
            calls.push({ server: label, tool: 'fail', args });
            return {
              isError: true,
              content: [{ type: 'text' as const, text: `CONTROLLED_ERROR:${label}` }],
            };
          },
        );
        server.registerTool(
          'stock',
          {
            description: `Read-only live stock at the ${label === 'alpha' ? 'East' : 'West'} warehouse. Query before recommending fulfillment; this does not reserve or ship goods.`,
            inputSchema: z.object({ sku: z.string() }),
          },
          async (args) => {
            calls.push({ server: label, tool: 'stock', args });
            return {
              content: [
                {
                  type: 'text' as const,
                  text: JSON.stringify({
                    warehouse: label === 'alpha' ? 'East' : 'West',
                    sku: args.sku,
                    available: args.sku === 'PENCIL-7' ? (label === 'alpha' ? 12 : 9) : 0,
                  }),
                },
              ],
            };
          },
        );
        return server;
      },
      { legacy: 'stateless' },
    );
    handlers.push(handler);
    urls[label] = `${await listen((request) => handler.fetch(request))}/mcp`;
  }
  const repository = new SkillRepository(join(directory, '.skills'));
  const skillDirectory = join(directory, 'source', 'fulfillment-policy');
  await mkdir(skillDirectory, { recursive: true });
  const policy = (preferred: string) =>
    `---\nname: fulfillment-policy\ndescription: Apply the published fulfillment rules when selecting a warehouse for an order.\n---\nRead live stock from BOTH East and West. Never reserve or ship. A single warehouse must cover the entire quantity. If both qualify, choose ${preferred}, even if the other has more stock. If neither qualifies, report a shortage; do not promise shipment or combine warehouses. In the recommendation cite both stock counts and use service class ECONOMY.\n`;
  await writeFile(join(skillDirectory, 'SKILL.md'), policy('West'));
  await repository.saveSource({
    id: 'local-policy',
    type: 'local',
    directory: join(directory, 'source'),
    skills: ['fulfillment-policy'],
  });
  const first = await repository.sync('local-policy');
  const groups = {
    alpha: { id: 'alpha', name: 'East only', servers: ['alpha'], tools: [] },
    beta: { id: 'beta', name: 'West only', servers: ['beta'], tools: [] },
    both: { id: 'both', name: 'Warehouses', servers: ['alpha', 'beta'], tools: [] },
    fulfillment: {
      id: 'fulfillment',
      name: 'Fulfillment',
      servers: ['alpha', 'beta'],
      tools: [],
      skills: { include: first.selections },
    },
  };
  const servers = Object.fromEntries(
    Object.entries(urls).map(([name, url]) => [
      name,
      { type: 'streaming' as const, url, enabled: true },
    ]),
  );
  await saveConfig('mcp_server.json', { servers });
  await saveConfig('group.json', groups);
  await saveConfig('system.json', {});
  await writeFile(join(skillDirectory, 'SKILL.md'), policy('East'));
  const second = await repository.sync('local-policy', 'update');
  const hub = await createHubService({ servers, groups });
  await hub.initialize();
  setHubService(hub);
  const app = new Hono();
  app.use('*', async (context, next) => {
    try {
      const body = await context.req.raw.clone().json();
      requests.push({ path: context.req.path, method: body.method, params: body.params });
    } catch {
      /* Some transport requests have no JSON body. */
    }
    await next();
  });
  app.route('/', groupMcpRouter);
  const baseUrl = await listen((request) => app.fetch(request));
  async function stopBeta() {
    await handlers[1].close();
    (listeners[1] as Server).closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      listeners[1].close((error) => (error ? reject(error) : resolve()));
    });
  }
  async function close() {
    await shutdownGroupMcpRouter();
    await shutdownCoreServiceManager();
    await shutdownHubService();
    await hub.shutdown();
    await Promise.all(handlers.map((handler) => handler.close()));
    await Promise.all(
      listeners
        .filter((server) => server.listening)
        .map(
          (server) =>
            new Promise<void>((resolve) => {
              (server as Server).closeAllConnections();
              server.close(() => resolve());
            }),
        ),
    );
    resetConfigInstances();
    if (previousConfig === undefined) delete process.env.CONFIG_PATH;
    else process.env.CONFIG_PATH = previousConfig;
    await rm(directory, { recursive: true, force: true });
  }
  return { baseUrl, urls, calls, requests, first, second, stopBeta, close };
}
