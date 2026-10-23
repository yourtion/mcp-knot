/**
 * 带缓存功能的API执行器测试
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  CachedApiExecutor,
  createCachedApiExecutor,
  type CacheExecutorConfig,
} from './cached-api-executor.js';

import type { ApiToolConfig } from '../types/api-config.js';
import type { ApiResponse, HttpResponse } from '../types/http-client.js';
import type { ApiExecutor } from './api-executor.js';
import type { CacheKeyManager } from './cache-key-manager.js';
import type { CacheManager } from './cache-manager.js';

// Mock日志记录器（可引用）
const loggerMocks = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));

vi.mock('../../utils/logger.js', () => ({
  createLogger: () => loggerMocks,
}));

describe('CachedApiExecutor', () => {
  let mockBaseExecutor: ApiExecutor;
  let mockCacheManager: CacheManager;
  let mockKeyManager: CacheKeyManager;
  let cachedExecutor: CachedApiExecutor;
  let mockConfig: ApiToolConfig;
  let mockParameters: Record<string, unknown>;

  beforeEach(() => {
    // Mock基础执行器
    mockBaseExecutor = {
      executeApiCall: vi.fn(),
      buildHttpRequest: vi.fn(),
      applyAuthentication: vi.fn(),
      handleTimeoutAndRetry: vi.fn(),
    };

    // Mock缓存管理器
    mockCacheManager = {
      get: vi.fn(),
      set: vi.fn(),
      delete: vi.fn(),
      clear: vi.fn(),
      generateCacheKey: vi.fn(),
      getStats: vi.fn(() => ({
        totalRequests: 0,
        hits: 0,
        misses: 0,
        hitRate: 0,
        currentSize: 0,
        maxSize: 1000,
      })),
      setStrategy: vi.fn(),
      cleanup: vi.fn(),
    };

    // Mock键管理器
    mockKeyManager = {
      generateKey: vi.fn(),
      setStrategy: vi.fn(),
      getStrategy: vi.fn(),
      validateKey: vi.fn(),
      extractKeyInfo: vi.fn(),
      generateToolKeyPattern: vi.fn(),
      isKeyForTool: vi.fn(),
      generateKeysForTool: vi.fn(),
    };

    // 创建缓存执行器
    cachedExecutor = new CachedApiExecutor(mockBaseExecutor, mockCacheManager, mockKeyManager);

    // Mock配置和参数
    mockConfig = {
      id: 'test-tool',
      name: 'Test Tool',
      description: 'Test tool description',
      api: {
        url: 'https://api.example.com/test',
        method: 'GET',
      },
      parameters: {
        type: 'object',
        properties: {
          param1: { type: 'string' },
        },
      },
      response: {
        jsonata: '$.data',
      },
    };

    mockParameters = { param1: 'value1' };
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  describe('基本缓存功能', () => {
    it('应该在缓存命中时返回缓存的响应', async () => {
      const cachedResponse: ApiResponse = {
        raw: {} as HttpResponse,
        data: { result: 'cached' },
        success: true,
      };

      // 设置mock
      vi.mocked(mockKeyManager.generateKey).mockReturnValue('test-cache-key');
      vi.mocked(mockCacheManager.get).mockResolvedValue(cachedResponse);

      const result = await cachedExecutor.executeApiCall(mockConfig, mockParameters);

      expect(result).toEqual(cachedResponse);
      expect(mockKeyManager.generateKey).toHaveBeenCalledWith('test-tool', mockParameters);
      expect(mockCacheManager.get).toHaveBeenCalledWith('test-cache-key');
      expect(mockBaseExecutor.executeApiCall).not.toHaveBeenCalled();
    });

    it('应该在缓存未命中时调用基础执行器', async () => {
      const apiResponse: ApiResponse = {
        raw: {} as HttpResponse,
        data: { result: 'fresh' },
        success: true,
      };

      // 设置mock
      vi.mocked(mockKeyManager.generateKey).mockReturnValue('test-cache-key');
      vi.mocked(mockCacheManager.get).mockResolvedValue(null);
      vi.mocked(mockBaseExecutor.executeApiCall).mockResolvedValue(apiResponse);

      const result = await cachedExecutor.executeApiCall(mockConfig, mockParameters);

      expect(result).toEqual(apiResponse);
      expect(mockBaseExecutor.executeApiCall).toHaveBeenCalledWith(mockConfig, mockParameters);
      expect(mockCacheManager.set).toHaveBeenCalledWith('test-cache-key', apiResponse, 300);
    });

    it('应该缓存成功的响应', async () => {
      const apiResponse: ApiResponse = {
        raw: {} as HttpResponse,
        data: { result: 'success' },
        success: true,
      };

      vi.mocked(mockKeyManager.generateKey).mockReturnValue('test-cache-key');
      vi.mocked(mockCacheManager.get).mockResolvedValue(null);
      vi.mocked(mockBaseExecutor.executeApiCall).mockResolvedValue(apiResponse);

      await cachedExecutor.executeApiCall(mockConfig, mockParameters);

      expect(mockCacheManager.set).toHaveBeenCalledWith('test-cache-key', apiResponse, 300);
    });

    it('应该根据配置决定是否缓存错误响应', async () => {
      const errorResponse: ApiResponse = {
        raw: {} as HttpResponse,
        data: null,
        success: false,
        error: 'API Error',
      };

      vi.mocked(mockKeyManager.generateKey).mockReturnValue('test-cache-key');
      vi.mocked(mockCacheManager.get).mockResolvedValue(null);
      vi.mocked(mockBaseExecutor.executeApiCall).mockResolvedValue(errorResponse);

      // 默认不缓存错误响应
      await cachedExecutor.executeApiCall(mockConfig, mockParameters);
      expect(mockCacheManager.set).not.toHaveBeenCalled();

      // 启用错误缓存
      const configWithErrorCache: Partial<CacheExecutorConfig> = {
        cacheErrors: true,
        errorTtl: 60,
      };

      const cachedExecutorWithErrorCache = new CachedApiExecutor(
        mockBaseExecutor,
        mockCacheManager,
        mockKeyManager,
        configWithErrorCache,
      );

      vi.mocked(mockCacheManager.set).mockClear();
      await cachedExecutorWithErrorCache.executeApiCall(mockConfig, mockParameters);
      expect(mockCacheManager.set).toHaveBeenCalledWith('test-cache-key', errorResponse, 60);
    });
  });

  describe('缓存配置', () => {
    it('应该在缓存禁用时直接调用基础执行器', async () => {
      const config: Partial<CacheExecutorConfig> = { enabled: false };
      const disabledCacheExecutor = new CachedApiExecutor(
        mockBaseExecutor,
        mockCacheManager,
        mockKeyManager,
        config,
      );

      const apiResponse: ApiResponse = {
        raw: {} as HttpResponse,
        data: { result: 'no-cache' },
        success: true,
      };

      vi.mocked(mockBaseExecutor.executeApiCall).mockResolvedValue(apiResponse);

      const result = await disabledCacheExecutor.executeApiCall(mockConfig, mockParameters);

      expect(result).toEqual(apiResponse);
      expect(mockCacheManager.get).not.toHaveBeenCalled();
      expect(mockCacheManager.set).not.toHaveBeenCalled();
    });

    it('应该使用工具级别的缓存配置', async () => {
      const configWithCache: ApiToolConfig = {
        ...mockConfig,
        cache: {
          enabled: true,
          ttl: 600, // 10分钟
        },
      };

      const apiResponse: ApiResponse = {
        raw: {} as HttpResponse,
        data: { result: 'tool-cache' },
        success: true,
      };

      vi.mocked(mockKeyManager.generateKey).mockReturnValue('test-cache-key');
      vi.mocked(mockCacheManager.get).mockResolvedValue(null);
      vi.mocked(mockBaseExecutor.executeApiCall).mockResolvedValue(apiResponse);

      await cachedExecutor.executeApiCall(configWithCache, mockParameters);

      expect(mockCacheManager.set).toHaveBeenCalledWith('test-cache-key', apiResponse, 600);
    });

    it('应该在工具禁用缓存时不缓存', async () => {
      const configWithDisabledCache: ApiToolConfig = {
        ...mockConfig,
        cache: {
          enabled: false,
          ttl: 300,
        },
      };

      const apiResponse: ApiResponse = {
        raw: {} as HttpResponse,
        data: { result: 'no-tool-cache' },
        success: true,
      };

      vi.mocked(mockKeyManager.generateKey).mockReturnValue('test-cache-key');
      vi.mocked(mockCacheManager.get).mockResolvedValue(null);
      vi.mocked(mockBaseExecutor.executeApiCall).mockResolvedValue(apiResponse);

      await cachedExecutor.executeApiCall(configWithDisabledCache, mockParameters);

      expect(mockCacheManager.set).not.toHaveBeenCalled();
    });
  });

  describe('缓存键管理', () => {
    it('应该使用键前缀', async () => {
      const config: Partial<CacheExecutorConfig> = { keyPrefix: 'api-cache' };
      const prefixedExecutor = new CachedApiExecutor(
        mockBaseExecutor,
        mockCacheManager,
        mockKeyManager,
        config,
      );

      vi.mocked(mockKeyManager.generateKey).mockReturnValue('base-key');
      vi.mocked(mockCacheManager.get).mockResolvedValue(null);
      vi.mocked(mockBaseExecutor.executeApiCall).mockResolvedValue({
        raw: {} as HttpResponse,
        data: { result: 'prefixed' },
        success: true,
      });

      await prefixedExecutor.executeApiCall(mockConfig, mockParameters);

      expect(mockCacheManager.get).toHaveBeenCalledWith('api-cache:base-key');
    });

    it('应该处理键生成错误', async () => {
      vi.mocked(mockKeyManager.generateKey).mockImplementation(() => {
        throw new Error('Key generation failed');
      });

      const apiResponse: ApiResponse = {
        raw: {} as HttpResponse,
        data: { result: 'fallback' },
        success: true,
      };

      vi.mocked(mockBaseExecutor.executeApiCall).mockResolvedValue(apiResponse);

      const result = await cachedExecutor.executeApiCall(mockConfig, mockParameters);

      expect(result).toEqual(apiResponse);
      expect(mockBaseExecutor.executeApiCall).toHaveBeenCalled();
    });
  });

  describe('统计信息', () => {
    it('应该提供详细的统计信息', () => {
      const stats = cachedExecutor.getStats();

      expect(stats).toHaveProperty('totalApiCalls');
      expect(stats).toHaveProperty('cachedApiCalls');
      expect(stats).toHaveProperty('timeSaved');
      expect(stats).toHaveProperty('averageApiTime');
      expect(stats).toHaveProperty('averageCacheTime');
    });

    it('应该正确计算缓存命中率', async () => {
      // 模拟一次缓存未命中
      vi.mocked(mockKeyManager.generateKey).mockReturnValue('test-key');
      vi.mocked(mockCacheManager.get).mockResolvedValue(null);
      vi.mocked(mockBaseExecutor.executeApiCall).mockResolvedValue({
        raw: {} as HttpResponse,
        data: { result: 'miss' },
        success: true,
      });

      await cachedExecutor.executeApiCall(mockConfig, mockParameters);

      // 模拟一次缓存命中
      vi.mocked(mockCacheManager.get).mockResolvedValue({
        raw: {} as HttpResponse,
        data: { result: 'hit' },
        success: true,
      });

      await cachedExecutor.executeApiCall(mockConfig, mockParameters);

      const stats = cachedExecutor.getStats();
      expect(stats.totalApiCalls).toBe(2);
      expect(stats.cachedApiCalls).toBe(1);
    });
  });

  describe('缓存管理操作', () => {
    it('应该清除所有缓存', async () => {
      await cachedExecutor.clearAllCache();

      expect(mockCacheManager.clear).toHaveBeenCalled();
    });

    it('应该支持缓存预热', async () => {
      const parametersList = [{ param1: 'value1' }, { param1: 'value2' }, { param1: 'value3' }];

      vi.mocked(mockKeyManager.generateKey).mockReturnValue('test-key');
      vi.mocked(mockCacheManager.get).mockResolvedValue(null);
      vi.mocked(mockBaseExecutor.executeApiCall).mockResolvedValue({
        raw: {} as HttpResponse,
        data: { result: 'warmup' },
        success: true,
      });

      const result = await cachedExecutor.warmupCache(mockConfig, parametersList);

      expect(result.success).toBe(3);
      expect(result.failed).toBe(0);
      expect(mockBaseExecutor.executeApiCall).toHaveBeenCalledTimes(3);
    });

    it('应该处理预热过程中的错误', async () => {
      const parametersList = [{ param1: 'value1' }, { param1: 'value2' }];

      // 重新创建一个新的执行器实例以避免之前测试的影响
      const freshCachedExecutor = new CachedApiExecutor(
        mockBaseExecutor,
        mockCacheManager,
        mockKeyManager,
      );

      // 清除之前的mock调用
      vi.clearAllMocks();

      vi.mocked(mockKeyManager.generateKey).mockReturnValue('test-key');
      vi.mocked(mockCacheManager.get).mockResolvedValue(null);

      // 第一次调用返回成功响应，第二次返回失败响应
      vi.mocked(mockBaseExecutor.executeApiCall)
        .mockResolvedValueOnce({
          raw: {} as HttpResponse,
          data: { result: 'success' },
          success: true,
        })
        .mockResolvedValueOnce({
          raw: {} as HttpResponse,
          data: null,
          success: false,
          error: 'API Error',
        });

      const result = await freshCachedExecutor.warmupCache(mockConfig, parametersList);

      expect(result.success).toBe(1);
      expect(result.failed).toBe(1);
    });
  });

  describe('动态配置', () => {
    it('应该支持动态更新配置', () => {
      const newConfig: Partial<CacheExecutorConfig> = {
        defaultTtl: 600,
        cacheErrors: true,
      };

      cachedExecutor.updateConfig(newConfig);

      // 验证配置已更新（通过行为验证）
      expect(() => cachedExecutor.updateConfig(newConfig)).not.toThrow();
    });
  });

  describe('委托方法', () => {
    it('应该正确委托buildHttpRequest', () => {
      const mockRequest = { url: 'test', method: 'GET' as const };
      vi.mocked(mockBaseExecutor.buildHttpRequest).mockReturnValue(mockRequest);

      const result = cachedExecutor.buildHttpRequest(mockConfig, mockParameters);

      expect(result).toBe(mockRequest);
      expect(mockBaseExecutor.buildHttpRequest).toHaveBeenCalledWith(mockConfig, mockParameters);
    });

    it('应该正确委托applyAuthentication', async () => {
      const mockRequest = { url: 'test', method: 'GET' as const };
      const mockAuth = { type: 'bearer' as const, token: 'test-token' };
      const mockAuthenticatedRequest = {
        ...mockRequest,
        headers: { Authorization: 'Bearer test-token' },
      };

      vi.mocked(mockBaseExecutor.applyAuthentication).mockResolvedValue(mockAuthenticatedRequest);

      const result = await cachedExecutor.applyAuthentication(mockRequest, mockAuth);

      expect(result).toBe(mockAuthenticatedRequest);
      expect(mockBaseExecutor.applyAuthentication).toHaveBeenCalledWith(mockRequest, mockAuth);
    });

    it('应该正确委托handleTimeoutAndRetry', async () => {
      const mockRequest = { url: 'test', method: 'GET' as const };
      const mockResponse = { status: 200, data: 'test' };

      vi.mocked(mockBaseExecutor.handleTimeoutAndRetry).mockResolvedValue(
        mockResponse as unknown as Awaited<
          ReturnType<typeof mockBaseExecutor.handleTimeoutAndRetry>
        >,
      );

      const result = await cachedExecutor.handleTimeoutAndRetry(mockRequest);

      expect(result).toBe(mockResponse);
      expect(mockBaseExecutor.handleTimeoutAndRetry).toHaveBeenCalledWith(mockRequest);
    });
  });

  describe('错误处理', () => {
    it('应该在缓存操作失败时回退到基础执行器', async () => {
      vi.mocked(mockKeyManager.generateKey).mockReturnValue('test-key');
      vi.mocked(mockCacheManager.get).mockRejectedValue(new Error('Cache error'));

      const apiResponse: ApiResponse = {
        raw: {} as HttpResponse,
        data: { result: 'fallback' },
        success: true,
      };

      vi.mocked(mockBaseExecutor.executeApiCall).mockResolvedValue(apiResponse);

      const result = await cachedExecutor.executeApiCall(mockConfig, mockParameters);

      expect(result).toEqual(apiResponse);
      expect(mockBaseExecutor.executeApiCall).toHaveBeenCalled();
    });

    it('应该处理缓存设置失败', async () => {
      const apiResponse: ApiResponse = {
        raw: {} as HttpResponse,
        data: { result: 'success' },
        success: true,
      };

      vi.mocked(mockKeyManager.generateKey).mockReturnValue('test-key');
      vi.mocked(mockCacheManager.get).mockResolvedValue(null);
      vi.mocked(mockBaseExecutor.executeApiCall).mockResolvedValue(apiResponse);
      vi.mocked(mockCacheManager.set).mockRejectedValue(new Error('Cache set error'));

      const result = await cachedExecutor.executeApiCall(mockConfig, mockParameters);

      // 应该仍然返回API响应，即使缓存设置失败
      expect(result).toEqual(apiResponse);
    });
  });

  describe('性能监控', () => {
    it('应该跟踪API和缓存响应时间', async () => {
      // 模拟缓存未命中
      vi.mocked(mockKeyManager.generateKey).mockReturnValue('test-key');
      vi.mocked(mockCacheManager.get).mockResolvedValue(null);
      vi.mocked(mockBaseExecutor.executeApiCall).mockImplementation(async () => {
        await new Promise((resolve) => setTimeout(resolve, 50)); // 模拟API延迟
        return {
          raw: {} as HttpResponse,
          data: { result: 'api' },
          success: true,
        };
      });

      await cachedExecutor.executeApiCall(mockConfig, mockParameters);

      // 模拟缓存命中
      vi.mocked(mockCacheManager.get).mockImplementation(async () => {
        await new Promise((resolve) => setTimeout(resolve, 5)); // 模拟缓存延迟
        return {
          raw: {} as HttpResponse,
          data: { result: 'cached' },
          success: true,
        };
      });

      await cachedExecutor.executeApiCall(mockConfig, mockParameters);

      const stats = cachedExecutor.getStats();
      expect(stats.averageApiTime).toBeGreaterThan(0);
      expect(stats.averageCacheTime).toBeGreaterThan(0);
      expect(stats.timeSaved).toBeGreaterThan(0);
    });

    it('初始统计的平均耗时为 0 而非 NaN', () => {
      const stats = cachedExecutor.getStats();

      expect(stats.averageApiTime).toBe(0);
      expect(stats.averageCacheTime).toBe(0);
      expect(stats.totalApiCalls).toBe(0);
      expect(stats.cachedApiCalls).toBe(0);
    });
  });

  describe('精确计时统计（fake timers）', () => {
    const T0 = new Date('2026-01-01T00:00:00Z').getTime();

    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(T0);
    });

    it('API 50ms、缓存命中 5ms → timeSaved=45 且均值精确', async () => {
      vi.mocked(mockKeyManager.generateKey).mockReturnValue('k');
      // 第一次：miss，API 耗时 50ms
      vi.mocked(mockCacheManager.get).mockResolvedValue(null);
      vi.mocked(mockBaseExecutor.executeApiCall).mockImplementation(async () => {
        vi.setSystemTime(T0 + 50);
        return { raw: {} as HttpResponse, data: { ok: true }, success: true };
      });
      await cachedExecutor.executeApiCall(mockConfig, mockParameters);

      // 第二次：命中，get 耗时 5ms
      vi.mocked(mockCacheManager.get).mockImplementation(async () => {
        vi.setSystemTime(T0 + 55);
        return { raw: {} as HttpResponse, data: { ok: true }, success: true };
      });
      await cachedExecutor.executeApiCall(mockConfig, mockParameters);

      const stats = cachedExecutor.getStats();
      expect(stats.averageApiTime).toBe(50); // 上界：不可为 now+startTime 之类的爆炸值
      expect(stats.averageCacheTime).toBe(5);
      expect(stats.timeSaved).toBe(45);
    });

    it('平均值只保留最近 1000 个样本', async () => {
      vi.mocked(mockKeyManager.generateKey).mockReturnValue('k');
      vi.mocked(mockCacheManager.get).mockResolvedValue(null);

      // 第 1 次调用耗时长，后续 1000 次耗时 1ms
      let call = 0;
      vi.mocked(mockBaseExecutor.executeApiCall).mockImplementation(async () => {
        call++;
        vi.setSystemTime(Date.now() + (call === 1 ? 5000 : 1));
        return { raw: {} as HttpResponse, data: { ok: true }, success: true };
      });

      for (let i = 0; i < 1001; i++) {
        await cachedExecutor.executeApiCall(mockConfig, mockParameters);
      }

      // 截断后最早的 5000ms 样本被丢弃，均值收敛到 1ms
      expect(cachedExecutor.getStats().averageApiTime).toBe(1);
    });
  });

  describe('clearToolCache', () => {
    it('基于键模式清理并返回 0（简化实现），输出 warn 日志', async () => {
      vi.mocked(mockKeyManager.generateToolKeyPattern).mockReturnValue('tool:test-tool:*');

      const count = await cachedExecutor.clearToolCache('test-tool');

      expect(count).toBe(0);
      expect(mockKeyManager.generateToolKeyPattern).toHaveBeenCalledWith('test-tool');
      expect(loggerMocks.warn).toHaveBeenCalledWith(
        '清除工具缓存: test-tool (模式: tool:test-tool:*) - 需要实现具体的清理逻辑',
      );
    });

    it('键模式生成抛错 → 返回 0 并记录错误日志', async () => {
      vi.mocked(mockKeyManager.generateToolKeyPattern).mockImplementation(() => {
        throw new Error('pattern error');
      });

      const count = await cachedExecutor.clearToolCache('test-tool');

      expect(count).toBe(0);
      expect(loggerMocks.error).toHaveBeenCalledWith(
        '清除工具缓存失败: test-tool',
        expect.any(Error),
      );
    });
  });

  describe('warmupCache 异常分支', () => {
    it('executeApiCall 抛错 → 计入 failed 而非中断', async () => {
      vi.mocked(mockKeyManager.generateKey).mockReturnValue('k');
      vi.mocked(mockCacheManager.get).mockResolvedValue(null);
      vi.mocked(mockBaseExecutor.executeApiCall)
        .mockResolvedValueOnce({
          raw: {} as HttpResponse,
          data: { ok: true },
          success: true,
        })
        .mockRejectedValueOnce(new Error('boom'));

      const result = await cachedExecutor.warmupCache(mockConfig, [{ p: 1 }, { p: 2 }]);

      expect(result).toEqual({ success: 1, failed: 1 });
      expect(loggerMocks.warn).toHaveBeenCalledWith('预热缓存失败', expect.any(Error));
    });

    it('预热开始与完成输出 info 日志', async () => {
      vi.mocked(mockKeyManager.generateKey).mockReturnValue('k');
      vi.mocked(mockCacheManager.get).mockResolvedValue(null);
      vi.mocked(mockBaseExecutor.executeApiCall).mockResolvedValue({
        raw: {} as HttpResponse,
        data: { ok: true },
        success: true,
      });

      await cachedExecutor.warmupCache(mockConfig, [{ p: 1 }]);

      expect(loggerMocks.info).toHaveBeenCalledWith('开始预热缓存: test-tool, 1 个参数组合');
      expect(loggerMocks.info).toHaveBeenCalledWith('缓存预热完成: test-tool, 成功: 1, 失败: 0');
    });
  });

  describe('clearAllCache 与统计重置', () => {
    it('清空缓存后统计全部归零', async () => {
      vi.mocked(mockKeyManager.generateKey).mockReturnValue('k');
      vi.mocked(mockCacheManager.get).mockResolvedValue(null);
      vi.mocked(mockBaseExecutor.executeApiCall).mockResolvedValue({
        raw: {} as HttpResponse,
        data: { ok: true },
        success: true,
      });
      await cachedExecutor.executeApiCall(mockConfig, mockParameters);

      await cachedExecutor.clearAllCache();

      const stats = cachedExecutor.getStats();
      expect(stats.totalApiCalls).toBe(0);
      expect(stats.cachedApiCalls).toBe(0);
      expect(stats.timeSaved).toBe(0);
      expect(stats.averageApiTime).toBe(0);
      expect(stats.averageCacheTime).toBe(0);
      expect(mockCacheManager.clear).toHaveBeenCalled();
      expect(loggerMocks.info).toHaveBeenCalledWith('所有缓存已清除');
    });
  });

  describe('动态配置（行为验证）', () => {
    it('updateConfig 更新 defaultTtl 后按新 TTL 缓存', async () => {
      vi.mocked(mockKeyManager.generateKey).mockReturnValue('k');
      vi.mocked(mockCacheManager.get).mockResolvedValue(null);
      vi.mocked(mockBaseExecutor.executeApiCall).mockResolvedValue({
        raw: {} as HttpResponse,
        data: { ok: true },
        success: true,
      });

      cachedExecutor.updateConfig({ defaultTtl: 777 });
      await cachedExecutor.executeApiCall(mockConfig, mockParameters);

      expect(mockCacheManager.set).toHaveBeenCalledWith('k', expect.anything(), 777);
      expect(loggerMocks.info).toHaveBeenCalledWith('缓存配置已更新');
    });
  });

  describe('缓存日志开关', () => {
    it('默认开启：命中与写入缓存均输出 debug 日志', async () => {
      vi.mocked(mockKeyManager.generateKey).mockReturnValue('k');
      vi.mocked(mockCacheManager.get).mockResolvedValue({
        raw: {} as HttpResponse,
        data: { ok: true },
        success: true,
      });

      await cachedExecutor.executeApiCall(mockConfig, mockParameters);

      expect(loggerMocks.debug).toHaveBeenCalledWith('缓存命中: test-tool');
    });

    it('未命中并写入缓存 → 输出"响应已缓存"日志', async () => {
      vi.mocked(mockKeyManager.generateKey).mockReturnValue('k');
      vi.mocked(mockCacheManager.get).mockResolvedValue(null);
      vi.mocked(mockBaseExecutor.executeApiCall).mockResolvedValue({
        raw: {} as HttpResponse,
        data: { ok: true },
        success: true,
      });

      await cachedExecutor.executeApiCall(mockConfig, mockParameters);

      expect(loggerMocks.debug).toHaveBeenCalledWith('响应已缓存: test-tool');
    });

    it('enableCacheLogging=false → 不输出缓存 debug 日志', async () => {
      const quietExecutor = new CachedApiExecutor(
        mockBaseExecutor,
        mockCacheManager,
        mockKeyManager,
        {
          enableCacheLogging: false,
        },
      );
      vi.mocked(mockKeyManager.generateKey).mockReturnValue('k');
      vi.mocked(mockCacheManager.get).mockResolvedValue({
        raw: {} as HttpResponse,
        data: { ok: true },
        success: true,
      });

      await quietExecutor.executeApiCall(mockConfig, mockParameters);

      expect(loggerMocks.debug).not.toHaveBeenCalledWith('缓存命中: test-tool');
    });
  });

  describe('错误日志', () => {
    it('键生成抛错 → error 日志包含工具ID，并回退基础执行器', async () => {
      vi.mocked(mockKeyManager.generateKey).mockImplementation(() => {
        throw new Error('Key generation failed');
      });
      vi.mocked(mockBaseExecutor.executeApiCall).mockResolvedValue({
        raw: {} as HttpResponse,
        data: { ok: true },
        success: true,
      });

      await cachedExecutor.executeApiCall(mockConfig, mockParameters);

      expect(loggerMocks.error).toHaveBeenCalledWith(
        '缓存API执行失败: test-tool',
        expect.any(Error),
      );
    });

    it('cache.get 抛错 → 记录"从缓存获取响应失败"', async () => {
      vi.mocked(mockKeyManager.generateKey).mockReturnValue('k');
      vi.mocked(mockCacheManager.get).mockRejectedValue(new Error('get failed'));
      vi.mocked(mockBaseExecutor.executeApiCall).mockResolvedValue({
        raw: {} as HttpResponse,
        data: { ok: true },
        success: true,
      });

      await cachedExecutor.executeApiCall(mockConfig, mockParameters);

      expect(loggerMocks.error).toHaveBeenCalledWith('从缓存获取响应失败', expect.any(Error));
    });

    it('cache.set 抛错 → 记录"缓存响应失败"且不影响返回', async () => {
      vi.mocked(mockKeyManager.generateKey).mockReturnValue('k');
      vi.mocked(mockCacheManager.get).mockResolvedValue(null);
      const response: ApiResponse = {
        raw: {} as HttpResponse,
        data: { ok: true },
        success: true,
      };
      vi.mocked(mockBaseExecutor.executeApiCall).mockResolvedValue(response);
      vi.mocked(mockCacheManager.set).mockRejectedValue(new Error('set failed'));

      const result = await cachedExecutor.executeApiCall(mockConfig, mockParameters);

      expect(result).toEqual(response);
      expect(loggerMocks.error).toHaveBeenCalledWith('缓存响应失败', expect.any(Error));
    });
  });

  describe('createCachedApiExecutor 工厂', () => {
    it('返回可用的缓存执行器实例', async () => {
      const executor = createCachedApiExecutor(mockBaseExecutor, mockCacheManager, mockKeyManager);

      expect(executor).toBeInstanceOf(CachedApiExecutor);

      vi.mocked(mockKeyManager.generateKey).mockReturnValue('k');
      vi.mocked(mockCacheManager.get).mockResolvedValue(null);
      vi.mocked(mockBaseExecutor.executeApiCall).mockResolvedValue({
        raw: {} as HttpResponse,
        data: { ok: true },
        success: true,
      });

      const result = await executor.executeApiCall(mockConfig, mockParameters);
      expect(result.success).toBe(true);
    });
  });
});
