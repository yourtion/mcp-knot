/**
 * API到MCP Web服务测试
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { logger } from '../utils/logger.js';

import type { ApiToolConfig } from '../types/web-api.js';

// 创建mock函数
const mockApiToolIntegrationService = {
  initialize: vi.fn(),
  getApiTools: vi.fn(),
  executeApiTool: vi.fn(),
  getApiToolDefinition: vi.fn(),
  reloadConfig: vi.fn(),
  getStats: vi.fn(),
  getHealthStatus: vi.fn(),
  shutdown: vi.fn(),
};

// Mock API工具集成服务
vi.mock('./api_tool_integration_service.js', () => ({
  ApiToolIntegrationService: vi.fn(function (this: Record<string, unknown>) {
    Object.assign(this, mockApiToolIntegrationService);
  }),
}));

// Mock API配置管理器
const mockConfigManager = {
  loadConfig: vi.fn(),
  validateConfig: vi.fn(),
  watchConfigFile: vi.fn(),
  resolveEnvironmentVariables: vi.fn(),
  stopWatching: vi.fn(),
  getCurrentConfigPath: vi.fn(),
  reloadConfig: vi.fn(),
};

vi.mock('@mcp-core/mcp-knot-core/api-to-mcp', () => ({
  ApiConfigManagerImpl: vi.fn(function (this: Record<string, unknown>) {
    Object.assign(this, mockConfigManager);
  }),
  ConfigLoadError: class ConfigLoadError extends Error {
    constructor(
      message: string,
      public cause?: Error,
    ) {
      super(message);
      this.name = 'ConfigLoadError';
    }
  },
}));

// Mock文件系统操作
vi.mock('node:fs', async () => {
  const actual = await vi.importActual('node:fs');
  return {
    ...actual,
    promises: {
      mkdir: vi.fn(),
      writeFile: vi.fn(),
      readFile: vi.fn(),
      access: vi.fn(),
      stat: vi.fn().mockResolvedValue({ mtime: new Date(0) }),
    },
  };
});

describe('ApiToMcpWebService', () => {
  // biome-ignore lint/suspicious/noExplicitAny: dynamic import and mock
  let service: any;
  // biome-ignore lint/suspicious/noExplicitAny: dynamic import
  let ApiToMcpWebService: any;

  beforeEach(async () => {
    // 重置所有mock
    vi.clearAllMocks();

    // 动态导入服务类
    const module = await import('./api-to-mcp-web-service.js');
    ApiToMcpWebService = module.ApiToMcpWebService;
    service = new ApiToMcpWebService();

    // 设置默认的mock返回值
    mockApiToolIntegrationService.initialize.mockResolvedValue(undefined);
    mockApiToolIntegrationService.getApiTools.mockResolvedValue([]);
    mockApiToolIntegrationService.getStats.mockResolvedValue({
      totalApiTools: 0,
      initialized: true,
    });
    mockApiToolIntegrationService.getHealthStatus.mockReturnValue({
      initialized: true,
      healthy: true,
      serviceStatus: 'running',
    });
    mockConfigManager.loadConfig.mockResolvedValue([]);
    const fsMock = (await import('node:fs')).promises;
    vi.mocked(fsMock.readFile).mockImplementation(async () =>
      JSON.stringify({
        version: '1.0.0',
        tools: await mockConfigManager.loadConfig(),
      }),
    );
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('initialize', () => {
    it('应该成功初始化Web服务', async () => {
      const configPath = '/path/to/config.json';
      mockApiToolIntegrationService.initialize.mockResolvedValue(undefined);

      await service.initialize(configPath);

      expect(mockApiToolIntegrationService.initialize).toHaveBeenCalledWith(configPath);
    });

    it('应该在未提供配置路径时发出警告', async () => {
      const loggerSpy = vi.spyOn(logger, 'warn');
      mockApiToolIntegrationService.initialize.mockResolvedValue(undefined);

      await service.initialize();

      expect(loggerSpy).toHaveBeenCalledWith('未提供API配置文件路径，部分功能将不可用');
      expect(mockApiToolIntegrationService.initialize).toHaveBeenCalledWith(undefined);
    });

    it('应该正确处理初始化错误', async () => {
      const configPath = '/path/to/config.json';
      const error = new Error('初始化失败');
      mockApiToolIntegrationService.initialize.mockRejectedValue(error);

      await expect(service.initialize(configPath)).rejects.toThrow('初始化失败: 初始化失败');
    });
  });

  describe('getConfigs', () => {
    beforeEach(async () => {
      mockApiToolIntegrationService.initialize.mockResolvedValue(undefined);
      await service.initialize('/path/to/config.json');
    });

    it('应该成功获取API配置列表', async () => {
      const mockApiTools = [
        {
          name: 'test-tool',
          description: 'Test tool description',
          inputSchema: {
            type: 'object',
            properties: {},
          },
        },
      ];

      mockConfigManager.loadConfig.mockResolvedValue(
        mockApiTools.map((tool) => ({
          id: 'config-id',
          name: tool.name,
          description: tool.description,
          api: { url: 'https://example.com/qa', method: 'POST' },
          parameters: tool.inputSchema,
          response: {},
        })),
      );

      const result = await service.getConfigs();

      expect(result.configs).toHaveLength(1);
      expect(result.configs[0]).toEqual({
        id: 'config-id',
        name: 'test-tool',
        description: 'Test tool description',
        status: 'active',
        api: {
          url: 'https://example.com/qa',
          method: 'POST',
        },
        toolsGenerated: 1,
        lastUpdated: expect.any(String),
      });
    });

    it('应该正确处理获取配置列表错误', async () => {
      const error = new Error('获取失败');
      mockConfigManager.loadConfig.mockRejectedValue(error);

      await expect(service.getConfigs()).rejects.toThrow('获取配置列表失败: 获取失败');
    });
  });

  it('returns source templates rather than resolved runtime secrets for editing', async () => {
    await service.initialize('/path/to/config.json');
    const source = {
      id: 'templated',
      name: 'Template',
      description: 'QA',
      api: { url: 'https://example.com', method: 'GET', headers: { 'X-Key': '${QA_KEY}' } },
      parameters: { type: 'object', properties: {} },
      response: {},
    };
    mockConfigManager.loadConfig.mockResolvedValue([
      { ...source, api: { ...source.api, headers: { 'X-Key': 'resolved-value' } } },
    ]);
    const fsMock = (await import('node:fs')).promises;
    vi.mocked(fsMock.readFile).mockResolvedValue(
      JSON.stringify({ version: '1.0.0', tools: [source] }),
    );
    expect(await service.getConfigDetails(source.id)).toEqual(source);
  });

  describe('createConfig', () => {
    const validConfig: ApiToolConfig = {
      id: 'test-config',
      name: 'Test Config',
      description: 'Test configuration',
      api: {
        url: 'https://api.example.com/test',
        method: 'GET',
      },
      parameters: {
        type: 'object',
        properties: {
          param1: {
            type: 'string',
            description: 'Test parameter',
          },
        },
        required: ['param1'],
      },
      response: {},
    };

    beforeEach(async () => {
      mockConfigManager.loadConfig.mockResolvedValue([]);
      mockApiToolIntegrationService.initialize.mockResolvedValue(undefined);
      await service.initialize('/path/to/config.json');
    });

    it('应该成功创建新配置', async () => {
      mockApiToolIntegrationService.reloadConfig.mockResolvedValue(undefined);

      const result = await service.createConfig(validConfig);

      expect(result.success).toBe(true);
      expect(result.message).toBe('API配置创建成功');
      expect(result.config).toEqual(validConfig);
      expect(mockApiToolIntegrationService.reloadConfig).toHaveBeenCalled();
    });

    it('应该拒绝创建重复ID的配置', async () => {
      mockConfigManager.loadConfig.mockResolvedValue([validConfig]);

      const result = await service.createConfig(validConfig);

      expect(result.success).toBe(false);
      expect(result.message).toContain('已存在');
      expect(mockApiToolIntegrationService.reloadConfig).not.toHaveBeenCalled();
    });

    it('应该验证配置数据的完整性', async () => {
      const invalidConfig = { ...validConfig, id: '' };

      const result = await service.createConfig(invalidConfig);

      expect(result.success).toBe(false);
      expect(result.message).toBe('创建配置失败: 配置ID不能为空');
    });

    it('应该处理文件系统错误', async () => {
      const { promises: fsMock } = await import('node:fs');
      vi.mocked(fsMock.writeFile).mockRejectedValue(new Error('写入失败'));

      const result = await service.createConfig(validConfig);

      expect(result.success).toBe(false);
      expect(result.message).toBe('创建配置失败: 写入失败');
    });
  });

  describe('updateConfig', () => {
    const existingConfig: ApiToolConfig = {
      id: 'test-config',
      name: 'Test Config',
      description: 'Test configuration',
      api: {
        url: 'https://api.example.com/test',
        method: 'GET',
      },
      parameters: {
        type: 'object',
        properties: {},
      },
      response: {},
    };

    beforeEach(async () => {
      // 重置所有mock
      vi.clearAllMocks();

      // 设置默认的mock返回值
      mockApiToolIntegrationService.initialize.mockResolvedValue(undefined);
      mockApiToolIntegrationService.getApiTools.mockResolvedValue([]);
      mockApiToolIntegrationService.getStats.mockResolvedValue({
        totalApiTools: 0,
        initialized: true,
      });
      mockApiToolIntegrationService.getHealthStatus.mockReturnValue({
        initialized: true,
        healthy: true,
        serviceStatus: 'running',
      });
      mockConfigManager.loadConfig.mockResolvedValue([existingConfig]);

      // 重置文件系统mock
      const { promises: fsMock } = await import('node:fs');
      vi.mocked(fsMock.mkdir).mockResolvedValue(undefined);
      vi.mocked(fsMock.writeFile).mockResolvedValue(undefined);

      vi.mocked(fsMock.access).mockResolvedValue(undefined);

      await service.initialize('/path/to/config.json');
    });

    it('应该成功更新配置', async () => {
      const updatedConfig = {
        ...existingConfig,
        name: 'Updated Config',
      };

      mockApiToolIntegrationService.reloadConfig.mockResolvedValue(undefined);

      const result = await service.updateConfig('test-config', updatedConfig);

      expect(result.success).toBe(true);
      expect(result.message).toBe('API配置更新成功');
      expect(result.config).toEqual(updatedConfig);
      expect(mockApiToolIntegrationService.reloadConfig).toHaveBeenCalled();
    });

    it('应该拒绝ID不匹配的更新', async () => {
      const mismatchedConfig = { ...existingConfig, id: 'different-id' };

      const result = await service.updateConfig('test-config', mismatchedConfig);

      expect(result.success).toBe(false);
      expect(result.message).toBe('配置ID不匹配');
    });

    it('应该处理不存在的配置', async () => {
      const nonExistentConfig = { ...existingConfig, id: 'non-existent' };

      const result = await service.updateConfig('non-existent', nonExistentConfig);

      expect(result.success).toBe(false);
      expect(result.message).toContain('不存在');
    });
  });

  describe('deleteConfig', () => {
    const existingConfig: ApiToolConfig = {
      id: 'test-config',
      name: 'Test Config',
      description: 'Test configuration',
      api: {
        url: 'https://api.example.com/test',
        method: 'GET',
      },
      parameters: {
        type: 'object',
        properties: {},
      },
      response: {},
    };

    beforeEach(async () => {
      // 重置所有mock
      vi.clearAllMocks();

      // 设置默认的mock返回值
      mockApiToolIntegrationService.initialize.mockResolvedValue(undefined);
      mockApiToolIntegrationService.getApiTools.mockResolvedValue([]);
      mockApiToolIntegrationService.getStats.mockResolvedValue({
        totalApiTools: 0,
        initialized: true,
      });
      mockApiToolIntegrationService.getHealthStatus.mockReturnValue({
        initialized: true,
        healthy: true,
        serviceStatus: 'running',
      });
      mockConfigManager.loadConfig.mockResolvedValue([existingConfig]);

      // 重置文件系统mock
      const { promises: fsMock } = await import('node:fs');
      vi.mocked(fsMock.mkdir).mockResolvedValue(undefined);
      vi.mocked(fsMock.writeFile).mockResolvedValue(undefined);

      vi.mocked(fsMock.access).mockResolvedValue(undefined);

      await service.initialize('/path/to/config.json');
    });

    it('应该成功删除配置', async () => {
      mockApiToolIntegrationService.reloadConfig.mockResolvedValue(undefined);

      const result = await service.deleteConfig('test-config');

      expect(result.success).toBe(true);
      expect(result.message).toBe('API配置删除成功');
      expect(mockApiToolIntegrationService.reloadConfig).toHaveBeenCalled();
    });

    it('应该处理不存在的配置', async () => {
      const result = await service.deleteConfig('non-existent');

      expect(result.success).toBe(false);
      expect(result.message).toContain('不存在');
    });
  });

  describe('testConfig', () => {
    beforeEach(async () => {
      mockApiToolIntegrationService.initialize.mockResolvedValue(undefined);
      await service.initialize('/path/to/config.json');
    });

    it('应该成功测试配置', async () => {
      const mockResult = {
        isError: false,
        content: [
          {
            type: 'text',
            text: 'Test result',
          },
        ],
      };

      mockApiToolIntegrationService.executeApiTool.mockResolvedValue(mockResult);

      const parameters = { test: 'value' };
      const result = await service.testConfig('test-tool', parameters);

      expect(result.success).toBe(true);
      expect(result.response).toBe('Test result');
      expect(result.executionTime).toBeGreaterThanOrEqual(0);
      expect(mockApiToolIntegrationService.executeApiTool).toHaveBeenCalledWith(
        'test-tool',
        parameters,
      );
    });

    it('应该正确处理测试失败', async () => {
      const mockResult = {
        isError: true,
        content: [
          {
            type: 'text',
            text: 'Test error',
          },
        ],
      };

      mockApiToolIntegrationService.executeApiTool.mockResolvedValue(mockResult);

      const result = await service.testConfig('test-tool', {});

      expect(result.success).toBe(false);
      expect(result.error).toBe('Test error');
      expect(result.executionTime).toBeGreaterThanOrEqual(0);
    });

    it('应该处理测试执行错误', async () => {
      const error = new Error('测试失败');
      mockApiToolIntegrationService.executeApiTool.mockRejectedValue(error);

      const result = await service.testConfig('test-tool', {});

      expect(result.success).toBe(false);
      expect(result.error).toBe('测试失败: 测试失败');
      expect(result.executionTime).toBe(0);
    });
  });

  describe('getConfigDetails', () => {
    const existingConfig: ApiToolConfig = {
      id: 'test-config',
      name: 'Test Config',
      description: 'Test configuration',
      api: {
        url: 'https://api.example.com/test',
        method: 'GET',
      },
      parameters: {
        type: 'object',
        properties: {},
      },
      response: {},
    };

    beforeEach(async () => {
      mockConfigManager.loadConfig.mockResolvedValue([existingConfig]);
      mockApiToolIntegrationService.getApiToolDefinition.mockReturnValue({
        name: 'test-config',
        description: 'Test tool',
        inputSchema: {
          type: 'object',
          properties: {},
        },
        serverId: 'api-tools',
      });
      mockApiToolIntegrationService.initialize.mockResolvedValue(undefined);
      await service.initialize('/path/to/config.json');
    });

    it('应该成功获取配置详情', async () => {
      const result = await service.getConfigDetails('test-config');

      expect(result).toEqual(existingConfig);
    });

    it('应该返回null当配置不存在时', async () => {
      const result = await service.getConfigDetails('non-existent');

      expect(result).toBeNull();
    });
  });

  describe('getHealthStatus', () => {
    beforeEach(async () => {
      mockApiToolIntegrationService.getHealthStatus.mockReturnValue({
        initialized: true,
        healthy: true,
        serviceStatus: 'running',
      });
      mockApiToolIntegrationService.getStats.mockResolvedValue({
        totalApiTools: 5,
        initialized: true,
      });
      await service.initialize('/path/to/config.json');
    });

    it('应该返回正确的健康状态', async () => {
      const result = await service.getHealthStatus();

      expect(result.initialized).toBe(true);
      expect(result.healthy).toBe(true);
      expect(result.toolCount).toBe(5);
      expect(result.configPath).toBe('/path/to/config.json');
    });

    it('应该正确处理健康状态获取错误', async () => {
      mockApiToolIntegrationService.getHealthStatus.mockImplementation(() => {
        throw new Error('获取失败');
      });

      const result = await service.getHealthStatus();

      expect(result.initialized).toBe(false);
      expect(result.healthy).toBe(false);
      expect(result.toolCount).toBe(0);
      expect(result.errors).toBeDefined();
      expect(result.errors).toHaveLength(1);
      expect(result.errors?.[0]).toContain('获取健康状态失败');
    });
  });

  describe('getDefaultConfigPath', () => {
    it('应该返回默认的配置文件路径', () => {
      const path = ApiToMcpWebService.getDefaultConfigPath();

      expect(path).toMatch(/\.mcp-knot[\\/]api-tools\.json$/);
    });
  });

  describe('shutdown', () => {
    beforeEach(async () => {
      mockApiToolIntegrationService.initialize.mockResolvedValue(undefined);
      mockApiToolIntegrationService.shutdown.mockResolvedValue(undefined);
      await service.initialize('/path/to/config.json');
    });

    it('应该成功关闭服务', async () => {
      await service.shutdown();

      expect(mockApiToolIntegrationService.shutdown).toHaveBeenCalled();
    });

    it('应该正确处理关闭错误', async () => {
      const error = new Error('关闭失败');
      mockApiToolIntegrationService.shutdown.mockRejectedValue(error);

      await expect(service.shutdown()).rejects.toThrow('关闭失败');
    });
  });
});
