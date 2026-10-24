import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const hubService = vi.hoisted(() => ({
  listTools: vi.fn(),
  getServerHealth: vi.fn(),
  callTool: vi.fn(),
}));

vi.mock('../../services/service-registry.js', () => ({
  getHubService: () => hubService,
}));

const addExecutionRecord = vi.hoisted(() => vi.fn());

vi.mock('../tools-admin/index.js', () => ({
  addExecutionRecord,
}));

import { toolsApi } from './index.js';

import type { GroupToolInfo } from '../mcp/group-service.js';

function tool(overrides: Partial<GroupToolInfo> = {}): GroupToolInfo {
  return {
    name: 'echo',
    description: '回显工具',
    serverId: 'primary',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string' }, count: { type: 'integer' } },
      required: ['query'],
    },
    ...overrides,
  };
}

describe('Tools API', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    app = new Hono();
    app.use('*', async (c, next) => {
      c.set('requestId', 'tools-request');
      await next();
    });
    app.route('/api/tools', toolsApi);
  });

  function post(path: string, body: unknown): Promise<Response> {
    return app.request(`/api/tools${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  describe('GET / - 工具列表', () => {
    it('返回工具列表、按服务器分组与总数', async () => {
      hubService.listTools.mockResolvedValue([
        tool(),
        tool({ name: 'search', description: '搜索', serverId: 'standby' }),
        tool({ name: 'internal', serverId: 'hidden' }),
      ]);
      hubService.getServerHealth.mockReturnValue(
        new Map([
          ['primary', 'connected'],
          ['standby', 'disconnected'],
        ]),
      );

      const response = await app.request('/api/tools');

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.data.total).toBe(3);
      expect(body.data.groupId).toBe('default');
      expect(body.data.serverId).toBeNull();
      const byName = new Map(body.data.tools.map((t: { name: string }) => [t.name, t]));
      expect(byName.get('echo')).toMatchObject({ status: 'available', serverId: 'primary' });
      expect(byName.get('search')).toMatchObject({ status: 'unavailable' });
      expect(byName.get('internal')).toMatchObject({ status: 'unavailable' });
      expect(Object.keys(body.data.toolsByServer)).toEqual(
        expect.arrayContaining(['primary', 'standby', 'hidden']),
      );
      expect(body.data.toolsByServer.primary).toHaveLength(1);
      expect(hubService.listTools).toHaveBeenCalledWith('default');
    });

    it('serverId 查询参数按服务器过滤工具并透传 groupId', async () => {
      hubService.listTools.mockResolvedValue([
        tool(),
        tool({ name: 'search', serverId: 'standby' }),
      ]);
      hubService.getServerHealth.mockReturnValue(new Map([['primary', 'connected']]));

      const response = await app.request('/api/tools?serverId=primary&groupId=team');

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.data.total).toBe(1);
      expect(body.data.tools).toEqual([expect.objectContaining({ name: 'echo' })]);
      expect(body.data.serverId).toBe('primary');
      expect(hubService.listTools).toHaveBeenCalledWith('team');
    });

    it('服务异常时返回 500', async () => {
      hubService.listTools.mockRejectedValue(new Error('hub 不可用'));

      const response = await app.request('/api/tools');

      expect(response.status).toBe(500);
      expect(await response.json()).toMatchObject({
        success: false,
        requestId: 'tools-request',
      });
    });
  });

  describe('GET /server/:serverId - 按服务器过滤', () => {
    it('返回服务器的工具与连接状态', async () => {
      hubService.listTools.mockResolvedValue([tool(), tool({ name: 'search', serverId: 'other' })]);
      hubService.getServerHealth.mockReturnValue(new Map([['primary', 'connected']]));

      const response = await app.request('/api/tools/server/primary?groupId=team');

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        data: {
          serverId: 'primary',
          serverStatus: 'connected',
          groupId: 'team',
          total: 1,
          tools: [expect.objectContaining({ name: 'echo', status: 'available' })],
        },
      });
    });

    it('服务器不在健康列表时返回 404', async () => {
      hubService.listTools.mockResolvedValue([]);
      hubService.getServerHealth.mockReturnValue(new Map());

      const response = await app.request('/api/tools/server/ghost');

      expect(response.status).toBe(404);
      expect(await response.json()).toMatchObject({
        error: { code: 'SERVER_NOT_FOUND', message: "服务器 'ghost' 未找到" },
      });
    });
  });

  describe('GET /:toolName - 工具详情', () => {
    it('返回工具详情与可用性（已连接服务器）', async () => {
      hubService.listTools.mockResolvedValue([tool()]);
      hubService.getServerHealth.mockReturnValue(new Map([['primary', 'connected']]));

      const response = await app.request('/api/tools/echo?groupId=team');

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        data: {
          name: 'echo',
          serverId: 'primary',
          status: 'available',
          serverStatus: 'connected',
          isAvailable: true,
          groupId: 'team',
        },
      });
    });

    it('api-tools 来源的工具不依赖服务器健康状态', async () => {
      hubService.listTools.mockResolvedValue([tool({ serverId: 'api-tools' })]);
      hubService.getServerHealth.mockReturnValue(new Map());

      const response = await app.request('/api/tools/echo');

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        data: { status: 'unavailable', serverStatus: 'available', isAvailable: true },
      });
    });

    it('服务器未连接时 status 为 unavailable 且 isAvailable 为 false', async () => {
      hubService.listTools.mockResolvedValue([tool()]);
      hubService.getServerHealth.mockReturnValue(new Map([['primary', 'disconnected']]));

      const response = await app.request('/api/tools/echo');

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        data: { status: 'unavailable', serverStatus: 'disconnected', isAvailable: false },
      });
    });

    it('工具不存在时返回 404 TOOL_NOT_FOUND', async () => {
      hubService.listTools.mockResolvedValue([]);
      hubService.getServerHealth.mockReturnValue(new Map());

      const response = await app.request('/api/tools/ghost');

      expect(response.status).toBe(404);
      expect(await response.json()).toMatchObject({
        error: {
          code: 'TOOL_NOT_FOUND',
          message: "工具 'ghost' 在组 'default' 中未找到",
        },
      });
    });
  });

  describe('POST /:toolName/execute - 执行工具', () => {
    it('执行成功返回结果并记录执行历史', async () => {
      hubService.listTools.mockResolvedValue([tool()]);
      hubService.getServerHealth.mockReturnValue(new Map([['primary', 'connected']]));
      hubService.callTool.mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] });

      const response = await post('/echo/execute', {
        arguments: { query: 'hello' },
        groupId: 'team',
      });

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.success).toBe(true);
      expect(body.data).toMatchObject({
        toolName: 'echo',
        serverId: 'primary',
        groupId: 'team',
        result: [{ type: 'text', text: 'ok' }],
      });
      expect(body.data.executionId).toContain('team-echo-');
      expect(typeof body.data.executionTime).toBe('number');
      expect(hubService.callTool).toHaveBeenCalledWith('echo', { query: 'hello' }, 'team');
      expect(addExecutionRecord).toHaveBeenCalledWith(
        expect.objectContaining({ toolName: 'echo', groupId: 'team', isError: false }),
      );
    });

    it('工具内部失败（isError）时仍返回 success:true 与错误内容', async () => {
      hubService.listTools.mockResolvedValue([tool()]);
      hubService.getServerHealth.mockReturnValue(new Map([['primary', 'connected']]));
      hubService.callTool.mockResolvedValue({
        content: [{ type: 'text', text: '业务错误' }],
        isError: true,
      });

      const response = await post('/echo/execute', { args: { query: 'x' } });

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.success).toBe(true);
      expect(body.data.isError).toBe(true);
      expect(body.data.result[0].text).toBe('业务错误');
      expect(addExecutionRecord).toHaveBeenCalledWith(expect.objectContaining({ isError: true }));
    });

    it('工具不存在时返回 404', async () => {
      hubService.listTools.mockResolvedValue([]);

      const response = await post('/ghost/execute', {});

      expect(response.status).toBe(404);
      expect(await response.json()).toMatchObject({ error: { code: 'TOOL_NOT_FOUND' } });
    });

    it('指定的 serverId 与工具所在服务器不一致时返回 400', async () => {
      hubService.listTools.mockResolvedValue([tool()]);

      const response = await post('/echo/execute', { serverId: 'other' });

      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        error: {
          code: 'TOOL_SERVER_MISMATCH',
          message: "工具 'echo' 不在服务器 'other' 上，实际在服务器 'primary' 上",
        },
      });
    });

    it('服务器未连接时返回 503 SERVER_UNAVAILABLE', async () => {
      hubService.listTools.mockResolvedValue([tool()]);
      hubService.getServerHealth.mockReturnValue(new Map([['primary', 'disconnected']]));

      const response = await post('/echo/execute', {});

      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({
        error: {
          code: 'SERVER_UNAVAILABLE',
          message: "服务器 'primary' 不可用，状态: disconnected",
        },
      });
    });

    it('api-tools 工具不检查服务器状态直接执行', async () => {
      hubService.listTools.mockResolvedValue([tool({ serverId: 'api-tools' })]);
      hubService.getServerHealth.mockReturnValue(new Map());
      hubService.callTool.mockResolvedValue({ content: [] });

      const response = await post('/echo/execute', { serverId: 'api-tools' });

      expect(response.status).toBe(200);
      expect(hubService.callTool).toHaveBeenCalledOnce();
    });

    it('callTool 抛错时返回 500', async () => {
      hubService.listTools.mockResolvedValue([tool()]);
      hubService.getServerHealth.mockReturnValue(new Map([['primary', 'connected']]));
      hubService.callTool.mockRejectedValue(new Error('执行崩溃'));

      const response = await post('/echo/execute', {});

      expect(response.status).toBe(500);
      expect(await response.json()).toMatchObject({ success: false });
    });
  });

  describe('POST /:toolName/test - 参数校验', () => {
    function setup(toolOverrides: Partial<GroupToolInfo> = {}): void {
      hubService.listTools.mockResolvedValue([tool(toolOverrides)]);
      hubService.getServerHealth.mockReturnValue(new Map([['primary', 'connected']]));
    }

    it('缺少必填参数时 isValid=false 且 canExecute=false', async () => {
      setup();

      const response = await post('/echo/test', { arguments: {} });

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        data: {
          toolName: 'echo',
          isAvailable: true,
          canExecute: false,
          validation: {
            isValid: false,
            errors: ['缺少必需参数: query'],
            warnings: [],
          },
        },
      });
    });

    it('必填参数为 null 时报不能为空', async () => {
      setup();
      const response = await post('/echo/test', { arguments: { query: null } });

      expect((await response.json()).data.validation.errors).toEqual([
        "必需参数 'query' 不能为空",
        "参数 'query' 必须是字符串，实际类型: object",
      ]);
    });

    it('参数类型不匹配时给出具体类型错误', async () => {
      setup({
        inputSchema: {
          type: 'object',
          properties: {
            q: { type: 'string' },
            n: { type: 'number' },
            i: { type: 'integer' },
            b: { type: 'boolean' },
            a: { type: 'array' },
            o: { type: 'object' },
          },
        },
      });

      const response = await post('/echo/test', {
        arguments: {
          q: 1,
          n: 'x',
          i: 1.5,
          b: 'yes',
          a: {},
          o: [1],
        },
      });

      const validation = (await response.json()).data.validation;
      expect(validation.isValid).toBe(false);
      expect(validation.errors).toEqual([
        "参数 'q' 必须是字符串，实际类型: number",
        "参数 'n' 必须是数字，实际类型: string",
        "参数 'i' 必须是整数，实际类型: number",
        "参数 'b' 必须是布尔值，实际类型: string",
        "参数 'a' 必须是数组，实际类型: object",
        "参数 'o' 必须是对象，实际类型: object",
      ]);
    });

    it('未声明 type 的属性与未知类型放行', async () => {
      setup({
        inputSchema: {
          type: 'object',
          properties: { plain: {}, exotic: { type: 'mystery' } },
        },
      });

      const response = await post('/echo/test', {
        arguments: { plain: [1, 2], exotic: 'anything' },
      });

      expect((await response.json()).data.validation).toEqual({
        isValid: true,
        errors: [],
        warnings: [],
      });
    });

    it('additionalProperties=false 时额外参数给出警告', async () => {
      setup({
        inputSchema: {
          type: 'object',
          properties: { q: { type: 'string' } },
          additionalProperties: false,
        },
      });

      const response = await post('/echo/test', {
        arguments: { q: 'ok', extra: 1, another: 2 },
      });

      expect((await response.json()).data.validation).toEqual({
        isValid: true,
        errors: [],
        warnings: ['提供了额外的参数: extra, another'],
      });
    });

    it('工具没有 inputSchema 时跳过校验但保持可执行', async () => {
      setup({ inputSchema: undefined });

      const response = await post('/echo/test', { arguments: { anything: 1 } });

      expect(await response.json()).toMatchObject({
        data: {
          canExecute: true,
          validation: {
            isValid: true,
            warnings: ['工具没有定义输入模式，跳过参数验证'],
          },
        },
      });
    });

    it('服务器未连接时 isAvailable=false 且 canExecute=false', async () => {
      setup();
      hubService.getServerHealth.mockReturnValue(new Map([['primary', 'disconnected']]));

      const response = await post('/echo/test', { arguments: { query: 'x' } });

      expect(await response.json()).toMatchObject({
        data: {
          serverStatus: 'disconnected',
          isAvailable: false,
          canExecute: false,
        },
      });
    });

    it('工具不存在时返回 404', async () => {
      hubService.listTools.mockResolvedValue([]);

      const response = await post('/ghost/test', {});

      expect(response.status).toBe(404);
      expect(await response.json()).toMatchObject({ error: { code: 'TOOL_NOT_FOUND' } });
    });

    it('listTools 抛错时返回 500', async () => {
      hubService.listTools.mockRejectedValue(new Error('列出工具失败'));

      const response = await post('/echo/test', {});

      expect(response.status).toBe(500);
    });
  });
});
