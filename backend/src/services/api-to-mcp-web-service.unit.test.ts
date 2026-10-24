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

      mockApiToolIntegrationService.getApiTools.mockResolvedValue(mockApiTools);

      const result = await service.getConfigs();

      expect(result.configs).toHaveLength(1);
      expect(result.configs[0]).toEqual({
        id: 'test-tool',
        name: 'test-tool',
        description: 'Test tool description',
        status: 'active',
        api: {
          url: '',
          method: 'GET',
        },
        toolsGenerated: 1,
        lastUpdated: expect.any(String),
      });
    });

    it('应该正确处理获取配置列表错误', async () => {
      const error = new Error('获取失败');
      mockApiToolIntegrationService.getApiTools.mockRejectedValue(error);

      await expect(service.getConfigs()).rejects.toThrow('获取配置列表失败: 获取失败');
    });
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
      vi.mocked(fsMock.readFile).mockResolvedValue('{}');
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
      vi.mocked(fsMock.readFile).mockResolvedValue('{}');
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

  describe('initialize 补充（日志断言）', () => {
    it('初始化成功记录开始与完成日志', async () => {
      const infoSpy = vi.spyOn(logger, 'info');

      await service.initialize('/path/to/config.json');

      expect(infoSpy).toHaveBeenCalledWith('初始化API到MCP Web服务', {
        configPath: '/path/to/config.json',
      });
      expect(infoSpy).toHaveBeenCalledWith('API到MCP Web服务初始化完成', {
        configPath: '/path/to/config.json',
      });
    });

    it('初始化失败记录错误日志', async () => {
      const errorSpy = vi.spyOn(logger, 'error');
      mockApiToolIntegrationService.initialize.mockRejectedValue(new Error('boom'));

      await expect(service.initialize('/path/to/config.json')).rejects.toThrow('初始化失败: boom');
      expect(errorSpy).toHaveBeenCalledWith('API到MCP Web服务初始化失败', expect.any(Error));
    });
  });

  describe('createConfig 持久化与校验（补强）', () => {
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
          param1: { type: 'string', description: 'Test parameter' },
        },
        required: ['param1'],
      },
      response: {},
    };

    let fsMock: { mkdir: ReturnType<typeof vi.fn>; writeFile: ReturnType<typeof vi.fn> };

    const writtenContent = (): { version: string; tools: unknown[] } => {
      const call = vi.mocked(fsMock.writeFile).mock.calls[0];
      return JSON.parse(call[1] as string) as { version: string; tools: unknown[] };
    };

    beforeEach(async () => {
      const { promises } = await import('node:fs');
      fsMock = promises as unknown as {
        mkdir: ReturnType<typeof vi.fn>;
        writeFile: ReturnType<typeof vi.fn>;
      };
      vi.mocked(fsMock.mkdir).mockResolvedValue(undefined);
      vi.mocked(fsMock.writeFile).mockResolvedValue(undefined);
      mockConfigManager.loadConfig.mockResolvedValue([]);
      mockApiToolIntegrationService.initialize.mockResolvedValue(undefined);
      mockApiToolIntegrationService.reloadConfig.mockResolvedValue(undefined);
      await service.initialize('/tmp/dir/api-tools.json');
    });

    it('成功创建：mkdir 递归创建目录并写入完整配置对象', async () => {
      const infoSpy = vi.spyOn(logger, 'info');

      const result = await service.createConfig(validConfig);

      expect(result).toStrictEqual({
        success: true,
        message: 'API配置创建成功',
        config: validConfig,
      });
      expect(fsMock.mkdir).toHaveBeenCalledWith('/tmp/dir', { recursive: true });
      expect(writtenContent()).toStrictEqual({ version: '1.0.0', tools: [validConfig] });
      expect(fsMock.writeFile).toHaveBeenCalledWith(
        '/tmp/dir/api-tools.json',
        expect.any(String),
        'utf-8',
      );
      expect(infoSpy).toHaveBeenCalledWith('API配置创建成功', { configId: 'test-config' });
    });

    it('重复 ID：精确消息且不写文件不重载', async () => {
      mockConfigManager.loadConfig.mockResolvedValue([validConfig]);

      const result = await service.createConfig(validConfig);

      expect(result).toStrictEqual({ success: false, message: "配置ID 'test-config' 已存在" });
      expect(fsMock.writeFile).not.toHaveBeenCalled();
      expect(mockApiToolIntegrationService.reloadConfig).not.toHaveBeenCalled();
    });

    it('未初始化时创建：精确错误消息', async () => {
      const fresh = new ApiToMcpWebService();

      const result = await fresh.createConfig(validConfig);

      expect(result).toStrictEqual({
        success: false,
        message: '创建配置失败: 配置文件路径未设置，无法创建配置',
        error: '配置文件路径未设置，无法创建配置',
      });
    });

    it.each([
      ['id 为空白字符串', { id: '   ' }, '配置ID不能为空'],
      ['name 为空白字符串', { name: '   ' }, '配置名称不能为空'],
      ['description 为空字符串', { description: '' }, '配置描述不能为空'],
      ['api 缺失', { api: undefined }, 'API配置不完整'],
      ['api.url 缺失', { api: { method: 'GET' } }, 'API配置不完整'],
      ['api.method 缺失', { api: { url: 'https://api.example.com' } }, 'API配置不完整'],
      [
        'api.method 为空字符串',
        { api: { url: 'https://api.example.com', method: '' } },
        'API配置不完整',
      ],
      ['parameters 缺失', { parameters: undefined }, '参数配置不完整'],
      ['parameters 无 properties', { parameters: { type: 'object' } }, '参数配置不完整'],
    ])('校验失败：%s', async (_label, overrides, expectedMessage) => {
      const invalidConfig = { ...validConfig, ...overrides } as unknown as ApiToolConfig;

      const result = await service.createConfig(invalidConfig);

      expect(result.success).toBe(false);
      expect(result.message).toBe(`创建配置失败: ${expectedMessage}`);
      expect(fsMock.writeFile).not.toHaveBeenCalled();
    });

    it('配置文件不存在（ENOENT）视为空配置继续创建', async () => {
      const { ConfigLoadError } = await import('@mcp-core/mcp-knot-core/api-to-mcp');
      const enoentError = new ConfigLoadError(
        'load failed',
        Object.assign(new Error('no such file'), { code: 'ENOENT' }),
      );
      mockConfigManager.loadConfig.mockRejectedValue(enoentError);

      const result = await service.createConfig(validConfig);

      expect(result.success).toBe(true);
      expect(writtenContent()).toStrictEqual({ version: '1.0.0', tools: [validConfig] });
    });

    it('加载配置的其它错误向上传递为失败结果', async () => {
      mockConfigManager.loadConfig.mockRejectedValue(new Error('disk corrupted'));

      const result = await service.createConfig(validConfig);

      expect(result).toStrictEqual({
        success: false,
        message: '创建配置失败: disk corrupted',
        error: 'disk corrupted',
      });
    });

    it('configManager 缺失但路径已设置时按空配置处理', async () => {
      service.configManager = undefined;

      const result = await service.createConfig({ ...validConfig, id: 'another' });

      expect(result.success).toBe(true);
      expect(mockConfigManager.loadConfig).not.toHaveBeenCalled();
      expect(writtenContent()).toStrictEqual({
        version: '1.0.0',
        tools: [{ ...validConfig, id: 'another' }],
      });
    });

    it('mkdir 报 EEXIST 时忽略错误继续写文件', async () => {
      vi.mocked(fsMock.mkdir).mockRejectedValue(
        Object.assign(new Error('directory exists'), { code: 'EEXIST' }),
      );

      const result = await service.createConfig(validConfig);

      expect(result.success).toBe(true);
      expect(fsMock.writeFile).toHaveBeenCalled();
    });

    it('mkdir 报其它错误时创建失败', async () => {
      vi.mocked(fsMock.mkdir).mockRejectedValue(
        Object.assign(new Error('permission denied'), { code: 'EACCES' }),
      );

      const result = await service.createConfig(validConfig);

      expect(result.success).toBe(false);
      expect(result.message).toBe('创建配置失败: permission denied');
      expect(fsMock.writeFile).not.toHaveBeenCalled();
    });
  });

  describe('updateConfig 补强', () => {
    const existingConfig: ApiToolConfig = {
      id: 'test-config',
      name: 'Test Config',
      description: 'Test configuration',
      api: { url: 'https://api.example.com/test', method: 'GET' },
      parameters: { type: 'object', properties: {} },
      response: {},
    };

    let fsMock: { mkdir: ReturnType<typeof vi.fn>; writeFile: ReturnType<typeof vi.fn> };

    const writtenContent = (): { version: string; tools: unknown[] } => {
      const call = vi.mocked(fsMock.writeFile).mock.calls[0];
      return JSON.parse(call[1] as string) as { version: string; tools: unknown[] };
    };

    beforeEach(async () => {
      const { promises } = await import('node:fs');
      fsMock = promises as unknown as {
        mkdir: ReturnType<typeof vi.fn>;
        writeFile: ReturnType<typeof vi.fn>;
      };
      vi.mocked(fsMock.mkdir).mockResolvedValue(undefined);
      vi.mocked(fsMock.writeFile).mockResolvedValue(undefined);
      mockConfigManager.loadConfig.mockResolvedValue([existingConfig]);
      mockApiToolIntegrationService.initialize.mockResolvedValue(undefined);
      mockApiToolIntegrationService.reloadConfig.mockResolvedValue(undefined);
      await service.initialize('/tmp/dir/api-tools.json');
    });

    it('成功更新：文件内容只包含更新后的配置', async () => {
      const updated = { ...existingConfig, name: 'Updated Config' };

      const result = await service.updateConfig('test-config', updated);

      expect(result).toStrictEqual({
        success: true,
        message: 'API配置更新成功',
        config: updated,
      });
      expect(writtenContent()).toStrictEqual({ version: '1.0.0', tools: [updated] });
    });

    it('未初始化时更新：精确错误消息', async () => {
      const fresh = new ApiToMcpWebService();

      const result = await fresh.updateConfig('test-config', existingConfig);

      expect(result).toStrictEqual({
        success: false,
        message: '更新配置失败: 配置文件路径未设置，无法更新配置',
        error: '配置文件路径未设置，无法更新配置',
      });
    });

    it('ID 不匹配：精确消息', async () => {
      const result = await service.updateConfig('test-config', {
        ...existingConfig,
        id: 'different-id',
      });

      expect(result).toStrictEqual({ success: false, message: '配置ID不匹配' });
    });

    it('配置不存在：精确消息且不写文件', async () => {
      const result = await service.updateConfig('nope', { ...existingConfig, id: 'nope' });

      expect(result).toStrictEqual({ success: false, message: "配置 'nope' 不存在" });
      expect(fsMock.writeFile).not.toHaveBeenCalled();
    });

    it('写文件失败：失败结果', async () => {
      vi.mocked(fsMock.writeFile).mockRejectedValue(new Error('写入失败'));

      const result = await service.updateConfig('test-config', existingConfig);

      expect(result).toStrictEqual({
        success: false,
        message: '更新配置失败: 写入失败',
        error: '写入失败',
      });
    });
  });

  describe('deleteConfig 补强', () => {
    const existingConfig: ApiToolConfig = {
      id: 'test-config',
      name: 'Test Config',
      description: 'Test configuration',
      api: { url: 'https://api.example.com/test', method: 'GET' },
      parameters: { type: 'object', properties: {} },
      response: {},
    };

    let fsMock: { mkdir: ReturnType<typeof vi.fn>; writeFile: ReturnType<typeof vi.fn> };

    const writtenContent = (): { version: string; tools: unknown[] } => {
      const call = vi.mocked(fsMock.writeFile).mock.calls[0];
      return JSON.parse(call[1] as string) as { version: string; tools: unknown[] };
    };

    beforeEach(async () => {
      const { promises } = await import('node:fs');
      fsMock = promises as unknown as {
        mkdir: ReturnType<typeof vi.fn>;
        writeFile: ReturnType<typeof vi.fn>;
      };
      vi.mocked(fsMock.mkdir).mockResolvedValue(undefined);
      vi.mocked(fsMock.writeFile).mockResolvedValue(undefined);
      mockConfigManager.loadConfig.mockResolvedValue([existingConfig]);
      mockApiToolIntegrationService.initialize.mockResolvedValue(undefined);
      mockApiToolIntegrationService.reloadConfig.mockResolvedValue(undefined);
      await service.initialize('/tmp/dir/api-tools.json');
    });

    it('成功删除：文件 tools 列表为空', async () => {
      const infoSpy = vi.spyOn(logger, 'info');

      const result = await service.deleteConfig('test-config');

      expect(result).toStrictEqual({ success: true, message: 'API配置删除成功' });
      expect(writtenContent()).toStrictEqual({ version: '1.0.0', tools: [] });
      expect(infoSpy).toHaveBeenCalledWith('API配置删除成功', { configId: 'test-config' });
    });

    it('未初始化时删除：精确错误消息', async () => {
      const fresh = new ApiToMcpWebService();

      const result = await fresh.deleteConfig('test-config');

      expect(result).toStrictEqual({
        success: false,
        message: '删除配置失败: 配置文件路径未设置，无法删除配置',
        error: '配置文件路径未设置，无法删除配置',
      });
    });

    it('配置不存在：精确消息且不写文件', async () => {
      const result = await service.deleteConfig('nope');

      expect(result).toStrictEqual({ success: false, message: "配置 'nope' 不存在" });
      expect(fsMock.writeFile).not.toHaveBeenCalled();
    });

    it('写文件失败：失败结果', async () => {
      vi.mocked(fsMock.writeFile).mockRejectedValue(new Error('写入失败'));

      const result = await service.deleteConfig('test-config');

      expect(result).toStrictEqual({
        success: false,
        message: '删除配置失败: 写入失败',
        error: '写入失败',
      });
    });
  });

  describe('testConfig 补强', () => {
    beforeEach(async () => {
      mockApiToolIntegrationService.initialize.mockResolvedValue(undefined);
      await service.initialize('/path/to/config.json');
    });

    it('executionTime 为结束与开始时间差（fake timers 下精确为 0）', async () => {
      const infoSpy = vi.spyOn(logger, 'info');
      vi.useFakeTimers();
      try {
        mockApiToolIntegrationService.executeApiTool.mockResolvedValue({
          isError: false,
          content: [{ type: 'text', text: 'ok' }],
        });

        const result = await service.testConfig('t', {});

        expect(result).toStrictEqual({
          success: true,
          response: 'ok',
          error: undefined,
          executionTime: 0,
        });
        expect(infoSpy).toHaveBeenCalledWith('API配置测试完成', {
          configId: 't',
          success: true,
          executionTime: 0,
        });
      } finally {
        vi.useRealTimers();
      }
    });

    it('成功但 content 为空：response 为 undefined 不抛错', async () => {
      mockApiToolIntegrationService.executeApiTool.mockResolvedValue({
        isError: false,
        content: [],
      });

      const result = await service.testConfig('t', {});

      expect(result.success).toBe(true);
      expect(result.response).toBeUndefined();
      expect(result.error).toBeUndefined();
    });

    it('isError 且 content 为空：error 为 undefined 不抛错', async () => {
      mockApiToolIntegrationService.executeApiTool.mockResolvedValue({
        isError: true,
        content: [],
      });

      const result = await service.testConfig('t', {});

      expect(result).toStrictEqual({
        success: false,
        response: undefined,
        error: undefined,
        executionTime: expect.any(Number),
      });
    });

    it('执行抛错时记录错误日志', async () => {
      const errorSpy = vi.spyOn(logger, 'error');
      mockApiToolIntegrationService.executeApiTool.mockRejectedValue(new Error('boom'));

      const result = await service.testConfig('t', {});

      expect(result.success).toBe(false);
      expect(errorSpy).toHaveBeenCalledWith('测试API配置失败', expect.any(Error));
    });
  });

  describe('getConfigs schema 提取（补强）', () => {
    beforeEach(async () => {
      mockApiToolIntegrationService.initialize.mockResolvedValue(undefined);
      await service.initialize('/path/to/config.json');
    });

    const fetchConfigs = async (
      inputSchema: Record<string, unknown>,
      schemaDescription?: string,
    ): Promise<{ url: string; method: string }> => {
      mockApiToolIntegrationService.getApiTools.mockResolvedValue([
        {
          name: 'a-tool',
          description: 'tool description',
          inputSchema: { ...inputSchema, description: schemaDescription },
        },
      ]);
      const result = await service.getConfigs();
      return result.configs[0].api;
    };

    it('从描述中提取 https URL', async () => {
      const api = await fetchConfigs(
        { type: 'object', properties: {} },
        '调用 https://api.example.com/v1/data 获取数据',
      );
      expect(api.url).toBe('https://api.example.com/v1/data');
    });

    it('支持 http URL（非 https）', async () => {
      const api = await fetchConfigs(
        { type: 'object', properties: {} },
        'see http://plain.example.com/x end',
      );
      expect(api.url).toBe('http://plain.example.com/x');
    });

    it('描述无 URL：返回空串并按有描述告警', async () => {
      const warnSpy = vi.spyOn(logger, 'warn');
      const api = await fetchConfigs({ type: 'object', properties: {} }, 'no url here');
      expect(api.url).toBe('');
      expect(warnSpy).toHaveBeenCalledWith('No API URL found in schema, returning empty string', {
        hasDescription: true,
      });
    });

    it('无描述：hasDescription 为 false', async () => {
      const warnSpy = vi.spyOn(logger, 'warn');
      const api = await fetchConfigs({ type: 'object', properties: {} }, undefined);
      expect(api.url).toBe('');
      expect(warnSpy).toHaveBeenCalledWith('No API URL found in schema, returning empty string', {
        hasDescription: false,
      });
    });

    it('提取到 URL 时不告警', async () => {
      const warnSpy = vi.spyOn(logger, 'warn');
      await fetchConfigs(
        { type: 'object', properties: {} },
        '调用 https://api.example.com/v1/data 获取数据',
      );
      expect(warnSpy).not.toHaveBeenCalledWith(
        'No API URL found in schema, returning empty string',
        expect.anything(),
      );
    });

    it('method.default 优先且转大写', async () => {
      const api = await fetchConfigs({
        type: 'object',
        properties: { method: { type: 'string', default: 'post' } },
      });
      expect(api.method).toBe('POST');
    });

    it('method.default 优先于 enum', async () => {
      const api = await fetchConfigs({
        type: 'object',
        properties: { method: { type: 'string', default: 'delete', enum: ['POST'] } },
      });
      expect(api.method).toBe('DELETE');
    });

    it('method.enum 数组取第一个', async () => {
      const api = await fetchConfigs({
        type: 'object',
        properties: { method: { type: 'string', enum: ['PUT', 'GET'] } },
      });
      expect(api.method).toBe('PUT');
    });

    it('method.enum 非数组时忽略并回退 GET', async () => {
      const api = await fetchConfigs({
        type: 'object',
        properties: { method: { type: 'string', enum: 'GET' } },
      });
      expect(api.method).toBe('GET');
    });

    it('properties 存在但无 method：回退 GET', async () => {
      const api = await fetchConfigs({ type: 'object', properties: {} });
      expect(api.method).toBe('GET');
    });

    it('无 properties 键：回退 GET 且不抛错', async () => {
      const api = await fetchConfigs({ type: 'object' });
      expect(api.method).toBe('GET');
    });

    it('method.default 非字符串时忽略并回退 GET', async () => {
      const api = await fetchConfigs({
        type: 'object',
        properties: { method: { type: 'number', default: 42 } },
      });
      expect(api.method).toBe('GET');
    });
  });

  describe('getConfigDetails 补充', () => {
    beforeEach(async () => {
      mockApiToolIntegrationService.initialize.mockResolvedValue(undefined);
      await service.initialize('/path/to/config.json');
    });

    it('工具定义获取抛错时转换为 McpKnotCoreError 并记录日志', async () => {
      const errorSpy = vi.spyOn(logger, 'error');
      mockApiToolIntegrationService.getApiToolDefinition.mockImplementation(() => {
        throw new Error('boom');
      });

      await expect(service.getConfigDetails('test-config')).rejects.toThrow(
        '获取配置详情失败: boom',
      );
      expect(errorSpy).toHaveBeenCalledWith('获取API配置详情失败', expect.any(Error));
    });
  });

  describe('getHealthStatus 补充', () => {
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
      mockApiToolIntegrationService.initialize.mockResolvedValue(undefined);
      await service.initialize('/path/to/config.json');
    });

    it('成功：返回完整对象（toStrictEqual）', async () => {
      const result = await service.getHealthStatus();

      expect(result).toStrictEqual({
        initialized: true,
        healthy: true,
        configPath: '/path/to/config.json',
        toolCount: 5,
        errors: undefined,
      });
    });

    it('失败：errors 数组内容精确且记录日志', async () => {
      const errorSpy = vi.spyOn(logger, 'error');
      mockApiToolIntegrationService.getHealthStatus.mockImplementation(() => {
        throw new Error('boom');
      });

      const result = await service.getHealthStatus();

      expect(result).toStrictEqual({
        initialized: false,
        healthy: false,
        toolCount: 0,
        errors: ['获取健康状态失败: boom'],
      });
      expect(errorSpy).toHaveBeenCalledWith('获取健康状态失败', expect.any(Error));
    });
  });

  describe('reloadConfig 补充', () => {
    beforeEach(async () => {
      mockApiToolIntegrationService.initialize.mockResolvedValue(undefined);
      mockApiToolIntegrationService.reloadConfig.mockResolvedValue(undefined);
      await service.initialize('/path/to/config.json');
    });

    it('成功：记录完成日志', async () => {
      const infoSpy = vi.spyOn(logger, 'info');

      await service.reloadConfig();

      expect(infoSpy).toHaveBeenCalledWith('API配置重新加载完成');
    });

    it('失败：记录错误日志并上抛', async () => {
      const errorSpy = vi.spyOn(logger, 'error');
      mockApiToolIntegrationService.reloadConfig.mockRejectedValue(new Error('reload failed'));

      await expect(service.reloadConfig()).rejects.toThrow('reload failed');
      expect(errorSpy).toHaveBeenCalledWith('重新加载API配置失败', expect.any(Error));
    });
  });

  describe('shutdown 补充（日志断言）', () => {
    beforeEach(async () => {
      mockApiToolIntegrationService.initialize.mockResolvedValue(undefined);
      mockApiToolIntegrationService.shutdown.mockResolvedValue(undefined);
      await service.initialize('/path/to/config.json');
    });

    it('成功：记录开始与完成日志', async () => {
      const infoSpy = vi.spyOn(logger, 'info');

      await service.shutdown();

      expect(infoSpy).toHaveBeenCalledWith('关闭API到MCP Web服务');
      expect(infoSpy).toHaveBeenCalledWith('API到MCP Web服务已关闭');
    });

    it('失败：记录错误日志并上抛', async () => {
      const errorSpy = vi.spyOn(logger, 'error');
      mockApiToolIntegrationService.shutdown.mockRejectedValue(new Error('boom'));

      await expect(service.shutdown()).rejects.toThrow('boom');
      expect(errorSpy).toHaveBeenCalledWith('关闭API到MCP Web服务时发生错误', expect.any(Error));
    });
  });
});
