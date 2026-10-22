/**
 * API到MCP API端点测试
 */

import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

    // Set service in context for routes
    app.use('*', async (c, next) => {
      c.set('apiToMcpWebService', mockApiToMcpService);
      await next();
    });

    app.route('/api/api-to-mcp', apiToMcpRoutes);
  });

  afterEach(() => {
    vi.clearAllMocks();
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
    });
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

      expect(body.success).toBe(false);
      expect(body.error.code).toBe('CREATE_API_CONFIG_FAILED');
      expect(body.error.message).toBe('配置ID已存在');
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
      expect(body.success).toBe(false);
      expect(body.error.code).toBe('INVALID_JSON');
      expect(body.error.message).toBe('请求体包含无效的JSON格式');
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

      expect(body.success).toBe(false);
      expect(body.error.code).toBe('UPDATE_API_CONFIG_FAILED');
      expect(body.error.message).toBe('配置ID不匹配');
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
