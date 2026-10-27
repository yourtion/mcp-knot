import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ToolManager } from '../../services/tool_manager.js';
import { ServerStatus } from '../../types/mcp-knot.js';

import type { ApiToolIntegrationService } from '../../services/api_tool_integration_service.js';
import type { GroupManager, ServerManager, Tool } from '../../types/mcp-knot.js';

const hub = vi.hoisted(() => ({ callTool: vi.fn() }));
vi.mock('../../services/service-registry.js', () => ({ getHubService: () => hub }));
vi.mock('../../utils/logger.js');

import { debugApi } from './index.js';

describe('debug server selection with real tool routing', () => {
  let app: Hono;
  let servers: Map<string, { id: string; status: ServerStatus; tools: Tool[] }>;
  let allowed: boolean;
  let apiEnabled: boolean;
  const execute = vi.fn();
  const executeApi = vi.fn();

  function tool(serverId: string, type = 'string'): Tool {
    return {
      name: 'echo',
      description: serverId,
      serverId,
      inputSchema: {
        type: 'object',
        properties: { value: { type } },
        required: ['value'],
      },
    };
  }

  function post(serverId?: unknown, args: Record<string, unknown> = { value: 'x' }) {
    return app.request('/debug/tool-test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ toolName: 'echo', serverId, groupId: 'default', arguments: args }),
    });
  }

  beforeEach(() => {
    vi.resetAllMocks();
    allowed = true;
    apiEnabled = false;
    servers = new Map(
      ['A', 'B', 'outside'].map((id) => [
        id,
        { id, status: ServerStatus.CONNECTED, tools: [tool(id)] },
      ]),
    );
    execute.mockImplementation(async (id: string) => ({
      content: [{ type: 'text', text: `executed ${id}` }],
    }));
    executeApi.mockResolvedValue({ content: [{ type: 'text', text: 'executed API' }] });
    const serverManager = {
      getAllServers: () => servers,
      executeToolOnServer: execute,
    } as unknown as ServerManager;
    const groupManager = {
      getGroup: () => ({ id: 'default', name: 'Default', servers: ['A', 'B'], tools: [] }),
      getGroupServers: () => ['A', 'B'],
      getGroupTools: async () => [...servers.get('A')!.tools, ...servers.get('B')!.tools],
      validateToolAccess: () => allowed,
    } as unknown as GroupManager;
    const apiService = {
      isApiTool: () => apiEnabled,
      getApiToolDefinition: () => (apiEnabled ? tool('api-tools') : null),
      getApiTools: async () => (apiEnabled ? [tool('api-tools')] : []),
      executeApiTool: executeApi,
    } as unknown as ApiToolIntegrationService;
    const manager = new ToolManager(serverManager, groupManager, apiService);
    hub.callTool.mockImplementation((name, args, group, server) =>
      manager.executeTool(group, name, args, server),
    );
    app = new Hono();
    app.route('/debug', debugApi);
  });

  it('executes B and reports B when A has a tool with the same name', async () => {
    const response = await post('B');
    expect(response.status).toBe(200);
    expect(execute).toHaveBeenCalledExactlyOnceWith('B', 'echo', { value: 'x' });
    expect(await response.json()).toMatchObject({
      data: { serverId: 'B', result: { content: [{ text: 'executed B' }] } },
    });
  });

  it('validates the selected server schema before executing', async () => {
    servers.get('B')!.tools = [tool('B', 'integer')];
    await post('B', { value: 0 });
    expect(execute).toHaveBeenCalledExactlyOnceWith('B', 'echo', { value: 0 });
  });

  it('rejects arguments valid only for A without falling back to A', async () => {
    servers.get('B')!.tools = [tool('B', 'integer')];
    const response = await post('B');
    expect((await response.json()).data.result.isError).toBe(true);
    expect(execute).not.toHaveBeenCalled();
  });

  it.each(['outside', 'missing'])('rejects server %s outside the group', async (id) => {
    const response = await post(id);
    expect((await response.json()).data.result.isError).toBe(true);
    expect(execute).not.toHaveBeenCalled();
  });

  it('does not fall back after the selected server disconnects', async () => {
    servers.get('B')!.status = ServerStatus.DISCONNECTED;
    const response = await post('B');
    expect((await response.json()).data.result.isError).toBe(true);
    expect(execute).not.toHaveBeenCalled();
  });

  it('does not fall back after the tool disappears from the selected server', async () => {
    servers.get('B')!.tools = [];
    const response = await post('B');
    expect((await response.json()).data.result.isError).toBe(true);
    expect(execute).not.toHaveBeenCalled();
  });

  it('keeps group tool restrictions when a server is selected', async () => {
    allowed = false;
    const response = await post('B');
    expect((await response.json()).data.result.isError).toBe(true);
    expect(execute).not.toHaveBeenCalled();
  });

  it('does not select a same-named API tool when a MCP server is selected', async () => {
    apiEnabled = true;
    await post('B');
    expect(execute).toHaveBeenCalledExactlyOnceWith('B', 'echo', { value: 'x' });
    expect(executeApi).not.toHaveBeenCalled();
  });

  it('executes an explicitly selected API tool', async () => {
    apiEnabled = true;
    await post('api-tools');
    expect(executeApi).toHaveBeenCalledExactlyOnceWith('echo', { value: 'x' });
    expect(execute).not.toHaveBeenCalled();
  });

  it('does not fall back to MCP when the explicitly selected API tool is absent', async () => {
    const response = await post('api-tools');
    expect((await response.json()).data.result.isError).toBe(true);
    expect(executeApi).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it('preserves automatic routing when no server is supplied', async () => {
    await post();
    expect(execute).toHaveBeenCalledExactlyOnceWith('A', 'echo', { value: 'x' });
  });

  it('preserves API precedence for legacy calls without a server', async () => {
    apiEnabled = true;
    await post();
    expect(executeApi).toHaveBeenCalledExactlyOnceWith('echo', { value: 'x' });
    expect(execute).not.toHaveBeenCalled();
  });

  it.each([null, false, 0, {}, [], '', '   '])('rejects invalid server IDs: %j', async (id) => {
    const response = await post(id);
    expect(response.status).toBe(400);
    expect(hub.callTool).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    expect(executeApi).not.toHaveBeenCalled();
  });
});
