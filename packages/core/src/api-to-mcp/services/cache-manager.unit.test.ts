/**
 * 缓存管理器测试
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CacheManagerImpl } from './cache-manager.js';

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

describe('CacheManagerImpl', () => {
  let cacheManager: CacheManagerImpl;

  beforeEach(() => {
    cacheManager = new CacheManagerImpl();
  });

  afterEach(() => {
    cacheManager.destroy();
    vi.useRealTimers();
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
  });
});
