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

const loggerMock = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock('../../utils/logger.js', () => ({ logger: loggerMock }));

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
      expect(loggerMock.info).toHaveBeenCalledWith('获取所有工具列表', {
        groupId: 'default',
        toolCount: 3,
      });
    });

    it('同一服务器的多个工具完整分组且分组内保留可用状态', async () => {
      hubService.listTools.mockResolvedValue([
        tool(),
        tool({ name: 'search', description: '搜索' }),
        tool({ name: 'internal', serverId: 'hidden' }),
      ]);
      hubService.getServerHealth.mockReturnValue(new Map([['primary', 'connected']]));

      const response = await app.request('/api/tools?groupId=grp-x');

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.data.toolsByServer.primary).toEqual([
        {
          name: 'echo',
          description: '回显工具',
          status: 'available',
          inputSchema: tool().inputSchema,
        },
        {
          name: 'search',
          description: '搜索',
          status: 'available',
          inputSchema: tool().inputSchema,
        },
      ]);
      expect(body.data.toolsByServer.hidden[0]).toMatchObject({
        name: 'internal',
        status: 'unavailable',
      });
      expect(loggerMock.info).toHaveBeenCalledWith('获取所有工具列表', {
        groupId: 'grp-x',
        toolCount: 3,
      });
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
      expect(loggerMock.info).toHaveBeenCalledWith('按服务器过滤工具列表', {
        serverId: 'primary',
        groupId: 'team',
        toolCount: 1,
      });
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
      expect(await response.json()).toEqual({
        success: false,
        error: { code: 'SERVER_NOT_FOUND', message: "服务器 'ghost' 未找到" },
        requestId: 'tools-request',
      });
    });

    it('未指定 groupId 时回落 default', async () => {
      hubService.listTools.mockResolvedValue([tool()]);
      hubService.getServerHealth.mockReturnValue(new Map([['primary', 'connected']]));

      const response = await app.request('/api/tools/server/primary');

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        data: { groupId: 'default', serverStatus: 'connected' },
      });
      expect(hubService.listTools).toHaveBeenCalledWith('default');
    });

    it('listTools 抛错时返回 500', async () => {
      hubService.listTools.mockRejectedValue(new Error('服务器工具失败'));

      const response = await app.request('/api/tools/server/primary');

      expect(response.status).toBe(500);
      expect(await response.json()).toMatchObject({
        success: false,
        requestId: 'tools-request',
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

    it('工具不在健康列表的服务器上时 serverStatus 为 unknown', async () => {
      hubService.listTools.mockResolvedValue([tool()]);
      hubService.getServerHealth.mockReturnValue(new Map());

      const response = await app.request('/api/tools/echo');

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        data: {
          serverStatus: 'unknown',
          status: 'unavailable',
          isAvailable: false,
        },
      });
    });

    it('在多工具列表中按名称精确匹配目标工具', async () => {
      hubService.listTools.mockResolvedValue([
        tool({ name: 'other-tool', serverId: 'secondary' }),
        tool(),
      ]);
      hubService.getServerHealth.mockReturnValue(
        new Map([
          ['primary', 'connected'],
          ['secondary', 'connected'],
        ]),
      );

      const response = await app.request('/api/tools/echo');

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        data: { name: 'echo', serverId: 'primary' },
      });
      expect(loggerMock.info).toHaveBeenCalledWith('获取工具详细信息', {
        toolName: 'echo',
        serverId: 'primary',
        groupId: 'default',
        serverStatus: 'connected',
      });
    });

    it('listTools 抛错时返回 500', async () => {
      hubService.listTools.mockRejectedValue(new Error('详情失败'));

      const response = await app.request('/api/tools/echo');

      expect(response.status).toBe(500);
      expect(await response.json()).toMatchObject({ success: false });
    });

    it('工具不存在时返回 404 TOOL_NOT_FOUND', async () => {
      hubService.listTools.mockResolvedValue([]);
      hubService.getServerHealth.mockReturnValue(new Map());

      const response = await app.request('/api/tools/ghost');

      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({
        success: false,
        error: {
          code: 'TOOL_NOT_FOUND',
          message: "工具 'ghost' 在组 'default' 中未找到",
        },
        requestId: 'tools-request',
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
      // 耗时应为短时间差，而非时间戳相加
      expect(body.data.executionTime).toBeGreaterThanOrEqual(0);
      expect(body.data.executionTime).toBeLessThan(10_000);
      expect(hubService.callTool).toHaveBeenCalledWith('echo', { query: 'hello' }, 'team');
      expect(addExecutionRecord).toHaveBeenCalledWith(
        expect.objectContaining({ toolName: 'echo', groupId: 'team', isError: false }),
      );
      expect(loggerMock.info).toHaveBeenCalledWith(
        '工具执行完成',
        expect.objectContaining({
          toolName: 'echo',
          serverId: 'primary',
          groupId: 'team',
          status: 'completed',
        }),
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
      expect(loggerMock.info).toHaveBeenCalledWith(
        '工具执行完成',
        expect.objectContaining({ toolName: 'echo', status: 'failed' }),
      );
    });

    it('groupId 优先级：body > 查询参数 > default', async () => {
      hubService.listTools.mockResolvedValue([tool()]);
      hubService.getServerHealth.mockReturnValue(new Map([['primary', 'connected']]));
      hubService.callTool.mockResolvedValue({ content: [] });

      await app.request('/api/tools/echo/execute?groupId=from-query', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ groupId: 'from-body' }),
      });
      expect(hubService.listTools).toHaveBeenLastCalledWith('from-body');

      await app.request('/api/tools/echo/execute?groupId=from-query', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(hubService.listTools).toHaveBeenLastCalledWith('from-query');

      await post('/echo/execute', {});
      expect(hubService.listTools).toHaveBeenLastCalledWith('default');
    });

    it('在多工具列表中按名称精确匹配并执行目标工具', async () => {
      hubService.listTools.mockResolvedValue([
        tool({ name: 'other-tool', serverId: 'secondary' }),
        tool(),
      ]);
      hubService.getServerHealth.mockReturnValue(
        new Map([
          ['primary', 'connected'],
          ['secondary', 'connected'],
        ]),
      );
      hubService.callTool.mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] });

      const response = await post('/echo/execute', {});

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.data.serverId).toBe('primary');
      expect(hubService.callTool).toHaveBeenCalledWith('echo', {}, 'default');
    });

    it('工具不存在时返回 404', async () => {
      hubService.listTools.mockResolvedValue([]);

      const response = await post('/ghost/execute', { groupId: 'team' });

      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({
        success: false,
        error: {
          code: 'TOOL_NOT_FOUND',
          message: "工具 'ghost' 在组 'team' 中未找到",
        },
        requestId: 'tools-request',
      });
    });

    it('指定的 serverId 与工具所在服务器不一致时返回 400', async () => {
      hubService.listTools.mockResolvedValue([tool()]);

      const response = await post('/echo/execute', { serverId: 'other' });

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        success: false,
        error: {
          code: 'TOOL_SERVER_MISMATCH',
          message: "工具 'echo' 不在服务器 'other' 上，实际在服务器 'primary' 上",
        },
        requestId: 'tools-request',
      });
    });

    it('服务器未连接时返回 503 SERVER_UNAVAILABLE', async () => {
      hubService.listTools.mockResolvedValue([tool()]);
      hubService.getServerHealth.mockReturnValue(new Map([['primary', 'disconnected']]));

      const response = await post('/echo/execute', {});

      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({
        success: false,
        error: {
          code: 'SERVER_UNAVAILABLE',
          message: "服务器 'primary' 不可用，状态: disconnected",
        },
        requestId: 'tools-request',
      });
    });

    it('服务器不在健康列表时状态回退 unknown', async () => {
      hubService.listTools.mockResolvedValue([tool()]);
      hubService.getServerHealth.mockReturnValue(new Map());

      const response = await post('/echo/execute', {});

      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({
        error: {
          code: 'SERVER_UNAVAILABLE',
          message: "服务器 'primary' 不可用，状态: unknown",
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

    it('callTool 抛错时返回 500 并记录失败日志', async () => {
      hubService.listTools.mockResolvedValue([tool()]);
      hubService.getServerHealth.mockReturnValue(new Map([['primary', 'connected']]));
      hubService.callTool.mockRejectedValue(new Error('执行崩溃'));

      const response = await post('/echo/execute', {});

      expect(response.status).toBe(500);
      expect(await response.json()).toMatchObject({ success: false });
      expect(loggerMock.error).toHaveBeenCalledWith('工具执行失败', expect.any(Error), {
        toolName: 'echo',
      });
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
      expect(loggerMock.info).toHaveBeenCalledWith(
        '工具测试请求',
        expect.objectContaining({
          toolName: 'echo',
          groupId: 'default',
          serverStatus: 'connected',
        }),
      );
      expect(loggerMock.info).toHaveBeenCalledWith(
        '工具测试完成',
        expect.objectContaining({ toolName: 'echo', isValid: false, canExecute: false }),
      );
    });

    it('groupId 优先级：body > 查询参数 > default', async () => {
      setup();

      await app.request('/api/tools/echo/test?groupId=tq', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ groupId: 'tb' }),
      });
      expect(hubService.listTools).toHaveBeenLastCalledWith('tb');

      await app.request('/api/tools/echo/test?groupId=tq', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(hubService.listTools).toHaveBeenLastCalledWith('tq');

      await post('/echo/test', {});
      expect(hubService.listTools).toHaveBeenLastCalledWith('default');
    });

    it('在多工具列表中按名称精确匹配目标工具', async () => {
      hubService.listTools.mockResolvedValue([
        tool({ name: 'other-tool', serverId: 'secondary' }),
        tool(),
      ]);
      hubService.getServerHealth.mockReturnValue(new Map([['primary', 'connected']]));

      const response = await post('/echo/test', { arguments: { query: 'x' } });

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        data: { toolName: 'echo', serverId: 'primary' },
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
      expect(loggerMock.debug).toHaveBeenCalledWith('未知的参数类型，允许通过', {
        argName: 'exotic',
        expectedType: 'mystery',
      });
    });

    it('各类型合法取值不产生错误', async () => {
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
            plain: {},
          },
        },
      });

      const response = await post('/echo/test', {
        arguments: {
          q: 'text',
          n: 1.5,
          i: 3,
          b: false,
          a: [1],
          o: { z: 1 },
          plain: null,
        },
      });

      expect((await response.json()).data.validation).toEqual({
        isValid: true,
        errors: [],
        warnings: [],
      });
    });

    it('null 不是合法的对象参数', async () => {
      setup({
        inputSchema: {
          type: 'object',
          properties: { o: { type: 'object' } },
        },
      });

      const response = await post('/echo/test', { arguments: { o: null } });

      expect((await response.json()).data.validation.errors).toEqual([
        "参数 'o' 必须是对象，实际类型: object",
      ]);
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

    it('additionalProperties 未声明时额外参数不告警', async () => {
      setup({
        inputSchema: {
          type: 'object',
          properties: { q: { type: 'string' } },
        },
      });

      const response = await post('/echo/test', {
        arguments: { q: 'ok', undeclared: 1 },
      });

      expect((await response.json()).data.validation).toEqual({
        isValid: true,
        errors: [],
        warnings: [],
      });
    });

    it('additionalProperties=false 且无额外参数时不告警', async () => {
      setup({
        inputSchema: {
          type: 'object',
          properties: { q: { type: 'string' } },
          additionalProperties: false,
        },
      });

      const response = await post('/echo/test', { arguments: { q: 'ok' } });

      expect((await response.json()).data.validation).toEqual({
        isValid: true,
        errors: [],
        warnings: [],
      });
    });

    it('参数校验抛错时降级为警告且保持可执行', async () => {
      const throwingProperties = new Proxy(
        {},
        {
          get() {
            throw new Error('属性读取失败');
          },
        },
      ) as unknown as Record<string, unknown>;
      setup({
        inputSchema: {
          type: 'object',
          properties: throwingProperties,
        },
      });

      const response = await post('/echo/test', { arguments: { q: 'x' } });

      const data = (await response.json()).data;
      expect(data.validation).toEqual({
        isValid: true,
        errors: [],
        warnings: ['参数验证时出错: 属性读取失败'],
      });
      expect(data.canExecute).toBe(true);
      expect(loggerMock.error).toHaveBeenCalledWith('参数验证时出错', expect.any(Error), {
        toolName: 'echo',
        args: { q: 'x' },
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

      const response = await post('/ghost/test', { groupId: 'team' });

      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({
        success: false,
        error: {
          code: 'TOOL_NOT_FOUND',
          message: "工具 'ghost' 在组 'team' 中未找到",
        },
        requestId: 'tools-request',
      });
    });

    it('listTools 抛错时返回 500 并记录失败日志', async () => {
      hubService.listTools.mockRejectedValue(new Error('列出工具失败'));

      const response = await post('/echo/test', {});

      expect(response.status).toBe(500);
      expect(await response.json()).toMatchObject({ success: false });
      expect(loggerMock.error).toHaveBeenCalledWith('工具测试失败', expect.any(Error), {
        toolName: 'echo',
      });
    });
  });
});
