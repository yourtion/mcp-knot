import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ServerStatus } from '../../types/mcp-knot.js';

import type { ServerConnection } from '../../types/mcp-knot.js';

const manager = vi.hoisted(() => ({
  initialize: vi.fn(),
  shutdown: vi.fn(),
  getAllServers: vi.fn(),
  getServerStatus: vi.fn(),
  getServerTools: vi.fn(),
}));

vi.mock('../../services/server_manager.js', () => ({
  ServerManager: class {
    constructor() {
      return manager;
    }
  },
}));

const configMock = vi.hoisted(() => ({
  getAllConfig: vi.fn(),
  saveConfig: vi.fn(),
}));

vi.mock('../../utils/config.js', () => configMock);

const loggerMock = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock('../../utils/logger.js', () => ({ logger: loggerMock }));

import { serversApi } from './index.js';

function makeConnection(overrides: Partial<ServerConnection> = {}): ServerConnection {
  return {
    id: 'srv',
    config: { type: 'stdio', command: 'node' },
    client: { close: vi.fn() } as unknown as ServerConnection['client'],
    status: ServerStatus.CONNECTED,
    tools: [{ name: 'echo', description: '回显工具', inputSchema: {}, serverId: 'srv' }],
    reconnectAttempts: 1,
    ...overrides,
  };
}

describe('Servers API', () => {
  let app: Hono;
  let connections: Map<string, ServerConnection>;

  beforeEach(() => {
    vi.clearAllMocks();
    configMock.getAllConfig.mockResolvedValue({
      mcps: { servers: { existing: { type: 'stdio', command: 'node' } } },
      groups: {},
    });
    configMock.saveConfig.mockResolvedValue(undefined);
    manager.initialize.mockResolvedValue(undefined);
    manager.shutdown.mockResolvedValue(undefined);
    manager.getServerTools.mockResolvedValue([]);
    connections = new Map();
    manager.getAllServers.mockReturnValue(connections);

    app = new Hono();
    app.use('*', async (c, next) => {
      c.set('requestId', 'servers-request');
      await next();
    });
    app.route('/api/servers', serversApi);
  });

  function jsonRequest(path: string, method: string, body?: unknown): Promise<Response> {
    return app.request(`/api/servers${path}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  describe('GET / - 服务器列表', () => {
    it('返回服务器列表与按状态汇总的统计', async () => {
      connections.set(
        'alpha',
        makeConnection({
          id: 'alpha',
          status: ServerStatus.CONNECTED,
          lastConnected: new Date('2026-01-01T00:00:00Z'),
          tools: [
            { name: 'echo', description: '回显', inputSchema: {}, serverId: 'alpha' },
            { name: 'lookup', description: '查询', inputSchema: {}, serverId: 'alpha' },
          ],
        }),
      );
      connections.set(
        'beta',
        makeConnection({
          id: 'beta',
          status: ServerStatus.ERROR,
          lastError: new Error('连接超时'),
          tools: [],
        }),
      );
      connections.set('gamma', makeConnection({ id: 'gamma', status: ServerStatus.CONNECTING }));
      connections.set('delta', makeConnection({ id: 'delta', status: ServerStatus.DISCONNECTED }));

      const response = await app.request('/api/servers');

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.success).toBe(true);
      expect(body.data.total).toBe(4);
      expect(body.data.summary).toEqual({
        total: 4,
        connected: 1,
        connecting: 1,
        disconnected: 1,
        error: 1,
      });
      const alpha = body.data.servers.find((s: { id: string }) => s.id === 'alpha');
      expect(alpha).toMatchObject({
        name: 'alpha',
        type: 'stdio',
        status: 'connected',
        toolCount: 2,
        lastConnected: '2026-01-01T00:00:00.000Z',
        tools: [
          { name: 'echo', description: '回显' },
          { name: 'lookup', description: '查询' },
        ],
      });
      expect(body.data.servers.find((s: { id: string }) => s.id === 'beta').lastError).toBe(
        '连接超时',
      );
      expect(loggerMock.info).toHaveBeenCalledWith('服务器列表获取成功', {
        serverCount: 4,
        connectedServers: 1,
      });
    });

    it('读取服务器列表出错时返回 500', async () => {
      manager.getAllServers.mockImplementation(() => {
        throw new Error('状态损坏');
      });

      const response = await app.request('/api/servers');

      expect(response.status).toBe(500);
      expect(await response.json()).toMatchObject({
        success: false,
        requestId: 'servers-request',
        error: { message: '状态损坏' },
      });
    });

    it('管理器惰性初始化后被复用（不再重复读取配置）', async () => {
      // POST 创建会重置并重新初始化管理器，确保后续请求命中缓存
      await jsonRequest('', 'POST', {
        id: 'cache-reset',
        config: { type: 'stdio', command: 'node' },
      });
      configMock.getAllConfig.mockClear();
      loggerMock.info.mockClear();
      connections.set('alpha', makeConnection({ id: 'alpha' }));

      const first = await app.request('/api/servers');
      expect(first.status).toBe(200);
      const second = await app.request('/api/servers');
      expect(second.status).toBe(200);

      expect(configMock.getAllConfig).not.toHaveBeenCalled();
      expect(loggerMock.info).not.toHaveBeenCalledWith('初始化服务器管理器');
    });
  });

  describe('GET /:id - 服务器详情', () => {
    it('返回单个服务器的详情字段', async () => {
      connections.set(
        'alpha',
        makeConnection({
          id: 'alpha',
          reconnectAttempts: 3,
          lastConnected: new Date('2026-02-02T00:00:00Z'),
        }),
      );

      const response = await app.request('/api/servers/alpha');

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        success: true,
        data: {
          id: 'alpha',
          name: 'alpha',
          type: 'stdio',
          status: 'connected',
          reconnectAttempts: 3,
          toolCount: 1,
          lastConnected: '2026-02-02T00:00:00.000Z',
        },
      });
    });

    it('服务器不存在时返回 404 与 SERVER_NOT_FOUND', async () => {
      const response = await app.request('/api/servers/missing');

      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({
        success: false,
        error: { code: 'SERVER_NOT_FOUND', message: "服务器 'missing' 未找到" },
        requestId: 'servers-request',
      });
    });

    it('无最近连接信息的服务器也能返回详情', async () => {
      connections.set('bare', makeConnection({ id: 'bare' }));

      const response = await app.request('/api/servers/bare');

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ data: { id: 'bare' } });
      expect(loggerMock.info).toHaveBeenCalledWith('服务器信息获取成功', {
        serverId: 'bare',
        status: 'connected',
        toolCount: 1,
      });
    });

    it('读取服务器详情出错时返回 500', async () => {
      manager.getAllServers.mockImplementation(() => {
        throw new Error('详情损坏');
      });

      const response = await app.request('/api/servers/alpha');

      expect(response.status).toBe(500);
      expect(await response.json()).toMatchObject({
        success: false,
        requestId: 'servers-request',
      });
    });
  });

  describe('POST / - 创建服务器', () => {
    const validBody = {
      id: 'fresh',
      config: { type: 'stdio', command: 'node', args: ['server.js'] },
    };

    it('创建成功返回 201 并把配置合并进 mcp_server.json', async () => {
      const response = await jsonRequest('', 'POST', validBody);

      expect(response.status).toBe(201);
      expect(await response.json()).toMatchObject({
        success: true,
        data: {
          id: 'fresh',
          message: "服务器 'fresh' 创建成功",
        },
      });
      expect(configMock.saveConfig).toHaveBeenCalledWith('mcp_server.json', {
        servers: {
          existing: { type: 'stdio', command: 'node' },
          fresh: { ...validBody.config, enabled: true },
        },
      });
      expect(loggerMock.info).toHaveBeenCalledWith('服务器创建成功', {
        serverId: 'fresh',
        type: 'stdio',
        enabled: true,
      });
    });

    it('重新初始化服务器管理器失败时返回 500', async () => {
      manager.initialize.mockRejectedValueOnce(new Error('配置读取失败'));

      const response = await jsonRequest('', 'POST', validBody);

      expect(response.status).toBe(500);
      expect(await response.json()).toMatchObject({
        success: false,
        requestId: 'servers-request',
      });
      // 初始化失败后管理器被重置，下一次请求会重新初始化
      connections.set('alpha', makeConnection({ id: 'alpha' }));
      const retry = await app.request('/api/servers');
      expect(retry.status).toBe(200);
      expect(loggerMock.error).toHaveBeenCalledWith('服务器管理器初始化失败', expect.any(Error));
    });

    it('服务器 ID 已存在时返回 409 SERVER_EXISTS', async () => {
      const response = await jsonRequest('', 'POST', {
        ...validBody,
        id: 'existing',
      });

      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({
        success: false,
        error: { code: 'SERVER_EXISTS', message: "服务器 'existing' 已存在" },
        requestId: 'servers-request',
      });
      expect(configMock.saveConfig).not.toHaveBeenCalled();
    });

    it.each([
      ['缺少 id', { config: { type: 'stdio', command: 'node' } }],
      ['id 含非法字符', { id: 'bad id!', config: { type: 'stdio', command: 'node' } }],
      ['id 以非法字符开头', { id: '中文-app', config: { type: 'stdio', command: 'node' } }],
      ['stdio 缺少 command', { id: 'fresh', config: { type: 'stdio' } }],
      ['http 类型 url 非法', { id: 'fresh', config: { type: 'sse', url: 'not-a-url' } }],
      ['type 不在枚举内', { id: 'fresh', config: { type: 'grpc', url: 'http://x' } }],
    ])('请求 schema 拒绝非法创建：%s', async (_name, body) => {
      const response = await jsonRequest('', 'POST', body);

      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        success: false,
        error: { code: 'VALIDATION_ERROR' },
        requestId: 'servers-request',
      });
      expect(configMock.saveConfig).not.toHaveBeenCalled();
    });

    it('schema 错误消息映射具体原因', async () => {
      const noCommand = await jsonRequest('', 'POST', {
        id: 'fresh',
        config: { type: 'stdio', command: '' },
      });
      expect(JSON.stringify(await noCommand.json())).toContain('命令不能为空');

      const badUrl = await jsonRequest('', 'POST', {
        id: 'fresh',
        config: { type: 'sse', url: 'not-a-url' },
      });
      expect(JSON.stringify(await badUrl.json())).toContain('必须是有效的URL');

      const emptyId = await jsonRequest('', 'POST', {
        id: '',
        config: { type: 'stdio', command: 'node' },
      });
      expect(JSON.stringify(await emptyId.json())).toContain('服务器ID不能为空');
    });

    it('保存配置失败时返回 500', async () => {
      configMock.saveConfig.mockRejectedValueOnce(new Error('磁盘已满'));

      const response = await jsonRequest('', 'POST', validBody);

      expect(response.status).toBe(500);
      expect(await response.json()).toMatchObject({
        success: false,
        error: { message: '磁盘已满' },
      });
    });
  });

  describe('PUT /:id - 更新服务器', () => {
    it('更新已存在服务器并保存新配置', async () => {
      const response = await jsonRequest('/existing', 'PUT', {
        config: { type: 'streaming', url: 'https://example.com/mcp' },
      });

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        success: true,
        data: {
          id: 'existing',
          message: "服务器 'existing' 配置更新成功",
        },
      });
      expect(configMock.saveConfig).toHaveBeenCalledWith('mcp_server.json', {
        servers: {
          existing: { type: 'streaming', url: 'https://example.com/mcp', enabled: true },
        },
      });
      expect(loggerMock.info).toHaveBeenCalledWith('服务器配置更新成功', {
        serverId: 'existing',
        type: 'streaming',
        enabled: true,
      });
    });

    it('服务器不存在时返回 404', async () => {
      const response = await jsonRequest('/missing', 'PUT', {
        config: { type: 'stdio', command: 'node' },
      });

      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({
        success: false,
        error: { code: 'SERVER_NOT_FOUND', message: "服务器 'missing' 未找到" },
        requestId: 'servers-request',
      });
      expect(configMock.saveConfig).not.toHaveBeenCalled();
    });

    it('请求 schema 拒绝非法配置', async () => {
      const response = await jsonRequest('/existing', 'PUT', { config: { type: 'stdio' } });

      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        success: false,
        error: { code: 'VALIDATION_ERROR', message: '请求数据验证失败' },
        requestId: 'servers-request',
      });
    });

    it('读取配置出错时返回 500', async () => {
      configMock.getAllConfig.mockRejectedValueOnce(new Error('配置损坏'));

      const response = await jsonRequest('/existing', 'PUT', {
        config: { type: 'stdio', command: 'node' },
      });

      expect(response.status).toBe(500);
      expect(await response.json()).toMatchObject({
        success: false,
        error: { message: '配置损坏' },
      });
    });
  });

  describe('DELETE /:id - 删除服务器', () => {
    it('删除服务器并从配置移除该条目', async () => {
      const response = await app.request('/api/servers/existing', { method: 'DELETE' });

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        success: true,
        data: { id: 'existing', message: "服务器 'existing' 删除成功" },
      });
      expect(configMock.saveConfig).toHaveBeenCalledWith('mcp_server.json', {
        servers: {},
      });
      expect(loggerMock.info).toHaveBeenCalledWith('服务器删除成功', {
        serverId: 'existing',
        type: 'stdio',
      });
    });

    it('服务器不存在时返回 404 且不保存', async () => {
      const response = await app.request('/api/servers/missing', { method: 'DELETE' });

      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({
        success: false,
        error: { code: 'SERVER_NOT_FOUND', message: "服务器 'missing' 未找到" },
        requestId: 'servers-request',
      });
      expect(configMock.saveConfig).not.toHaveBeenCalled();
    });

    it('保存配置失败时返回 500', async () => {
      configMock.saveConfig.mockRejectedValueOnce(new Error('只读文件系统'));

      const response = await app.request('/api/servers/existing', { method: 'DELETE' });

      expect(response.status).toBe(500);
      expect(await response.json()).toMatchObject({
        success: false,
        error: { message: '只读文件系统' },
      });
    });
  });

  describe('GET /:id/status - 服务器状态', () => {
    it('按连接状态派生 isConnected/isConnecting/hasError', async () => {
      connections.set(
        'alpha',
        makeConnection({
          id: 'alpha',
          lastConnected: new Date('2026-03-03T00:00:00Z'),
        }),
      );

      const response = await app.request('/api/servers/alpha/status');

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        data: {
          id: 'alpha',
          status: 'connected',
          isConnected: true,
          isConnecting: false,
          hasError: false,
          toolCount: 1,
          lastConnected: '2026-03-03T00:00:00.000Z',
        },
      });
    });

    it('error 状态时 hasError 为 true', async () => {
      connections.set(
        'beta',
        makeConnection({
          id: 'beta',
          status: ServerStatus.ERROR,
          lastError: new Error('boom'),
          tools: [],
        }),
      );

      const response = await app.request('/api/servers/beta/status');

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        data: { status: 'error', hasError: true, isConnected: false, lastError: 'boom' },
      });
    });

    it('服务器不存在时返回 404', async () => {
      const response = await app.request('/api/servers/none/status');

      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({
        success: false,
        error: { code: 'SERVER_NOT_FOUND', message: "服务器 'none' 未找到" },
        requestId: 'servers-request',
      });
    });

    it('记录状态查询调试日志', async () => {
      connections.set('alpha', makeConnection({ id: 'alpha' }));

      await app.request('/api/servers/alpha/status');

      expect(loggerMock.debug).toHaveBeenCalledWith('服务器状态查询成功', {
        serverId: 'alpha',
        status: 'connected',
      });
    });

    it('读取状态出错时返回 500', async () => {
      manager.getAllServers.mockImplementation(() => {
        throw new Error('状态损坏');
      });

      const response = await app.request('/api/servers/alpha/status');

      expect(response.status).toBe(500);
      expect(await response.json()).toMatchObject({ success: false });
    });
  });

  describe('POST /:id/connect - 连接服务器', () => {
    it('断开状态的服务器触发重连并返回 connecting', async () => {
      connections.set(
        'alpha',
        makeConnection({ id: 'alpha', status: ServerStatus.DISCONNECTED, tools: [] }),
      );

      const response = await app.request('/api/servers/alpha/connect', { method: 'POST' });

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        data: { id: 'alpha', status: 'connecting', message: "服务器 'alpha' 连接请求已发送" },
      });
      expect(loggerMock.info).toHaveBeenCalledWith('服务器连接请求已处理', { serverId: 'alpha' });
    });

    it('已连接的服务器返回 409 SERVER_ALREADY_CONNECTED', async () => {
      connections.set('alpha', makeConnection({ id: 'alpha' }));

      const response = await app.request('/api/servers/alpha/connect', { method: 'POST' });

      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({
        success: false,
        error: { code: 'SERVER_ALREADY_CONNECTED', message: "服务器 'alpha' 已经连接" },
        requestId: 'servers-request',
      });
    });

    it('连接中的服务器返回 409 SERVER_CONNECTING', async () => {
      connections.set('alpha', makeConnection({ id: 'alpha', status: ServerStatus.CONNECTING }));

      const response = await app.request('/api/servers/alpha/connect', { method: 'POST' });

      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({
        success: false,
        error: { code: 'SERVER_CONNECTING', message: "服务器 'alpha' 正在连接中" },
        requestId: 'servers-request',
      });
    });

    it('服务器不存在时返回 404', async () => {
      const response = await app.request('/api/servers/none/connect', { method: 'POST' });

      expect(response.status).toBe(404);
      expect(await response.json()).toMatchObject({
        success: false,
        error: { code: 'SERVER_NOT_FOUND', message: "服务器 'none' 未找到" },
      });
    });

    it('读取连接信息出错时返回 500', async () => {
      manager.getAllServers.mockImplementation(() => {
        throw new Error('连接损坏');
      });

      const response = await app.request('/api/servers/alpha/connect', { method: 'POST' });

      expect(response.status).toBe(500);
      expect(await response.json()).toMatchObject({ success: false });
    });
  });

  describe('POST /:id/disconnect - 断开服务器', () => {
    it('已连接服务器断开时关闭客户端并清空工具', async () => {
      const connection = makeConnection({ id: 'alpha' });
      connections.set('alpha', connection);

      const response = await app.request('/api/servers/alpha/disconnect', { method: 'POST' });

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        data: { id: 'alpha', status: 'disconnected', message: "服务器 'alpha' 已断开连接" },
      });
      expect(connection.client.close).toHaveBeenCalledOnce();
      expect(connection.status).toBe(ServerStatus.DISCONNECTED);
      expect(connection.tools).toEqual([]);
      expect(loggerMock.info).toHaveBeenCalledWith('服务器断开连接成功', { serverId: 'alpha' });
    });

    it('client.close 抛错时仍标记为断开', async () => {
      const connection = makeConnection({ id: 'alpha' });
      (connection.client.close as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error('close failed'),
      );
      connections.set('alpha', connection);

      const response = await app.request('/api/servers/alpha/disconnect', { method: 'POST' });

      expect(response.status).toBe(200);
      expect(connection.status).toBe(ServerStatus.DISCONNECTED);
      expect(connection.tools).toEqual([]);
      expect(loggerMock.error).toHaveBeenCalledWith(
        '服务器断开连接时发生错误，但仍标记为已断开',
        expect.any(Error),
        { serverId: 'alpha' },
      );
    });

    it('已断开的服务器返回 409 SERVER_ALREADY_DISCONNECTED', async () => {
      connections.set(
        'alpha',
        makeConnection({ id: 'alpha', status: ServerStatus.DISCONNECTED, tools: [] }),
      );

      const response = await app.request('/api/servers/alpha/disconnect', { method: 'POST' });

      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({
        success: false,
        error: {
          code: 'SERVER_ALREADY_DISCONNECTED',
          message: "服务器 'alpha' 已经断开连接",
        },
        requestId: 'servers-request',
      });
    });

    it('服务器不存在时返回 404', async () => {
      const response = await app.request('/api/servers/none/disconnect', { method: 'POST' });

      expect(response.status).toBe(404);
      expect(await response.json()).toMatchObject({
        success: false,
        error: { code: 'SERVER_NOT_FOUND', message: "服务器 'none' 未找到" },
      });
    });

    it('读取断开信息出错时返回 500', async () => {
      manager.getAllServers.mockImplementation(() => {
        throw new Error('断开损坏');
      });

      const response = await app.request('/api/servers/alpha/disconnect', { method: 'POST' });

      expect(response.status).toBe(500);
      expect(await response.json()).toMatchObject({ success: false });
    });
  });

  describe('POST /test - 测试服务器连接', () => {
    it('连接成功时返回 200 与工具详情', async () => {
      manager.getServerStatus.mockReturnValue(ServerStatus.CONNECTED);
      connections.set('test', makeConnection({ id: 'test' }));
      manager.getServerTools.mockResolvedValue([
        { name: 'echo', description: '回显', inputSchema: {}, serverId: 'test' },
      ]);

      const response = await jsonRequest('/test', 'POST', {
        type: 'stdio',
        command: '/usr/bin/node',
      });

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.success).toBe(true);
      expect(body.data).toMatchObject({
        success: true,
        message: '服务器连接测试成功',
        details: {
          status: 'connected',
          toolCount: 1,
          tools: [{ name: 'echo', description: '回显' }],
        },
      });
      // 耗时应为短时间差，而非时间戳相加
      expect(body.data.executionTime).toBeGreaterThanOrEqual(0);
      expect(body.data.executionTime).toBeLessThan(10_000);
      expect(manager.shutdown).toHaveBeenCalledOnce();
      expect(manager.getServerStatus).toHaveBeenCalledWith('test');
      expect(loggerMock.info).toHaveBeenCalledWith('开始测试服务器连接', {
        type: 'stdio',
        command: '/usr/bin/node',
        url: undefined,
      });
      expect(loggerMock.info).toHaveBeenCalledWith('服务器连接测试成功', {
        type: 'stdio',
        toolCount: 1,
        executionTime: expect.any(Number),
      });
    });

    it('http 类型配置记录 url 而非 command', async () => {
      manager.getServerStatus.mockReturnValue(ServerStatus.CONNECTED);
      connections.set('test', makeConnection({ id: 'test' }));

      await jsonRequest('/test', 'POST', { type: 'sse', url: 'https://example.com/sse' });

      expect(loggerMock.info).toHaveBeenCalledWith('开始测试服务器连接', {
        type: 'sse',
        command: undefined,
        url: 'https://example.com/sse',
      });
    });

    it('连接失败时返回 400 并携带 lastError', async () => {
      manager.getServerStatus.mockReturnValue(ServerStatus.ERROR);
      manager.getAllServers.mockReturnValue(
        new Map([
          [
            'test',
            makeConnection({
              id: 'test',
              status: ServerStatus.ERROR,
              lastError: new Error('握手失败'),
              tools: [],
            }),
          ],
        ]),
      );

      const response = await jsonRequest('/test', 'POST', {
        type: 'stdio',
        command: '/usr/bin/node',
      });

      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        success: false,
        data: {
          success: false,
          message: '服务器连接测试失败',
          error: '握手失败',
        },
      });
      // 失败分支不应再拉取工具列表
      expect(manager.getServerTools).not.toHaveBeenCalled();
      expect(manager.shutdown).toHaveBeenCalledOnce();
    });

    it('连接失败且无 lastError 时回退到默认错误文案', async () => {
      manager.getServerStatus.mockReturnValue(ServerStatus.ERROR);
      manager.getAllServers.mockReturnValue(
        new Map([['test', makeConnection({ id: 'test', status: ServerStatus.ERROR, tools: [] })]]),
      );

      const response = await jsonRequest('/test', 'POST', {
        type: 'stdio',
        command: '/usr/bin/node',
      });

      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        success: false,
        data: {
          success: false,
          message: '服务器连接测试失败',
          error: '连接失败',
        },
      });
    });

    it('初始化抛错时返回 400 异常结果并保证清理', async () => {
      manager.initialize.mockRejectedValueOnce(new Error('无法启动进程'));

      const response = await jsonRequest('/test', 'POST', {
        type: 'stdio',
        command: '/usr/bin/node',
      });

      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        success: false,
        data: {
          message: '服务器连接测试异常',
          error: '无法启动进程',
        },
      });
      expect(manager.shutdown).toHaveBeenCalledOnce();
      expect(loggerMock.error).toHaveBeenCalledWith('服务器连接测试异常', expect.any(Error), {
        type: 'stdio',
        executionTime: expect.any(Number),
      });
    });

    it('非法配置返回 400 VALIDATION_ERROR', async () => {
      const response = await jsonRequest('/test', 'POST', { type: 'stdio' });

      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        success: false,
        error: { code: 'VALIDATION_ERROR', message: '服务器配置验证失败' },
        requestId: 'servers-request',
      });
    });

    it('请求体非法 JSON 时返回 500', async () => {
      const response = await app.request('/api/servers/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'not-json',
      });

      expect(response.status).toBe(500);
      expect(await response.json()).toMatchObject({ success: false });
    });
  });

  describe('POST /validate - 验证服务器配置', () => {
    it('绝对路径的 stdio 命令通过且无警告', async () => {
      const response = await jsonRequest('/validate', 'POST', {
        type: 'stdio',
        command: '/usr/local/bin/node',
        args: ['x.js'],
        enabled: true,
      });

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        data: { isValid: true, errors: [], warnings: [], suggestions: [] },
      });
      expect(loggerMock.info).toHaveBeenCalledWith('服务器配置验证完成', {
        isValid: true,
        errorCount: 0,
        warningCount: 0,
      });
    });

    it('常规环境变量名不产生警告', async () => {
      const response = await jsonRequest('/validate', 'POST', {
        type: 'stdio',
        command: '/bin/node',
        env: { GOOD_KEY: 'value' },
      });

      const data = (await response.json()).data;
      expect(data.warnings).toEqual([]);
      expect(data.isValid).toBe(true);
    });

    it('裸命令名给出 PATH 提示（enabled 由 schema 默认值补齐）', async () => {
      const response = await jsonRequest('/validate', 'POST', {
        type: 'stdio',
        command: 'node',
        args: ['x.js'],
      });

      expect(response.status).toBe(200);
      const body = (await response.json()).data;
      expect(body.isValid).toBe(true);
      expect(body.warnings).toEqual([
        {
          field: 'command',
          message: '命令看起来像是一个可执行文件名，请确保它在系统PATH中',
          code: 'COMMAND_PATH_WARNING',
        },
      ]);
      expect(body.suggestions).toEqual([]);
    });

    it('npx/uvx 不带 args 时产生错误且 isValid 为 false', async () => {
      const npx = await jsonRequest('/validate', 'POST', { type: 'stdio', command: 'npx' });
      expect((await npx.json()).data).toMatchObject({
        isValid: false,
        errors: [
          { field: 'args', message: 'npx命令需要指定要执行的包名', code: 'NPX_MISSING_PACKAGE' },
        ],
      });

      const uvx = await jsonRequest('/validate', 'POST', { type: 'stdio', command: 'uvx' });
      expect((await uvx.json()).data.errors).toEqual([
        { field: 'args', message: 'uvx命令需要指定要执行的包名', code: 'UVX_MISSING_PACKAGE' },
      ]);
    });

    it('npx 携带 args 时不再报错', async () => {
      const response = await jsonRequest('/validate', 'POST', {
        type: 'stdio',
        command: 'npx',
        args: ['some-package'],
      });

      expect((await response.json()).data.errors).toEqual([]);
    });

    it('http 非本地地址给出安全警告但保持有效', async () => {
      const response = await jsonRequest('/validate', 'POST', {
        type: 'sse',
        url: 'http://example.com/sse',
      });

      const data = (await response.json()).data;
      expect(data.warnings).toEqual([
        {
          field: 'url',
          message: '使用HTTP协议连接非本地服务器可能存在安全风险',
          code: 'HTTP_SECURITY_WARNING',
        },
      ]);
      expect(data.errors).toEqual([]);
      expect(data.isValid).toBe(true);
    });

    it('http 本机地址与 https 不产生安全警告或协议错误', async () => {
      const local = await jsonRequest('/validate', 'POST', {
        type: 'sse',
        url: 'http://localhost:3000/sse',
      });
      const localData = (await local.json()).data;
      expect(localData.warnings).toEqual([]);
      expect(localData.errors).toEqual([]);

      const https = await jsonRequest('/validate', 'POST', {
        type: 'streaming',
        url: 'https://example.com/mcp',
      });
      const httpsData = (await https.json()).data;
      expect(httpsData.warnings).toEqual([]);
      expect(httpsData.errors).toEqual([]);
      expect(httpsData.isValid).toBe(true);
    });

    it('127.0.0.1 的 http 地址不产生安全警告', async () => {
      const response = await jsonRequest('/validate', 'POST', {
        type: 'sse',
        url: 'http://127.0.0.1:3000/sse',
      });

      expect((await response.json()).data.warnings).toEqual([]);
    });

    it('非 http/https 协议产生 INVALID_PROTOCOL 错误', async () => {
      const response = await jsonRequest('/validate', 'POST', {
        type: 'sse',
        url: 'ftp://example.com',
      });

      expect((await response.json()).data).toMatchObject({
        isValid: false,
        errors: [{ field: 'url', message: 'URL协议必须是http或https', code: 'INVALID_PROTOCOL' }],
      });
    });

    it('环境变量名含空格给出警告', async () => {
      const response = await jsonRequest('/validate', 'POST', {
        type: 'stdio',
        command: '/bin/node',
        env: { 'BAD KEY': 'value' },
      });

      expect((await response.json()).data.warnings).toEqual([
        {
          field: 'env.BAD KEY',
          message: '环境变量名包含空格，可能导致问题',
          code: 'ENV_KEY_SPACES_WARNING',
        },
      ]);
    });

    it('schema 校验失败时把 issue 映射为 errors 并保持 isValid=false', async () => {
      const response = await jsonRequest('/validate', 'POST', { type: 'stdio' });

      expect(response.status).toBe(200);
      const body = (await response.json()).data;
      expect(body.isValid).toBe(false);
      expect(body.errors[0]).toMatchObject({
        field: '',
        code: 'invalid_union',
      });
    });

    it('请求体非法 JSON 时返回 500', async () => {
      const response = await app.request('/api/servers/validate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'not-json',
      });

      expect(response.status).toBe(500);
      expect(await response.json()).toMatchObject({ success: false });
    });
  });

  describe('shutdownServersApi', () => {
    it('关闭已初始化的管理器并记录日志', async () => {
      // 确保管理器已初始化
      await app.request('/api/servers');
      manager.shutdown.mockClear();
      loggerMock.info.mockClear();

      const { shutdownServersApi } = await import('./index.js');
      await expect(shutdownServersApi()).resolves.toBeUndefined();
      expect(manager.shutdown).toHaveBeenCalledOnce();
      expect(loggerMock.info).toHaveBeenCalledWith('关闭服务器管理API');
      expect(loggerMock.info).toHaveBeenCalledWith('服务器管理API关闭完成');
    });

    it('管理器为空时仍正常完成且不重复关闭', async () => {
      const { shutdownServersApi } = await import('./index.js');
      // 先关闭，确保 serverManager 为 null
      await shutdownServersApi();
      manager.shutdown.mockClear();
      loggerMock.info.mockClear();

      await expect(shutdownServersApi()).resolves.toBeUndefined();
      expect(manager.shutdown).not.toHaveBeenCalled();
      expect(loggerMock.info).not.toHaveBeenCalledWith('关闭服务器管理API');
      expect(loggerMock.info).toHaveBeenCalledWith('服务器管理API关闭完成');
    });

    it('关闭出错时记录日志并抛出原始异常', async () => {
      // 触发一次管理器初始化（GET / 会惰性初始化）
      await app.request('/api/servers');
      manager.shutdown.mockRejectedValueOnce(new Error('shutdown 失败'));
      loggerMock.error.mockClear();

      const { shutdownServersApi } = await import('./index.js');
      await expect(shutdownServersApi()).rejects.toThrow('shutdown 失败');
      expect(loggerMock.error).toHaveBeenCalledWith(
        '服务器管理API关闭时发生错误',
        expect.any(Error),
      );
    });
  });
});
