/**
 * API到MCP API端点测试
 */

import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const hubState = vi.hoisted(() => ({
  service: undefined as { reloadApiToolConfig: ReturnType<typeof vi.fn> } | undefined,
}));

vi.mock('../../services/service-registry.js', () => ({
  getHubServiceSafe: () => hubState.service,
  getHubService: () => hubState.service,
}));

const loggerMock = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock('../../utils/logger.js', () => ({ logger: loggerMock }));

import { apiToMcpRoutes } from './index.js';

import type { ApiToMcpWebService } from '../../services/api-to-mcp-web-service.js';

describe('API to MCP API Routes', () => {
  let app: Hono;
  let mockApiToMcpService: ApiToMcpWebService;

  beforeEach(() => {
    app = new Hono();

    mockApiToMcpService = {
      initialize: vi.fn(),
      getConfigs: vi.fn(),
      createConfig: vi.fn(),
      updateConfig: vi.fn(),
      deleteConfig: vi.fn(),
      testConfig: vi.fn(),
      getConfigDetails: vi.fn(),
      getHealthStatus: vi.fn(),
      reloadConfig: vi.fn(),
      shutdown: vi.fn(),
    } as unknown as ApiToMcpWebService;

    app.use('*', async (c, next) => {
      c.set('requestId', 'a2m-request');
      await next();
    });

    // Set service in context for routes
    app.use('*', async (c, next) => {
      c.set('apiToMcpWebService', mockApiToMcpService);
      await next();
    });

    app.route('/api/api-to-mcp', apiToMcpRoutes);
  });

  afterEach(() => {
    vi.clearAllMocks();
    hubState.service = undefined;
  });

  describe('GET /api/api-to-mcp/configs', () => {
    it('应该成功获取API配置列表', async () => {
      const mockConfigs = {
        configs: [
          {
            id: 'test-config',
            name: 'Test Config',
            description: 'Test configuration',
            status: 'active' as const,
            api: {
              url: 'https://api.example.com/test',
              method: 'GET' as const,
            },
            toolsGenerated: 1,
            lastUpdated: '2024-01-01T00:00:00Z',
          },
        ],
      };

      vi.mocked(mockApiToMcpService.getConfigs).mockResolvedValue(mockConfigs);

      const response = await app.request('/api/api-to-mcp/configs', {
        method: 'GET' as const,
        headers: {
          Authorization: 'Bearer test-token',
        },
      });

      expect(response.status).toBe(200);
      const body = await response.json();

      expect(body.success).toBe(true);
      expect(body.data).toEqual(mockConfigs);
      expect(loggerMock.info).toHaveBeenCalledWith('获取API配置列表');
    });

    it('应该处理获取配置列表错误', async () => {
      const error = new Error('获取失败');
      vi.mocked(mockApiToMcpService.getConfigs).mockRejectedValue(error);

      const response = await app.request('/api/api-to-mcp/configs', {
        method: 'GET' as const,
        headers: {
          Authorization: 'Bearer test-token',
        },
      });

      expect(response.status).toBe(500);
      const body = await response.json();

      expect(body.success).toBe(false);
      expect(body.error.message).toBe('获取失败');
      expect(loggerMock.error).toHaveBeenCalledWith('获取API配置列表失败', error);
    });
  });

  it('serves stats as a static route rather than treating stats as a config ID', async () => {
    vi.mocked(mockApiToMcpService.getConfigs).mockResolvedValue({ configs: [] });
    const response = await app.request('/api/api-to-mcp/configs/stats');
    expect(response.status).toBe(200);
    expect((await response.json()).data).toEqual({
      totalConfigs: 0,
      activeConfigs: 0,
      totalTools: 0,
      lastUpdated: '',
    });
    expect(mockApiToMcpService.getConfigDetails).not.toHaveBeenCalled();
  });

  describe('POST /api/api-to-mcp/configs', () => {
    const validConfig = {
      config: {
        id: 'new-config',
        name: 'New Config',
        description: 'New configuration',
        api: {
          url: 'https://api.example.com/new',
          method: 'POST' as const,
        },
        parameters: {
          type: 'object' as const,
          properties: {},
        },
        response: {},
      },
    };

    it('应该成功创建API配置', async () => {
      const mockResult = {
        success: true,
        message: 'API配置创建成功',
        config: validConfig.config,
      };

      vi.mocked(mockApiToMcpService.createConfig).mockResolvedValue(mockResult);

      const response = await app.request('/api/api-to-mcp/configs', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer test-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(validConfig),
      });

      expect(response.status).toBe(201);
      const body = await response.json();

      expect(body.success).toBe(true);
      expect(body.data.id).toBe('new-config');
      expect(body.data.message).toBe('API配置创建成功');
      expect(body.data.config).toEqual(validConfig.config);
      expect(loggerMock.info).toHaveBeenCalledWith('创建新的API配置', {
        context: { config: validConfig.config },
      });
      expect(loggerMock.info).toHaveBeenCalledWith('API配置创建成功', {
        context: { configId: 'new-config' },
      });
    });

    it('Hub 未初始化时创建成功并跳过同步', async () => {
      hubState.service = undefined;
      vi.mocked(mockApiToMcpService.createConfig).mockResolvedValue({
        success: true,
        message: 'API配置创建成功',
        config: validConfig.config,
      });

      const response = await app.request('/api/api-to-mcp/configs', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer test-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(validConfig),
      });

      expect(response.status).toBe(201);
      expect(loggerMock.debug).toHaveBeenCalledWith('Hub服务尚未初始化，跳过API工具同步');
    });

    it('Hub 已初始化时创建后同步 API 工具配置', async () => {
      const reloadApiToolConfig = vi.fn().mockResolvedValue(undefined);
      hubState.service = { reloadApiToolConfig };
      vi.mocked(mockApiToMcpService.createConfig).mockResolvedValue({
        success: true,
        message: 'API配置创建成功',
        config: validConfig.config,
      });

      const response = await app.request('/api/api-to-mcp/configs', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer test-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(validConfig),
      });

      expect(response.status).toBe(201);
      expect(reloadApiToolConfig).toHaveBeenCalledOnce();
      expect(loggerMock.info).toHaveBeenCalledWith('Hub服务API工具配置同步完成');
    });

    it('Hub 同步失败不影响创建结果', async () => {
      const reloadApiToolConfig = vi.fn().mockRejectedValue(new Error('同步失败'));
      hubState.service = { reloadApiToolConfig };
      vi.mocked(mockApiToMcpService.createConfig).mockResolvedValue({
        success: true,
        message: 'API配置创建成功',
        config: validConfig.config,
      });

      const response = await app.request('/api/api-to-mcp/configs', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer test-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(validConfig),
      });

      expect(response.status).toBe(201);
      expect(loggerMock.warn).toHaveBeenCalledWith(
        'Hub服务API工具配置同步失败，不影响配置管理操作',
        {
          error: '同步失败',
        },
      );
    });

    it('应该处理创建配置错误', async () => {
      const mockResult = {
        success: false,
        message: '配置ID已存在',
      };

      vi.mocked(mockApiToMcpService.createConfig).mockResolvedValue(mockResult);

      const response = await app.request('/api/api-to-mcp/configs', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer test-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(validConfig),
      });

      expect(response.status).toBe(400);
      const body = await response.json();

      expect(body).toEqual({
        success: false,
        error: { code: 'CREATE_API_CONFIG_FAILED', message: '配置ID已存在' },
        requestId: 'a2m-request',
      });
    });

    it('应该验证请求数据格式', async () => {
      const response = await app.request('/api/api-to-mcp/configs', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer test-token',
          'Content-Type': 'application/json',
        },
        body: 'invalid json',
      });

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body).toEqual({
        success: false,
        error: { code: 'INVALID_JSON', message: '请求体包含无效的JSON格式' },
        requestId: 'a2m-request',
      });
      expect(loggerMock.error).toHaveBeenCalledWith('创建API配置失败', expect.any(SyntaxError));
    });

    it('非 JSON 解析类错误不应误判为 INVALID_JSON（返回 500）', async () => {
      // SyntaxError 但 message 不含 'JSON' 关键字 → 不走 INVALID_JSON 分支
      vi.mocked(mockApiToMcpService.createConfig).mockRejectedValue(
        new SyntaxError('parse failed elsewhere'),
      );

      const response = await app.request('/api/api-to-mcp/configs', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer test-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(validConfig),
      });

      expect(response.status).toBe(500);
      const body = await response.json();
      expect(body.error?.code ?? body.error).not.toBe('INVALID_JSON');
    });

    it('message 为 null 的 SyntaxError 不会导致处理器崩溃', async () => {
      const syntaxError = new SyntaxError();
      Object.defineProperty(syntaxError, 'message', { value: null });
      vi.mocked(mockApiToMcpService.createConfig).mockRejectedValue(syntaxError);

      const response = await app.request('/api/api-to-mcp/configs', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer test-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(validConfig),
      });

      expect(response.status).toBe(500);
      const body = await response.json();
      expect(body.success).toBe(false);
    });
  });

  describe('PUT /api/api-to-mcp/configs/:id', () => {
    const configId = 'test-config';
    const validConfig = {
      config: {
        id: 'test-config',
        name: 'Updated Config',
        description: 'Updated configuration',
        api: {
          url: 'https://api.example.com/updated',
          method: 'PUT' as const,
        },
        parameters: {
          type: 'object' as const,
          properties: {},
        },
        response: {},
      },
    };

    it('应该成功更新API配置', async () => {
      const mockResult = {
        success: true,
        message: 'API配置更新成功',
        config: validConfig.config,
      };

      vi.mocked(mockApiToMcpService.updateConfig).mockResolvedValue(mockResult);

      const response = await app.request(`/api/api-to-mcp/configs/${configId}`, {
        method: 'PUT' as const,
        headers: {
          Authorization: 'Bearer test-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(validConfig),
      });

      expect(response.status).toBe(200);
      const body = await response.json();

      expect(body.success).toBe(true);
      expect(body.data.id).toBe(configId);
      expect(body.data.message).toBe('API配置更新成功');
      expect(body.data.config).toEqual(validConfig.config);
      expect(loggerMock.info).toHaveBeenCalledWith('更新API配置', {
        context: { configId, config: validConfig.config },
      });
      expect(loggerMock.info).toHaveBeenCalledWith('API配置更新成功', {
        context: { configId },
      });
    });

    it('应该拒绝ID不匹配的更新', async () => {
      const mismatchedConfig = {
        config: {
          ...validConfig.config,
          id: 'different-id',
        },
      };

      const response = await app.request(`/api/api-to-mcp/configs/${configId}`, {
        method: 'PUT' as const,
        headers: {
          Authorization: 'Bearer test-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(mismatchedConfig),
      });

      expect(response.status).toBe(400);
      const body = await response.json();

      expect(body).toEqual({
        success: false,
        error: { code: 'UPDATE_API_CONFIG_FAILED', message: '配置ID不匹配' },
        requestId: 'a2m-request',
      });
    });

    it('配置缺少 name 时返回 INVALID_CONFIG', async () => {
      const response = await app.request(`/api/api-to-mcp/configs/${configId}`, {
        method: 'PUT' as const,
        headers: {
          Authorization: 'Bearer test-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ config: { id: configId } }),
      });

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        success: false,
        error: { code: 'INVALID_CONFIG', message: '配置数据无效：缺少必要字段' },
        requestId: 'a2m-request',
      });
      expect(vi.mocked(mockApiToMcpService.updateConfig)).not.toHaveBeenCalled();
    });

    it('配置整体缺失时返回 INVALID_CONFIG 而非 500', async () => {
      const response = await app.request(`/api/api-to-mcp/configs/${configId}`, {
        method: 'PUT' as const,
        headers: {
          Authorization: 'Bearer test-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({}),
      });

      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        success: false,
        error: { code: 'INVALID_CONFIG' },
      });
    });

    it('更新服务返回失败时透传消息', async () => {
      vi.mocked(mockApiToMcpService.updateConfig).mockResolvedValue({
        success: false,
        message: '配置不存在',
      });

      const response = await app.request(`/api/api-to-mcp/configs/${configId}`, {
        method: 'PUT' as const,
        headers: {
          Authorization: 'Bearer test-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(validConfig),
      });

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        success: false,
        error: { code: 'UPDATE_API_CONFIG_FAILED', message: '配置不存在' },
        requestId: 'a2m-request',
      });
    });

    it('更新服务抛错时返回 500', async () => {
      vi.mocked(mockApiToMcpService.updateConfig).mockRejectedValue(new Error('更新崩溃'));

      const response = await app.request(`/api/api-to-mcp/configs/${configId}`, {
        method: 'PUT' as const,
        headers: {
          Authorization: 'Bearer test-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(validConfig),
      });

      expect(response.status).toBe(500);
      expect(await response.json()).toMatchObject({
        success: false,
        requestId: 'a2m-request',
      });
      expect(loggerMock.error).toHaveBeenCalledWith('更新API配置失败', expect.any(Error));
    });
  });

  describe('DELETE /api/api-to-mcp/configs/:id', () => {
    const configId = 'test-config';

    it('应该成功删除API配置', async () => {
      const mockResult = {
        success: true,
        message: 'API配置删除成功',
      };

      vi.mocked(mockApiToMcpService.deleteConfig).mockResolvedValue(mockResult);

      const response = await app.request(`/api/api-to-mcp/configs/${configId}`, {
        method: 'DELETE' as const,
        headers: {
          Authorization: 'Bearer test-token',
        },
      });

      expect(response.status).toBe(200);
      const body = await response.json();

      expect(body.success).toBe(true);
      expect(body.data.id).toBe(configId);
      expect(body.data.message).toBe('API配置删除成功');
    });

    it('应该处理删除不存在的配置', async () => {
      const mockResult = {
        success: false,
        message: '配置 non-existent 不存在',
      };

      vi.mocked(mockApiToMcpService.deleteConfig).mockResolvedValue(mockResult);

      const response = await app.request('/api/api-to-mcp/configs/non-existent', {
        method: 'DELETE' as const,
        headers: {
          Authorization: 'Bearer test-token',
        },
      });

      expect(response.status).toBe(400);
      const body = await response.json();

      expect(body.success).toBe(false);
      expect(body.error.code).toBe('DELETE_API_CONFIG_FAILED');
      expect(body.error.message).toBe('配置 non-existent 不存在');
    });
  });

  describe('POST /api/api-to-mcp/configs/:id/test', () => {
    const configId = 'test-config';
    const validParameters = {
      parameters: {
        param1: 'test-value',
      },
    };

    it('应该成功测试API配置', async () => {
      const mockResult = {
        success: true,
        response: 'Test response',
        executionTime: 150,
      };

      vi.mocked(mockApiToMcpService.testConfig).mockResolvedValue(mockResult);

      const response = await app.request(`/api/api-to-mcp/configs/${configId}/test`, {
        method: 'POST' as const,
        headers: {
          Authorization: 'Bearer test-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(validParameters),
      });

      expect(response.status).toBe(200);
      const body = await response.json();

      expect(body.success).toBe(true);
      expect(body.response).toBe('Test response');
      expect(body.executionTime).toBe(150);
    });

    it('应该正确处理测试失败', async () => {
      const mockResult = {
        success: false,
        error: 'Test failed',
        executionTime: 200,
      };

      vi.mocked(mockApiToMcpService.testConfig).mockResolvedValue(mockResult);

      const response = await app.request(`/api/api-to-mcp/configs/${configId}/test`, {
        method: 'POST' as const,
        headers: {
          Authorization: 'Bearer test-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(validParameters),
      });

      expect(response.status).toBe(200);
      const body = await response.json();

      expect(body.success).toBe(false);
      expect(body.error).toBe('Test failed');
      expect(body.executionTime).toBe(200);
    });
  });

  describe('GET /api/api-to-mcp/configs/:id', () => {
    const configId = 'test-config';

    it('应该成功获取API配置详情', async () => {
      const mockConfig = {
        id: 'test-config',
        name: 'Test Config',
        description: 'Test configuration',
        api: {
          url: 'https://api.example.com/test',
          method: 'GET' as const,
        },
        parameters: {
          type: 'object' as const,
          properties: {},
        },
        response: {},
      };

      vi.mocked(mockApiToMcpService.getConfigDetails).mockResolvedValue(mockConfig);

      const response = await app.request(`/api/api-to-mcp/configs/${configId}`, {
        method: 'GET' as const,
        headers: {
          Authorization: 'Bearer test-token',
        },
      });

      expect(response.status).toBe(200);
      const body = await response.json();

      expect(body.success).toBe(true);
      expect(body.data).toEqual(mockConfig);
    });

    it('应该处理获取不存在的配置详情', async () => {
      vi.mocked(mockApiToMcpService.getConfigDetails).mockResolvedValue(null);

      const response = await app.request(`/api/api-to-mcp/configs/non-existent`, {
        method: 'GET' as const,
        headers: {
          Authorization: 'Bearer test-token',
        },
      });

      expect(response.status).toBe(404);
      const body = await response.json();

      expect(body.success).toBe(false);
      expect(body.error.code).toBe('API_CONFIG_NOT_FOUND');
      expect(body.error.message).toBe('API配置 non-existent 不存在');
    });
  });

  describe('服务不可用场景', () => {
    it('服务未注入到上下文时应返回503错误', async () => {
      // 创建一个没有注入服务的 app
      const appWithoutService = new Hono();
      appWithoutService.route('/api/api-to-mcp', apiToMcpRoutes);

      const response = await appWithoutService.request('/api/api-to-mcp/configs', {
        method: 'GET' as const,
        headers: {
          Authorization: 'Bearer test-token',
        },
      });

      expect(response.status).toBe(503);
      const body = await response.json();
      expect(body.error.code).toBe('SERVICE_UNAVAILABLE');
    });

    it('创建配置缺少必填字段时应返回失败', async () => {
      const incompleteConfig = {
        config: {
          id: '',
          name: '',
          description: '',
          api: { url: '', method: '' },
          parameters: { type: 'object' as const, properties: {} },
          response: {},
        },
      };

      vi.mocked(mockApiToMcpService.createConfig).mockResolvedValue({
        success: false,
        message: '创建配置失败: 配置ID不能为空',
      });

      const response = await app.request('/api/api-to-mcp/configs', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer test-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(incompleteConfig),
      });

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.success).toBe(false);
      expect(body.error.message).toContain('配置ID不能为空');
    });
  });
});
