/**
 * API工具集成服务测试
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { logger } from '../utils/logger.js';
import { ApiToolIntegrationService } from './api_tool_integration_service.js';

// Mock the core module
vi.mock('@mcp-core/mcp-knot-core/api-to-mcp', () => ({
  ApiToMcpServiceManagerImpl: vi.fn(
    class MockApiToMcpServiceManagerImpl {
      initialize = vi.fn();
      getApiTools = vi.fn();
      executeApiTool = vi.fn();
      getToolDefinition = vi.fn();
      reloadConfig = vi.fn();
      shutdown = vi.fn();
      getHealthStatus = vi.fn();
      performHealthCheck = vi.fn();
    },
  ),
}));

describe('ApiToolIntegrationService', () => {
  let service: ApiToolIntegrationService;
  // biome-ignore lint/suspicious/noExplicitAny: test mock accessing private members
  let mockApiServiceManager: any;

  beforeEach(() => {
    service = new ApiToolIntegrationService();
    // biome-ignore lint/suspicious/noExplicitAny: test accessing private member
    mockApiServiceManager = (service as any).apiServiceManager;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('initialize', () => {
    it('应该成功初始化API工具集成服务', async () => {
      const configPath = '/path/to/config.json';
      mockApiServiceManager.initialize.mockResolvedValue(undefined);

      await service.initialize(configPath);

      expect(mockApiServiceManager.initialize).toHaveBeenCalledWith(configPath);
    });

    it('应该跳过初始化当未提供配置文件路径时', async () => {
      await service.initialize();

      expect(mockApiServiceManager.initialize).not.toHaveBeenCalled();
    });

    it('应该处理初始化错误', async () => {
      const configPath = '/path/to/config.json';
      const error = new Error('初始化失败');
      mockApiServiceManager.initialize.mockRejectedValue(error);

      await expect(service.initialize(configPath)).rejects.toThrow(
        'API工具集成服务初始化失败: 初始化失败',
      );
    });

    it('应该跳过重复初始化', async () => {
      const configPath = '/path/to/config.json';
      mockApiServiceManager.initialize.mockResolvedValue(undefined);

      await service.initialize(configPath);
      await service.initialize(configPath);

      expect(mockApiServiceManager.initialize).toHaveBeenCalledTimes(1);
    });
  });

  describe('getApiTools', () => {
    it('应该返回空数组当服务未初始化时', async () => {
      const tools = await service.getApiTools();

      expect(tools).toEqual([]);
      expect(mockApiServiceManager.getApiTools).not.toHaveBeenCalled();
    });

    it('应该返回转换后的API工具列表', async () => {
      const configPath = '/path/to/config.json';
      mockApiServiceManager.initialize.mockResolvedValue(undefined);
      mockApiServiceManager.getApiTools.mockResolvedValue([
        {
          name: 'test-tool',
          description: '测试工具',
          inputSchema: {
            type: 'object',
            properties: {
              param1: { type: 'string' },
            },
          },
        },
      ]);

      await service.initialize(configPath);
      const tools = await service.getApiTools();

      expect(tools).toHaveLength(1);
      expect(tools[0]).toEqual({
        name: 'test-tool',
        description: '测试工具',
        inputSchema: {
          type: 'object',
          properties: {
            param1: { type: 'string' },
          },
        },
        serverId: 'api-tools',
      });
    });

    it('应该处理获取工具列表时的错误', async () => {
      const configPath = '/path/to/config.json';
      mockApiServiceManager.initialize.mockResolvedValue(undefined);
      mockApiServiceManager.getApiTools.mockRejectedValue(new Error('获取失败'));

      await service.initialize(configPath);
      const tools = await service.getApiTools();

      expect(tools).toEqual([]);
    });
  });

  describe('executeApiTool', () => {
    it('应该返回错误当服务未初始化时', async () => {
      const result = await service.executeApiTool('test-tool', {
        param1: 'value',
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toBe('API工具集成服务未初始化');
    });

    it('应该成功执行API工具', async () => {
      const configPath = '/path/to/config.json';
      mockApiServiceManager.initialize.mockResolvedValue(undefined);
      mockApiServiceManager.executeApiTool.mockResolvedValue({
        isError: false,
        content: [{ type: 'text', text: '执行成功' }],
      });

      await service.initialize(configPath);
      const result = await service.executeApiTool('test-tool', {
        param1: 'value',
      });

      expect(result.isError).toBe(false);
      expect(result.content[0].text).toBe('执行成功');
      expect(mockApiServiceManager.executeApiTool).toHaveBeenCalledWith('test-tool', {
        param1: 'value',
      });
    });

    it('应该处理工具执行错误', async () => {
      const configPath = '/path/to/config.json';
      mockApiServiceManager.initialize.mockResolvedValue(undefined);
      mockApiServiceManager.executeApiTool.mockRejectedValue(new Error('执行失败'));

      await service.initialize(configPath);
      const result = await service.executeApiTool('test-tool', {
        param1: 'value',
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toBe('API工具执行失败: 执行失败');
    });
  });

  describe('isApiTool', () => {
    it('应该返回false当服务未初始化时', () => {
      const result = service.isApiTool('test-tool');

      expect(result).toBe(false);
    });

    it('应该检查工具是否为API工具', async () => {
      const configPath = '/path/to/config.json';
      mockApiServiceManager.initialize.mockResolvedValue(undefined);
      mockApiServiceManager.getToolDefinition.mockReturnValue({
        name: 'test-tool',
        description: '测试工具',
        inputSchema: { type: 'object' },
      });

      await service.initialize(configPath);
      const result = service.isApiTool('test-tool');

      expect(result).toBe(true);
      expect(mockApiServiceManager.getToolDefinition).toHaveBeenCalledWith('test-tool');
    });

    it('应该返回false当工具不存在时', async () => {
      const configPath = '/path/to/config.json';
      mockApiServiceManager.initialize.mockResolvedValue(undefined);
      mockApiServiceManager.getToolDefinition.mockReturnValue(undefined);

      await service.initialize(configPath);
      const result = service.isApiTool('non-existent-tool');

      expect(result).toBe(false);
    });
  });

  describe('getApiToolDefinition', () => {
    it('应该返回undefined当服务未初始化时', () => {
      const result = service.getApiToolDefinition('test-tool');

      expect(result).toBeUndefined();
    });

    it('应该返回转换后的工具定义', async () => {
      const configPath = '/path/to/config.json';
      mockApiServiceManager.initialize.mockResolvedValue(undefined);
      mockApiServiceManager.getToolDefinition.mockReturnValue({
        name: 'test-tool',
        description: '测试工具',
        inputSchema: { type: 'object' },
      });

      await service.initialize(configPath);
      const result = service.getApiToolDefinition('test-tool');

      expect(result).toEqual({
        name: 'test-tool',
        description: '测试工具',
        inputSchema: { type: 'object' },
        serverId: 'api-tools',
      });
    });

    it('应该返回undefined当工具不存在时', async () => {
      const configPath = '/path/to/config.json';
      mockApiServiceManager.initialize.mockResolvedValue(undefined);
      mockApiServiceManager.getToolDefinition.mockReturnValue(undefined);

      await service.initialize(configPath);
      const result = service.getApiToolDefinition('non-existent-tool');

      expect(result).toBeUndefined();
    });
  });

  describe('reloadConfig', () => {
    it('应该处理未初始化的情况', async () => {
      // 不应该抛出错误
      await expect(service.reloadConfig()).resolves.toBeUndefined();
      expect(mockApiServiceManager.reloadConfig).not.toHaveBeenCalled();
    });

    it('应该重新加载配置', async () => {
      const configPath = '/path/to/config.json';
      mockApiServiceManager.initialize.mockResolvedValue(undefined);
      mockApiServiceManager.reloadConfig.mockResolvedValue(undefined);

      await service.initialize(configPath);
      await service.reloadConfig();

      expect(mockApiServiceManager.reloadConfig).toHaveBeenCalled();
    });

    it('应该处理重新加载配置时的错误', async () => {
      const configPath = '/path/to/config.json';
      mockApiServiceManager.initialize.mockResolvedValue(undefined);
      mockApiServiceManager.reloadConfig.mockRejectedValue(new Error('重新加载失败'));

      await service.initialize(configPath);

      await expect(service.reloadConfig()).rejects.toThrow('重新加载失败');
    });
  });

  describe('getStats', () => {
    it('应该返回未初始化状态的统计信息', async () => {
      const stats = await service.getStats();

      expect(stats).toEqual({
        totalApiTools: 0,
        initialized: false,
      });
    });

    it('应该返回正确的统计信息', async () => {
      const configPath = '/path/to/config.json';
      mockApiServiceManager.initialize.mockResolvedValue(undefined);
      mockApiServiceManager.getApiTools.mockResolvedValue([{ name: 'tool1' }, { name: 'tool2' }]);

      await service.initialize(configPath);
      const stats = await service.getStats();

      expect(stats).toEqual({
        totalApiTools: 2,
        initialized: true,
      });
    });

    it('应该处理获取统计信息时的错误', async () => {
      const configPath = '/path/to/config.json';
      mockApiServiceManager.initialize.mockResolvedValue(undefined);
      mockApiServiceManager.getApiTools.mockRejectedValue(new Error('获取失败'));

      await service.initialize(configPath);
      const stats = await service.getStats();

      expect(stats).toEqual({
        totalApiTools: 0,
        initialized: true,
      });
    });
  });

  describe('shutdown', () => {
    it('应该处理未初始化的情况', async () => {
      // 不应该抛出错误
      await expect(service.shutdown()).resolves.toBeUndefined();
      expect(mockApiServiceManager.shutdown).not.toHaveBeenCalled();
    });

    it('应该成功关闭服务', async () => {
      const configPath = '/path/to/config.json';
      mockApiServiceManager.initialize.mockResolvedValue(undefined);
      mockApiServiceManager.shutdown.mockResolvedValue(undefined);

      await service.initialize(configPath);
      await service.shutdown();

      expect(mockApiServiceManager.shutdown).toHaveBeenCalled();
    });

    it('应该处理关闭时的错误', async () => {
      const configPath = '/path/to/config.json';
      mockApiServiceManager.initialize.mockResolvedValue(undefined);
      mockApiServiceManager.shutdown.mockRejectedValue(new Error('关闭失败'));

      await service.initialize(configPath);

      await expect(service.shutdown()).rejects.toThrow('关闭失败');
    });
  });

  describe('初始化状态与日志（补强）', () => {
    beforeEach(() => {
      vi.restoreAllMocks();
    });

    it('重复初始化记录 warn 且不再调用底层 initialize', async () => {
      const warnSpy = vi.spyOn(logger, 'warn');
      mockApiServiceManager.initialize.mockResolvedValue(undefined);

      await service.initialize('/path/to/config.json');
      await service.initialize('/path/to/config.json');

      expect(warnSpy).toHaveBeenCalledWith('API工具集成服务已初始化，跳过重复初始化');
      expect(mockApiServiceManager.initialize).toHaveBeenCalledTimes(1);
    });

    it('无配置路径初始化：initialized 保持 false 且记录日志', async () => {
      const infoSpy = vi.spyOn(logger, 'info');

      await service.initialize();

      expect(infoSpy).toHaveBeenCalledWith('未提供API工具配置文件，跳过API工具初始化');
      const stats = await service.getStats();
      expect(stats).toStrictEqual({ totalApiTools: 0, initialized: false });
    });

    it('初始化失败后 initialized 复位，可重新初始化', async () => {
      const configPath = '/path/to/config.json';
      mockApiServiceManager.initialize.mockRejectedValueOnce(new Error('初始化失败'));

      await expect(service.initialize(configPath)).rejects.toThrow(
        'API工具集成服务初始化失败: 初始化失败',
      );

      mockApiServiceManager.initialize.mockResolvedValue(undefined);
      mockApiServiceManager.getApiTools.mockResolvedValue([]);
      await service.initialize(configPath);

      expect(mockApiServiceManager.initialize).toHaveBeenCalledTimes(2);
      const stats = await service.getStats();
      expect(stats.initialized).toBe(true);
    });

    it('初始化失败记录错误日志', async () => {
      const errorSpy = vi.spyOn(logger, 'error');
      mockApiServiceManager.initialize.mockRejectedValue(new Error('boom'));

      await expect(service.initialize('/path/to/config.json')).rejects.toThrow();

      expect(errorSpy).toHaveBeenCalledWith('API工具集成服务初始化失败', expect.any(Error));
    });

    it('初始化成功记录开始与完成日志', async () => {
      const infoSpy = vi.spyOn(logger, 'info');
      mockApiServiceManager.initialize.mockResolvedValue(undefined);

      await service.initialize('/path/to/config.json');

      expect(infoSpy).toHaveBeenCalledWith('初始化API工具集成服务', {
        configPath: '/path/to/config.json',
      });
      expect(infoSpy).toHaveBeenCalledWith('API工具集成服务初始化完成');
    });
  });

  describe('未初始化守卫（补强）', () => {
    it('isApiTool 未初始化时不查询底层工具定义', () => {
      const result = service.isApiTool('test-tool');

      expect(result).toBe(false);
      expect(mockApiServiceManager.getToolDefinition).not.toHaveBeenCalled();
    });

    it('getApiToolDefinition 未初始化时不查询底层工具定义', () => {
      const result = service.getApiToolDefinition('test-tool');

      expect(result).toBeUndefined();
      expect(mockApiServiceManager.getToolDefinition).not.toHaveBeenCalled();
    });

    it('reloadConfig 未初始化时记录 warn 且不调用底层 reload', async () => {
      const warnSpy = vi.spyOn(logger, 'warn');

      await service.reloadConfig();

      expect(warnSpy).toHaveBeenCalledWith('API工具集成服务未初始化，无法重新加载配置');
      expect(mockApiServiceManager.reloadConfig).not.toHaveBeenCalled();
    });

    it('restart 未初始化时记录 warn 且不调用 shutdown', async () => {
      const warnSpy = vi.spyOn(logger, 'warn');

      await service.restart();

      expect(warnSpy).toHaveBeenCalledWith('API工具集成服务未初始化，无法重启');
      expect(mockApiServiceManager.shutdown).not.toHaveBeenCalled();
    });

    it('getHealthStatus 未初始化时返回固定错误', () => {
      const result = service.getHealthStatus();

      expect(result).toStrictEqual({
        initialized: false,
        healthy: false,
        errors: ['服务未初始化'],
      });
    });

    it('performHealthCheck 未初始化时返回固定错误', async () => {
      const result = await service.performHealthCheck();

      expect(result).toStrictEqual({
        initialized: false,
        healthy: false,
        errors: ['服务未初始化'],
      });
    });
  });

  describe('getStats 错误分类（补强）', () => {
    beforeEach(async () => {
      vi.restoreAllMocks();
      mockApiServiceManager.initialize.mockResolvedValue(undefined);
      await service.initialize('/path/to/config.json');
    });

    it('not_initialized 错误：initialized=false 且 warn 提示检查配置路径', async () => {
      const warnSpy = vi.spyOn(logger, 'warn');
      mockApiServiceManager.getApiTools.mockRejectedValue(new Error('service not_initialized'));

      const stats = await service.getStats();

      expect(stats).toStrictEqual({ totalApiTools: 0, initialized: false });
      expect(warnSpy).toHaveBeenCalledWith(
        'API工具服务管理器未初始化，请检查配置文件路径是否正确',
        { configPath: '/path/to/config.json', error: 'service not_initialized' },
      );
    });

    it('含「未运行」的错误同样归类为未初始化', async () => {
      mockApiServiceManager.getApiTools.mockRejectedValue(new Error('服务未运行'));

      const stats = await service.getStats();

      expect(stats).toStrictEqual({ totalApiTools: 0, initialized: false });
    });

    it('其它错误：initialized=true 且记录 error 日志', async () => {
      const errorSpy = vi.spyOn(logger, 'error');
      mockApiServiceManager.getApiTools.mockRejectedValue(new Error('boom'));

      const stats = await service.getStats();

      expect(stats).toStrictEqual({ totalApiTools: 0, initialized: true });
      expect(errorSpy).toHaveBeenCalledWith('获取API工具统计信息失败', expect.any(Error), {
        configPath: '/path/to/config.json',
        initialized: true,
      });
    });

    it('成功：精确统计（toStrictEqual）', async () => {
      mockApiServiceManager.getApiTools.mockResolvedValue([{ name: 'tool1' }, { name: 'tool2' }]);

      const stats = await service.getStats();

      expect(stats).toStrictEqual({ totalApiTools: 2, initialized: true });
    });
  });

  describe('getHealthStatus / performHealthCheck（补强）', () => {
    beforeEach(async () => {
      vi.restoreAllMocks();
      mockApiServiceManager.initialize.mockResolvedValue(undefined);
      await service.initialize('/path/to/config.json');
    });

    it('getHealthStatus 映射底层结果', () => {
      mockApiServiceManager.getHealthStatus.mockReturnValue({
        healthy: true,
        status: 'running',
        errors: [],
      });

      const result = service.getHealthStatus();

      expect(result).toStrictEqual({
        initialized: true,
        healthy: true,
        serviceStatus: 'running',
        errors: [],
      });
    });

    it('getHealthStatus 底层抛错：返回失败且带错误信息', () => {
      mockApiServiceManager.getHealthStatus.mockImplementation(() => {
        throw new Error('boom');
      });

      const result = service.getHealthStatus();

      expect(result).toStrictEqual({
        initialized: true,
        healthy: false,
        errors: ['获取健康状态失败: boom'],
      });
    });

    it('performHealthCheck 映射底层结果', async () => {
      mockApiServiceManager.performHealthCheck.mockResolvedValue({
        healthy: false,
        status: 'degraded',
        errors: ['e1'],
      });

      const result = await service.performHealthCheck();

      expect(result).toStrictEqual({
        initialized: true,
        healthy: false,
        serviceStatus: 'degraded',
        errors: ['e1'],
      });
    });

    it('performHealthCheck 底层抛错：记录日志并返回失败', async () => {
      const errorSpy = vi.spyOn(logger, 'error');
      mockApiServiceManager.performHealthCheck.mockRejectedValue(new Error('boom'));

      const result = await service.performHealthCheck();

      expect(result).toStrictEqual({
        initialized: true,
        healthy: false,
        errors: ['健康检查失败: boom'],
      });
      expect(errorSpy).toHaveBeenCalledWith('API工具集成服务健康检查失败', expect.any(Error));
    });
  });

  describe('restart（补强）', () => {
    beforeEach(() => {
      vi.restoreAllMocks();
    });

    it('重启按原 configPath 重新初始化', async () => {
      const infoSpy = vi.spyOn(logger, 'info');
      mockApiServiceManager.initialize.mockResolvedValue(undefined);
      mockApiServiceManager.shutdown.mockResolvedValue(undefined);
      await service.initialize('/path/to/config.json');

      await service.restart();

      expect(mockApiServiceManager.shutdown).toHaveBeenCalledTimes(1);
      expect(mockApiServiceManager.initialize).toHaveBeenCalledTimes(2);
      expect(mockApiServiceManager.initialize).toHaveBeenLastCalledWith('/path/to/config.json');
      expect(infoSpy).toHaveBeenCalledWith('重启API工具集成服务');
      expect(infoSpy).toHaveBeenCalledWith('API工具集成服务重启完成');
    });

    it('重启失败记录错误日志并上抛', async () => {
      const errorSpy = vi.spyOn(logger, 'error');
      mockApiServiceManager.initialize.mockResolvedValue(undefined);
      mockApiServiceManager.shutdown.mockRejectedValue(new Error('shutdown failed'));
      await service.initialize('/path/to/config.json');

      await expect(service.restart()).rejects.toThrow('shutdown failed');
      expect(errorSpy).toHaveBeenCalledWith('API工具集成服务重启失败', expect.any(Error));
    });
  });

  describe('shutdown 与执行路径（补强）', () => {
    beforeEach(() => {
      vi.restoreAllMocks();
    });

    it('关闭后 initialized 复位（getStats 验证）且记录日志', async () => {
      const infoSpy = vi.spyOn(logger, 'info');
      mockApiServiceManager.initialize.mockResolvedValue(undefined);
      mockApiServiceManager.shutdown.mockResolvedValue(undefined);
      await service.initialize('/path/to/config.json');

      await service.shutdown();

      const stats = await service.getStats();
      expect(stats).toStrictEqual({ totalApiTools: 0, initialized: false });
      expect(infoSpy).toHaveBeenCalledWith('关闭API工具集成服务');
      expect(infoSpy).toHaveBeenCalledWith('API工具集成服务已关闭');
    });

    it('关闭失败记录错误日志并上抛', async () => {
      const errorSpy = vi.spyOn(logger, 'error');
      mockApiServiceManager.initialize.mockResolvedValue(undefined);
      mockApiServiceManager.shutdown.mockRejectedValue(new Error('关闭失败'));
      await service.initialize('/path/to/config.json');

      await expect(service.shutdown()).rejects.toThrow('关闭失败');
      expect(errorSpy).toHaveBeenCalledWith('关闭API工具集成服务时发生错误', expect.any(Error));
    });

    it('执行工具时记录 debug 日志，成功结果精确映射', async () => {
      const debugSpy = vi.spyOn(logger, 'debug');
      mockApiServiceManager.initialize.mockResolvedValue(undefined);
      mockApiServiceManager.executeApiTool.mockResolvedValue({
        isError: false,
        content: [{ type: 'text', text: '执行成功' }],
      });
      await service.initialize('/path/to/config.json');

      const result = await service.executeApiTool('test-tool', { param1: 'value' });

      expect(debugSpy).toHaveBeenCalledWith('执行API工具', {
        toolName: 'test-tool',
        args: { param1: 'value' },
      });
      expect(result).toStrictEqual({
        isError: false,
        content: [{ type: 'text', text: '执行成功' }],
      });
    });

    it('执行工具失败：错误结果精确内容并记录日志', async () => {
      const errorSpy = vi.spyOn(logger, 'error');
      mockApiServiceManager.initialize.mockResolvedValue(undefined);
      mockApiServiceManager.executeApiTool.mockRejectedValue(new Error('执行失败'));
      await service.initialize('/path/to/config.json');

      const result = await service.executeApiTool('test-tool', {});

      expect(result).toStrictEqual({
        isError: true,
        content: [{ type: 'text', text: 'API工具执行失败: 执行失败' }],
      });
      expect(errorSpy).toHaveBeenCalledWith('API工具执行失败', expect.any(Error), {
        toolName: 'test-tool',
      });
    });

    it('获取工具列表失败：记录错误日志并返回空数组', async () => {
      const errorSpy = vi.spyOn(logger, 'error');
      mockApiServiceManager.initialize.mockResolvedValue(undefined);
      mockApiServiceManager.getApiTools.mockRejectedValue(new Error('获取失败'));
      await service.initialize('/path/to/config.json');

      const tools = await service.getApiTools();

      expect(tools).toStrictEqual([]);
      expect(errorSpy).toHaveBeenCalledWith('获取API工具列表失败', expect.any(Error));
    });

    it('reloadConfig 成功记录完成日志；失败记录错误并上抛', async () => {
      const infoSpy = vi.spyOn(logger, 'info');
      const errorSpy = vi.spyOn(logger, 'error');
      mockApiServiceManager.initialize.mockResolvedValue(undefined);
      mockApiServiceManager.reloadConfig.mockResolvedValue(undefined);
      await service.initialize('/path/to/config.json');

      await service.reloadConfig();
      expect(infoSpy).toHaveBeenCalledWith('重新加载API工具配置');
      expect(infoSpy).toHaveBeenCalledWith('API工具配置重新加载完成');

      mockApiServiceManager.reloadConfig.mockRejectedValue(new Error('重新加载失败'));
      await expect(service.reloadConfig()).rejects.toThrow('重新加载失败');
      expect(errorSpy).toHaveBeenCalledWith('重新加载API工具配置失败', expect.any(Error));
    });
  });
});
