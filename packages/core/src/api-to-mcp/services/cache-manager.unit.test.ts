/**
 * 缓存管理器测试
 */

import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { logger } from '../../utils/logger.js';
import {
  CacheManagerImpl,
  createCacheManager,
  MultiLevelCacheManager,
  RedisCacheManager,
} from './cache-manager.js';

// Mock日志记录器
vi.mock('../../utils/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

const loggerMock = vi.mocked(logger);

describe('CacheManagerImpl', () => {
  let cacheManager: CacheManagerImpl;

  beforeEach(() => {
    cacheManager = new CacheManagerImpl();
  });

  afterEach(() => {
    cacheManager.destroy();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  describe('基本缓存操作', () => {
    it('应该设置和获取缓存值', async () => {
      const key = 'test-key';
      const value = { data: 'test-value' };

      await cacheManager.set(key, value);
      const result = await cacheManager.get(key);

      expect(result).toEqual(value);
    });

    it('应该在键不存在时返回null', async () => {
      const result = await cacheManager.get('non-existent-key');
      expect(result).toBeNull();
    });

    it('应该删除缓存项', async () => {
      const key = 'delete-test';
      const value = 'test-value';

      await cacheManager.set(key, value);
      expect(await cacheManager.get(key)).toBe(value);

      await cacheManager.delete(key);
      expect(await cacheManager.get(key)).toBeNull();
    });

    it('应该清空所有缓存', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
      await cacheManager.set('key1', 'value1');
      vi.setSystemTime(new Date('2026-01-01T00:00:00.010Z'));
      await cacheManager.set('key2', 'value2');

      expect(await cacheManager.get('key1')).toBe('value1');
      expect(await cacheManager.get('key2')).toBe('value2');

      await cacheManager.clear();

      expect(await cacheManager.get('key1')).toBeNull();
      expect(await cacheManager.get('key2')).toBeNull();
    });
  });

  describe('TTL（生存时间）', () => {
    it('应该在TTL过期后删除缓存项', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });

      const key = 'ttl-test';
      const value = 'test-value';
      const ttl = 0.1; // 0.1秒

      await cacheManager.set(key, value, ttl);
      expect(await cacheManager.get(key)).toBe(value);

      // 等待TTL过期
      await vi.advanceTimersByTimeAsync(150);

      expect(await cacheManager.get(key)).toBeNull();

      vi.useRealTimers();
    });

    it('应该在TTL未过期时返回缓存值', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });

      const key = 'ttl-valid-test';
      const value = 'test-value';
      const ttl = 1; // 1秒

      await cacheManager.set(key, value, ttl);

      // 立即检查
      expect(await cacheManager.get(key)).toBe(value);

      // 等待一小段时间后再检查
      await vi.advanceTimersByTimeAsync(5);
      expect(await cacheManager.get(key)).toBe(value);

      vi.useRealTimers();
    });
  });

  describe('缓存键生成', () => {
    it('应该生成基本的缓存键', () => {
      const toolId = 'test-tool';
      const parameters = { param1: 'value1', param2: 'value2' };

      const key = cacheManager.generateCacheKey(toolId, parameters);

      expect(key).toContain(toolId);
      expect(typeof key).toBe('string');
      expect(key.length).toBeGreaterThan(toolId.length);
    });

    it('应该为相同参数生成相同的键', () => {
      const toolId = 'test-tool';
      const parameters = { param1: 'value1', param2: 'value2' };

      const key1 = cacheManager.generateCacheKey(toolId, parameters);
      const key2 = cacheManager.generateCacheKey(toolId, parameters);

      expect(key1).toBe(key2);
    });

    it('应该为不同参数生成不同的键', () => {
      const toolId = 'test-tool';
      const params1 = { param1: 'value1' };
      const params2 = { param1: 'value2' };

      const key1 = cacheManager.generateCacheKey(toolId, params1);
      const key2 = cacheManager.generateCacheKey(toolId, params2);

      expect(key1).not.toBe(key2);
    });

    it('应该处理复杂的参数对象', () => {
      const toolId = 'complex-tool';
      const parameters = {
        user: {
          name: 'John',
          age: 30,
        },
        tags: ['tag1', 'tag2'],
        metadata: {
          source: 'api',
          version: '1.0',
        },
      };

      const key = cacheManager.generateCacheKey(toolId, parameters);

      expect(key).toBeDefined();
      expect(typeof key).toBe('string');
      expect(key.length).toBeGreaterThan(0);
    });

    it('应该处理空参数对象', () => {
      const toolId = 'empty-params-tool';
      const parameters = {};

      const key = cacheManager.generateCacheKey(toolId, parameters);

      expect(key).toBeDefined();
      expect(key).toContain(toolId);
    });

    it('应该使用默认键生成器', () => {
      const toolId = 'custom-tool';
      const parameters = { test: 'value' };

      const key = cacheManager.generateCacheKey(toolId, parameters);

      expect(key).toContain(toolId);
      expect(typeof key).toBe('string');
    });
  });

  describe('缓存大小限制', () => {
    beforeEach(() => {
      cacheManager.destroy();
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
      cacheManager = new CacheManagerImpl({ ttl: 60, maxSize: 2 });
    });

    it('应该在达到最大大小时删除最旧的项', async () => {
      await cacheManager.set('key1', 'value1');
      vi.advanceTimersByTime(10);
      await cacheManager.set('key2', 'value2');
      vi.advanceTimersByTime(10);
      await cacheManager.set('key3', 'value3');

      expect(await cacheManager.get('key1')).toBeNull();
      expect(await cacheManager.get('key2')).toBe('value2');
      expect(await cacheManager.get('key3')).toBe('value3');
      expect(cacheManager.getStats().currentSize).toBe(2);
    });

    it('应该在访问时更新项目的使用时间', async () => {
      await cacheManager.set('key1', 'value1');
      vi.advanceTimersByTime(10);
      await cacheManager.set('key2', 'value2');

      vi.advanceTimersByTime(10);
      await cacheManager.get('key1');
      vi.advanceTimersByTime(10);
      await cacheManager.set('key3', 'value3');

      expect(await cacheManager.get('key1')).toBe('value1');
      expect(await cacheManager.get('key2')).toBeNull();
      expect(await cacheManager.get('key3')).toBe('value3');
    });

    it('更新已有键不应淘汰其他条目', async () => {
      await cacheManager.set('key1', 'value1');
      vi.advanceTimersByTime(10);
      await cacheManager.set('key2', 'value2');
      vi.advanceTimersByTime(10);
      await cacheManager.set('key1', 'updated');

      expect(await cacheManager.get('key1')).toBe('updated');
      expect(await cacheManager.get('key2')).toBe('value2');
      expect(cacheManager.getStats().currentSize).toBe(2);
    });

    it.each(['key1', ''])('同一毫秒写入仍应淘汰旧键 %j 并遵守容量限制', async (key) => {
      cacheManager.destroy();
      cacheManager = new CacheManagerImpl({ ttl: 60, maxSize: 1 });

      await cacheManager.set(key, 'old');
      await cacheManager.set('new-key', 'new');

      expect(cacheManager.getStats().currentSize).toBe(1);
      expect(await cacheManager.get(key)).toBeNull();
      expect(await cacheManager.get('new-key')).toBe('new');
    });

    it('并发写入也不能突破容量上限', async () => {
      await Promise.all(
        Array.from({ length: 10 }, (_, index) => cacheManager.set(`key-${index}`, index)),
      );

      const values = await Promise.all(
        Array.from({ length: 10 }, (_, index) => cacheManager.get(`key-${index}`)),
      );
      expect(cacheManager.getStats().currentSize).toBe(2);
      expect(values.filter((value) => value !== null)).toHaveLength(2);
    });
  });

  describe('缓存统计', () => {
    it('应该提供缓存统计信息', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
      await cacheManager.set('key1', 'value1');
      vi.setSystemTime(new Date('2026-01-01T00:00:00.010Z'));
      await cacheManager.set('key2', 'value2');

      // 命中
      await cacheManager.get('key1');
      await cacheManager.get('key1');

      // 未命中
      await cacheManager.get('non-existent');

      const stats = cacheManager.getStats();

      expect(stats.currentSize).toBe(2);
      expect(stats.hits).toBe(2);
      expect(stats.misses).toBe(1);
      expect(stats.hitRate).toBeCloseTo(0.67, 2);
    });
  });

  describe('缓存配置', () => {
    it('应该使用默认配置', () => {
      const stats = cacheManager.getStats();

      expect(stats).toBeDefined();
      expect(stats.currentSize).toBe(0);
    });
  });

  describe('内存管理', () => {
    it('应该清理过期的缓存项', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });

      const key1 = 'expire-test-1';
      const key2 = 'expire-test-2';

      await cacheManager.set(key1, 'value1', 0.1); // 0.1秒 TTL
      await cacheManager.set(key2, 'value2', 1); // 1秒 TTL

      // 等待第一个项目过期
      await vi.advanceTimersByTimeAsync(150);

      expect(await cacheManager.get(key1)).toBeNull();
      expect(await cacheManager.get(key2)).toBe('value2');

      vi.useRealTimers();
    });
  });

  describe('错误处理', () => {
    it('应该处理序列化错误', async () => {
      const circularObj: Record<string, unknown> = {};
      circularObj.self = circularObj; // 创建循环引用

      // 应该抛出序列化错误
      expect(() => cacheManager.generateCacheKey('test', circularObj)).toThrow();
    });

    it('应该处理大型对象', async () => {
      const largeObj = {
        data: 'x'.repeat(10000), // 10KB字符串
        array: Array.from({ length: 1000 }, (_, i) => ({
          id: i,
          value: `item-${i}`,
        })),
      };

      await cacheManager.set('large-object', largeObj);
      const result = await cacheManager.get('large-object');

      expect(result).toEqual(largeObj);
    });

    it('应该处理null和undefined值', async () => {
      await cacheManager.set('null-test', null);
      await cacheManager.set('undefined-test', undefined);

      expect(await cacheManager.get('null-test')).toBeNull();
      expect(await cacheManager.get('undefined-test')).toBeUndefined();
    });
  });

  describe('并发操作', () => {
    it('应该处理并发的设置和获取操作', async () => {
      const promises = Array.from({ length: 10 }, (_, i) =>
        cacheManager.set(`concurrent-${i}`, `value-${i}`),
      );

      await Promise.all(promises);

      const getPromises = Array.from({ length: 10 }, (_, i) => cacheManager.get(`concurrent-${i}`));

      const results = await Promise.all(getPromises);

      results.forEach((result, i) => {
        expect(result).toBe(`value-${i}`);
      });
    });

    it('应该处理并发的删除操作', async () => {
      // 设置多个缓存项
      const setPromises = Array.from({ length: 5 }, (_, i) =>
        cacheManager.set(`delete-concurrent-${i}`, `value-${i}`),
      );
      await Promise.all(setPromises);

      // 并发删除
      const deletePromises = Array.from({ length: 5 }, (_, i) =>
        cacheManager.delete(`delete-concurrent-${i}`),
      );
      await Promise.all(deletePromises);

      // 验证所有项目都被删除
      const getPromises = Array.from({ length: 5 }, (_, i) =>
        cacheManager.get(`delete-concurrent-${i}`),
      );
      const results = await Promise.all(getPromises);

      results.forEach((result) => {
        expect(result).toBeNull();
      });
    });
  });

  describe('资源清理', () => {
    it('销毁后不再触发定期清理', async () => {
      cacheManager.destroy();
      vi.useFakeTimers();
      cacheManager = new CacheManagerImpl();
      const cleanup = vi.spyOn(cacheManager, 'cleanup');

      cacheManager.destroy();
      await vi.advanceTimersByTimeAsync(120000);

      expect(cleanup).not.toHaveBeenCalled();
    });

    it('未销毁时每 60 秒自动触发定期清理', async () => {
      vi.useFakeTimers();
      cacheManager.destroy();
      cacheManager = new CacheManagerImpl();
      const cleanup = vi.spyOn(cacheManager, 'cleanup');

      await vi.advanceTimersByTimeAsync(60_000);
      expect(cleanup).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(60_000);
      expect(cleanup).toHaveBeenCalledTimes(2);
    });
  });

  describe('手动清理 cleanup()', () => {
    it('只清理过期项，保留未过期项并更新 currentSize', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));

      await cacheManager.set('short', 'v1', 1); // 1 秒后过期
      await cacheManager.set('long', 'v2', 3600);

      vi.setSystemTime(new Date('2026-01-01T00:00:01.500Z'));
      await cacheManager.cleanup();

      expect(await cacheManager.get('short')).toBeNull();
      expect(await cacheManager.get('long')).toBe('v2');
      expect(cacheManager.getStats().currentSize).toBe(1);
    });

    it('expiresAt 恰等于当前时间的条目视为过期（闭区间）', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));

      await cacheManager.set('zero-ttl', 'v', 0); // expiresAt === now
      await cacheManager.cleanup();

      expect(cacheManager.getStats().currentSize).toBe(0);
      expect(await cacheManager.get('zero-ttl')).toBeNull();
    });

    it('无过期项时不输出清理日志', async () => {
      await cacheManager.set('alive', 'v');
      loggerMock.debug.mockClear();

      await cacheManager.cleanup();

      expect(loggerMock.debug).not.toHaveBeenCalled();
    });
  });

  describe('缓存策略', () => {
    it('shouldCache 返回 false → 拒绝写入', async () => {
      const shouldCache = vi.fn().mockReturnValue(false);
      cacheManager.setStrategy({ name: 'reject-all', shouldCache, getTtl: vi.fn() });

      await cacheManager.set('rejected', 'value');

      expect(await cacheManager.get('rejected')).toBeNull();
      expect(cacheManager.getStats().currentSize).toBe(0);
      expect(shouldCache).toHaveBeenCalledWith('rejected', 'value');
    });

    it('策略 getTtl 覆盖显式传入的 TTL', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));

      cacheManager.setStrategy({
        name: 'short-ttl',
        shouldCache: () => true,
        getTtl: () => 1,
      });

      // 显式 TTL 很长，但策略 TTL=1 应生效
      await cacheManager.set('strategy-key', 'value', 3600);

      vi.setSystemTime(new Date('2026-01-01T00:00:01.500Z'));
      expect(await cacheManager.get('strategy-key')).toBeNull();
    });

    it('设置策略输出 debug 日志', () => {
      cacheManager.setStrategy({ name: 'my-strategy', shouldCache: () => true, getTtl: vi.fn() });

      expect(loggerMock.debug).toHaveBeenCalledWith('缓存策略已设置: my-strategy');
    });
  });

  describe('统计边界', () => {
    it('命中后立即更新命中率（无需再发生 miss）', async () => {
      await cacheManager.set('k', 'v');
      await cacheManager.get('k');

      const stats = cacheManager.getStats();
      expect(stats.hits).toBe(1);
      expect(stats.totalRequests).toBe(1);
      expect(stats.hitRate).toBe(1);
    });

    it('过期条目的 get 计入 miss、物理删除并同步 currentSize', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));

      await cacheManager.set('k', 'v', 1);
      vi.setSystemTime(new Date('2026-01-01T00:00:02Z'));

      expect(await cacheManager.get('k')).toBeNull();

      const stats = cacheManager.getStats();
      expect(stats.misses).toBe(1);
      expect(stats.currentSize).toBe(0);
    });

    it('命中后再发生过期 miss → 命中率按混合请求计算', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));

      await cacheManager.set('k', 'v', 1);
      expect(await cacheManager.get('k')).toBe('v'); // hit
      vi.setSystemTime(new Date('2026-01-01T00:00:02Z'));
      expect(await cacheManager.get('k')).toBeNull(); // expired miss

      expect(cacheManager.getStats().hitRate).toBe(0.5);
    });

    it('删除已有键后同步 currentSize；删除不存在的键不产生日志', async () => {
      await cacheManager.set('k', 'v');

      await cacheManager.delete('k');
      expect(cacheManager.getStats().currentSize).toBe(0);
      expect(loggerMock.debug).toHaveBeenCalledWith('缓存删除: k');

      loggerMock.debug.mockClear();
      await cacheManager.delete('not-exist');
      expect(loggerMock.debug).not.toHaveBeenCalled();
    });

    it('getStats 返回快照副本，修改不影响内部状态', async () => {
      await cacheManager.set('k', 'v');

      const stats = cacheManager.getStats();
      stats.currentSize = 999;
      stats.hits = 999;

      expect(cacheManager.getStats().currentSize).toBe(1);
      expect(cacheManager.getStats().hits).toBe(0);
    });

    it('clear 同时重置命中率与计数', async () => {
      await cacheManager.set('k', 'v');
      await cacheManager.get('k');
      await cacheManager.get('missing');

      await cacheManager.clear();

      const stats = cacheManager.getStats();
      expect(stats).toMatchObject({
        totalRequests: 0,
        hits: 0,
        misses: 0,
        hitRate: 0,
        currentSize: 0,
      });
      expect(loggerMock.debug).toHaveBeenCalledWith('缓存已清空');
    });
  });

  describe('TTL 与默认值边界', () => {
    it('ttl=0 立即过期（expiresAt === now 视为过期）', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));

      await cacheManager.set('k', 'v', 0);

      expect(await cacheManager.get('k')).toBeNull();
    });

    it('构造配置的 ttl 成为默认 TTL', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
      cacheManager.destroy();
      cacheManager = new CacheManagerImpl({ ttl: 1 });

      await cacheManager.set('k', 'v'); // 未显式传 TTL
      vi.setSystemTime(new Date('2026-01-01T00:00:01.500Z'));

      expect(await cacheManager.get('k')).toBeNull();
    });

    it('无自定义配置时默认 TTL 为 300 秒（日志可观测）', async () => {
      await cacheManager.set('k', 'v');

      expect(loggerMock.debug).toHaveBeenCalledWith('缓存设置: k, TTL: 300秒');
    });
  });

  describe('构造配置注入', () => {
    it('maxSize 配置生效并反映在统计中', () => {
      cacheManager.destroy();
      cacheManager = new CacheManagerImpl({ ttl: 60, maxSize: 5 });

      expect(cacheManager.getStats().maxSize).toBe(5);
    });

    it('maxSize: 0（falsy）不覆盖默认上限，容量按 1000 计', async () => {
      cacheManager.destroy();
      cacheManager = new CacheManagerImpl({ ttl: 60, maxSize: 0 });

      await cacheManager.set('k1', 'v1');
      await cacheManager.set('k2', 'v2');

      expect(cacheManager.getStats().currentSize).toBe(2);
    });

    it('注入自定义 keyGenerator → generateCacheKey 委托', () => {
      cacheManager.destroy();
      cacheManager = new CacheManagerImpl({
        ttl: 60,
        keyGenerator: (toolId, params) => `custom:${toolId}:${JSON.stringify(params)}`,
      });

      expect(cacheManager.generateCacheKey('tool', { a: 1 })).toBe('custom:tool:{"a":1}');
    });

    it('未注入 keyGenerator 时使用默认生成器', () => {
      cacheManager.destroy();
      cacheManager = new CacheManagerImpl({ ttl: 60 });

      const key = cacheManager.generateCacheKey('tool', { a: 1 });
      expect(key).toContain('tool:');
      expect(key.length).toBeGreaterThan('tool:'.length);
    });
  });

  describe('默认缓存键生成器', () => {
    it('键为 toolId + 参数排序后 JSON 的 sha256 前 16 位', () => {
      const key = cacheManager.generateCacheKey('test-tool', { b: 2, a: 1 });
      const expected = `test-tool:${createHash('sha256')
        .update('{"a":1,"b":2}')
        .digest('hex')
        .slice(0, 16)}`;

      expect(key).toBe(expected);
    });

    it('键顺序无关：相同参数不同顶层插入顺序生成相同键', () => {
      const k1 = cacheManager.generateCacheKey('tool', { x: 1, y: 'a' });
      const k2 = cacheManager.generateCacheKey('tool', { y: 'a', x: 1 });

      expect(k1).toBe(k2);
    });

    it('参数序列化失败 → 抛 API_TO_MCP_INTERNAL 且记录错误日志', () => {
      const circular: Record<string, unknown> = {};
      circular.self = circular;

      expect(() => cacheManager.generateCacheKey('tool', circular)).toThrow(/无法生成缓存键/);
      expect(loggerMock.error).toHaveBeenCalled();
    });
  });

  describe('LRU 平局边界', () => {
    it('同一毫秒写入的条目按写入顺序驱逐最早条目', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
      cacheManager.destroy();
      cacheManager = new CacheManagerImpl({ ttl: 60, maxSize: 2 });

      await cacheManager.set('k1', 'v1');
      await cacheManager.set('k2', 'v2'); // 与 k1 同毫秒
      vi.setSystemTime(new Date('2026-01-01T00:00:00.100Z'));
      await cacheManager.set('k3', 'v3'); // 触发驱逐

      expect(await cacheManager.get('k1')).toBeNull();
      expect(await cacheManager.get('k2')).toBe('v2');
      expect(await cacheManager.get('k3')).toBe('v3');
    });
  });

  describe('操作日志', () => {
    it('命中/驱逐输出对应 debug 日志', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
      cacheManager.destroy();
      cacheManager = new CacheManagerImpl({ ttl: 60, maxSize: 1 });

      await cacheManager.set('k1', 'v1');
      await cacheManager.get('k1');
      expect(loggerMock.debug).toHaveBeenCalledWith('缓存命中: k1');

      await cacheManager.set('k2', 'v2'); // 驱逐 k1
      expect(loggerMock.debug).toHaveBeenCalledWith('驱逐LRU缓存项: k1');
    });
  });
});

describe('RedisCacheManager', () => {
  let redisCache: RedisCacheManager;

  beforeEach(() => {
    redisCache = new RedisCacheManager({ ttl: 60 });
  });

  it('构造时输出占位实现告警', () => {
    expect(loggerMock.warn).toHaveBeenCalledWith(
      'RedisCacheManager 是一个占位符实现，需要实际的Redis客户端',
    );
  });

  it('get 恒返回 null 并计入 miss 统计', async () => {
    expect(await redisCache.get('any-key')).toBeNull();

    const stats = redisCache.getStats();
    expect(stats.totalRequests).toBe(1);
    expect(stats.misses).toBe(1);
    expect(stats.hits).toBe(0);
    expect(stats.hitRate).toBe(0);
    expect(stats.maxSize).toBe(-1); // Redis 无固定容量上限
  });

  it('set/delete/cleanup 为无害占位操作', async () => {
    await expect(redisCache.set('k', 'v', 10)).resolves.toBeUndefined();
    expect(loggerMock.debug).toHaveBeenCalledWith('Redis缓存设置: k, TTL: 10秒');

    await expect(redisCache.delete('k')).resolves.toBeUndefined();
    expect(loggerMock.debug).toHaveBeenCalledWith('Redis缓存删除: k');

    await expect(redisCache.cleanup()).resolves.toBeUndefined();
    expect(loggerMock.debug).toHaveBeenCalledWith('Redis自动处理过期项，无需手动清理');

    expect(() =>
      redisCache.setStrategy({ name: 's', shouldCache: () => true, getTtl: vi.fn() }),
    ).not.toThrow();
  });

  it('clear 重置全部统计', async () => {
    await redisCache.get('a');
    await redisCache.get('b');

    await redisCache.clear();

    expect(redisCache.getStats()).toMatchObject({
      totalRequests: 0,
      hits: 0,
      misses: 0,
      hitRate: 0,
    });
    expect(loggerMock.debug).toHaveBeenCalledWith('Redis缓存已清空');
  });

  it('generateCacheKey 使用默认生成器，可注入自定义生成器', () => {
    const key = redisCache.generateCacheKey('tool', { a: 1 });
    expect(key).toBe(`tool:${createHash('sha256').update('{"a":1}').digest('hex').slice(0, 16)}`);

    const custom = new RedisCacheManager({
      ttl: 60,
      keyGenerator: () => 'fixed-key',
    });
    expect(custom.generateCacheKey('tool', {})).toBe('fixed-key');
  });

  it('getStats 返回快照副本', async () => {
    await redisCache.get('a');

    const stats = redisCache.getStats();
    stats.totalRequests = 100;

    expect(redisCache.getStats().totalRequests).toBe(1);
  });
});

describe('MultiLevelCacheManager', () => {
  it('仅 L1：命中直接返回，未命中返回 null', async () => {
    const manager = new MultiLevelCacheManager({ ttl: 60 });

    await manager.set('k', 'v');
    expect(await manager.get('k')).toBe('v');
    expect(await manager.get('missing')).toBeNull();
  });

  it('带 L2：set 同时写 L1；get L1 命中不触发 L2', async () => {
    const manager = new MultiLevelCacheManager({ ttl: 60 }, { ttl: 60, redisUrl: 'redis://x' });

    await manager.set('k', 'v');
    // L2 是占位实现恒 miss，值仍可从 L1 读回
    expect(await manager.get('k')).toBe('v');

    const stats = manager.getStats();
    expect(stats.currentSize).toBeGreaterThanOrEqual(1);
  });

  it('delete/clear 委托到 L1（条目被移除）', async () => {
    const manager = new MultiLevelCacheManager({ ttl: 60 });

    await manager.set('k', 'v');
    await manager.delete('k');
    expect(await manager.get('k')).toBeNull();

    await manager.set('k2', 'v2');
    await manager.clear();
    expect(await manager.get('k2')).toBeNull();
  });

  it('getStats：无 L2 时直接返回 L1 统计', async () => {
    const manager = new MultiLevelCacheManager({ ttl: 60, maxSize: 7 });

    await manager.set('k', 'v');
    await manager.get('k');

    const stats = manager.getStats();
    expect(stats.hits).toBe(1);
    expect(stats.maxSize).toBe(7);
  });

  it('getStats：带 L2 时合并两层统计', async () => {
    const manager = new MultiLevelCacheManager({ ttl: 60 }, { ttl: 60, redisUrl: 'redis://x' });

    await manager.get('k'); // L1 miss + L2 miss
    await manager.set('k', 'v');
    await manager.get('k'); // L1 hit

    const stats = manager.getStats();
    expect(stats.totalRequests).toBe(3); // L1 两次 get + L2 首次 get 穿透
    expect(stats.hits).toBe(1); // L1 第二次 get 命中
    expect(stats.misses).toBe(2); // L1 首次 miss + L2 miss
  });

  it('注入 keyGenerator → generateCacheKey 使用之', () => {
    const manager = new MultiLevelCacheManager({
      ttl: 60,
      keyGenerator: () => 'ml-fixed',
    });

    expect(manager.generateCacheKey('tool', {})).toBe('ml-fixed');
  });

  it('setStrategy/cleanup 委托不抛错', async () => {
    const manager = new MultiLevelCacheManager({ ttl: 60 }, { ttl: 60, redisUrl: 'redis://x' });

    expect(() =>
      manager.setStrategy({ name: 's', shouldCache: () => true, getTtl: vi.fn() }),
    ).not.toThrow();
    await expect(manager.cleanup()).resolves.toBeUndefined();
  });
});

describe('createCacheManager 工厂', () => {
  it('默认/显式 memory → 内存实现（可正常读写）', async () => {
    const byDefault = createCacheManager();
    const byMemory = createCacheManager({ type: 'memory', ttl: 60 });

    await byDefault.set('k', 'v');
    expect(await byDefault.get('k')).toBe('v');
    expect(byMemory).toBeInstanceOf(CacheManagerImpl);
  });

  it('redis → Redis 实现（恒 miss）', async () => {
    const manager = createCacheManager({ type: 'redis', ttl: 60 });

    expect(manager).toBeInstanceOf(RedisCacheManager);
    expect(await manager.get('k')).toBeNull();
  });

  it('multi → 多级实现（可正常读写）', async () => {
    const manager = createCacheManager({ type: 'multi', ttl: 60 });

    expect(manager).toBeInstanceOf(MultiLevelCacheManager);
    await manager.set('k', 'v');
    expect(await manager.get('k')).toBe('v');
  });

  it('不支持的类型 → 抛 ServiceError', () => {
    expect(() => createCacheManager({ type: 'memcached' as 'memory', ttl: 60 })).toThrow(
      '不支持的缓存类型: memcached',
    );
  });
});
