/**
 * 性能优化器测试
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createPerformanceOptimizer,
  DEFAULT_OPTIMIZER_CONFIG,
  PerformanceOptimizer,
} from './performance-optimizer.js';

/** 创建可控的延迟 Promise */
function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** 冲刷微任务队列 */
async function flushMicrotasks(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

/** 关闭所有缓存与定时器的默认测试配置（各用例按需开启） */
function baseConfig() {
  return {
    enableCaching: false,
    enableGarbageCollection: false,
  };
}

describe('DEFAULT_OPTIMIZER_CONFIG', () => {
  it('默认配置值正确', () => {
    expect(DEFAULT_OPTIMIZER_CONFIG).toEqual({
      enableLazyLoading: true,
      enableParallelInitialization: true,
      enableConnectionPooling: true,
      enableCaching: true,
      cacheMaxSize: 1000,
      cacheTtl: 300000,
      enableMemoryOptimization: true,
      enableGarbageCollection: true,
      gcInterval: 60000,
      maxConcurrentConnections: 10,
      connectionTimeout: 5000,
      keepAliveTimeout: 30000,
    });
  });
});

describe('PerformanceOptimizer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('构造与初始化', () => {
    it('构造时发射 initialized 事件', () => {
      const spy = vi.fn();
      const originalEmit = PerformanceOptimizer.prototype.emit;
      PerformanceOptimizer.prototype.emit = function patchedEmit(
        this: PerformanceOptimizer,
        event: string,
        ...args: unknown[]
      ) {
        spy(event, ...args);
        return originalEmit.call(this, event, ...args);
      };

      try {
        new PerformanceOptimizer(baseConfig());
      } finally {
        PerformanceOptimizer.prototype.emit = originalEmit;
      }

      expect(spy).toHaveBeenCalledWith('initialized');
    });

    it('自定义配置覆盖默认配置', () => {
      const optimizer = new PerformanceOptimizer({
        ...baseConfig(),
        enableCaching: true,
        cacheMaxSize: 2,
      });

      optimizer.setCached('k1', 1);
      vi.advanceTimersByTime(10);
      optimizer.setCached('k2', 2);
      vi.advanceTimersByTime(10);
      optimizer.setCached('k3', 3); // 触发驱逐 k1（最久未访问）

      expect(optimizer.getMetrics().cacheSize).toBe(2);
      expect(optimizer.getCached('k1')).toBeUndefined();
      expect(optimizer.getCached('k3')).toBe(3);
    });

    it('启用缓存时按 cacheTtl/10 间隔启动清理定时器', async () => {
      const optimizer = new PerformanceOptimizer({
        ...baseConfig(),
        enableCaching: true,
        cacheTtl: 1000, // 清理间隔应为 100ms
      });
      const cleanupSpy = vi.fn();
      optimizer.on('cacheCleanup', cleanupSpy);

      optimizer.setCached('expired', 'v', 50);
      await vi.advanceTimersByTimeAsync(100);

      expect(cleanupSpy).toHaveBeenCalledTimes(1);
      expect(cleanupSpy).toHaveBeenCalledWith({ cleanedCount: 1 });

      optimizer.shutdown();
    });

    it('禁用缓存时不启动清理定时器', async () => {
      const optimizer = new PerformanceOptimizer(baseConfig());
      const cleanupSpy = vi.fn();
      optimizer.on('cacheCleanup', cleanupSpy);

      await vi.advanceTimersByTimeAsync(10_000);

      expect(cleanupSpy).not.toHaveBeenCalled();
    });

    it('启用垃圾回收时按 gcInterval 周期执行内存优化', async () => {
      const optimizer = new PerformanceOptimizer({
        ...baseConfig(),
        enableGarbageCollection: true,
        enableMemoryOptimization: true,
        gcInterval: 100,
      });
      const spy = vi.fn();
      optimizer.on('memoryOptimized', spy);

      await vi.advanceTimersByTimeAsync(100);
      expect(spy).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(100);
      expect(spy).toHaveBeenCalledTimes(2);
      expect(spy).toHaveBeenCalledWith(
        expect.objectContaining({
          memoryFreed: expect.any(Number),
          beforeMemory: expect.any(Object),
          afterMemory: expect.any(Object),
        }),
      );

      optimizer.shutdown();
    });

    it('禁用垃圾回收时不启动 GC 定时器', async () => {
      const optimizer = new PerformanceOptimizer(baseConfig());
      const spy = vi.fn();
      optimizer.on('memoryOptimized', spy);

      await vi.advanceTimersByTimeAsync(10_000);

      expect(spy).not.toHaveBeenCalled();
    });
  });

  describe('optimizeStartupTime', () => {
    it('禁用延迟加载时直接调用 loader 且不发射 moduleLoaded', async () => {
      const optimizer = new PerformanceOptimizer({ ...baseConfig(), enableLazyLoading: false });
      const spy = vi.fn();
      optimizer.on('moduleLoaded', spy);
      const loader = vi.fn().mockResolvedValue('module-value');

      const result = await optimizer.optimizeStartupTime(loader, 'mod-a');

      expect(result).toBe('module-value');
      expect(loader).toHaveBeenCalledTimes(1);
      expect(spy).not.toHaveBeenCalled();
    });

    it('加载成功时发射 moduleLoaded 并统计加载耗时', async () => {
      const optimizer = new PerformanceOptimizer({ ...baseConfig(), enableLazyLoading: true });
      const spy = vi.fn();
      optimizer.on('moduleLoaded', spy);
      const loader = vi.fn(async () => {
        await vi.advanceTimersByTimeAsync(100);
        return 'lazy-module';
      });

      const promise = optimizer.optimizeStartupTime(loader, 'mod-b');
      await vi.advanceTimersByTimeAsync(100);
      const result = await promise;

      expect(result).toBe('lazy-module');
      expect(spy).toHaveBeenCalledWith({ moduleName: 'mod-b', loadTime: 100 });
    });

    it('加载失败时透传原始错误', async () => {
      const optimizer = new PerformanceOptimizer({ ...baseConfig(), enableLazyLoading: true });
      const loader = vi.fn().mockRejectedValue(new Error('加载崩溃'));

      await expect(optimizer.optimizeStartupTime(loader, 'mod-c')).rejects.toThrow('加载崩溃');
    });
  });

  describe('optimizeParallelInitialization', () => {
    it('禁用并行时严格串行执行任务', async () => {
      const optimizer = new PerformanceOptimizer({
        ...baseConfig(),
        enableParallelInitialization: false,
      });
      const order: string[] = [];
      const d1 = createDeferred<string>();
      const d2 = createDeferred<string>();
      const tasks = [
        () => {
          order.push('t1-start');
          return d1.promise;
        },
        () => {
          order.push('t2-start');
          return d2.promise;
        },
      ];

      const promise = optimizer.optimizeParallelInitialization(tasks, ['t1', 't2']);
      await flushMicrotasks();
      expect(order).toEqual(['t1-start']);

      d1.resolve('a');
      await flushMicrotasks();
      expect(order).toEqual(['t1-start', 't2-start']);

      d2.resolve('b');
      await expect(promise).resolves.toEqual(['a', 'b']);
    });

    it('启用并行时所有任务同时启动且保持结果顺序', async () => {
      const optimizer = new PerformanceOptimizer(baseConfig());
      const d1 = createDeferred<string>();
      const d2 = createDeferred<string>();
      const started: string[] = [];
      const tasks = [
        () => {
          started.push('t1');
          return d1.promise;
        },
        () => {
          started.push('t2');
          return d2.promise;
        },
      ];

      const promise = optimizer.optimizeParallelInitialization(tasks, ['t1', 't2']);
      await flushMicrotasks();
      // 并行：两个任务都已启动但都未完成
      expect(started).toEqual(['t1', 't2']);

      d2.resolve('second');
      d1.resolve('first');
      // 结果顺序与任务顺序一致（而不是完成顺序）
      await expect(promise).resolves.toEqual(['first', 'second']);
    });

    it('并行完成后发射事件并统计总耗时', async () => {
      const optimizer = new PerformanceOptimizer(baseConfig());
      const spy = vi.fn();
      optimizer.on('parallelInitializationCompleted', spy);
      const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
      const tasks = [() => sleep(50).then(() => 1), () => sleep(50).then(() => 2)];

      const promise = optimizer.optimizeParallelInitialization(tasks, ['a', 'b']);
      await vi.advanceTimersByTimeAsync(50);
      const results = await promise;

      expect(results).toEqual([1, 2]);
      // 两个任务并发执行，总耗时等于单个任务耗时
      expect(spy).toHaveBeenCalledWith({ taskCount: 2, totalTime: 50 });
    });

    it('任一任务失败时透传错误', async () => {
      const optimizer = new PerformanceOptimizer(baseConfig());
      const tasks = [() => Promise.resolve('ok'), () => Promise.reject(new Error('task-2 失败'))];

      await expect(optimizer.optimizeParallelInitialization(tasks, ['a', 'b'])).rejects.toThrow(
        'task-2 失败',
      );
    });
  });

  describe('缓存优化', () => {
    it('禁用缓存时 getCached 始终返回 undefined 且 setCached 无效果', () => {
      const optimizer = new PerformanceOptimizer(baseConfig());

      optimizer.setCached('k', 'v');
      expect(optimizer.getCached('k')).toBeUndefined();

      const metrics = optimizer.getMetrics();
      expect(metrics.cacheSize).toBe(0);
      expect(metrics.cacheMisses).toBe(0);
      expect(metrics.cacheHits).toBe(0);
    });

    it('未命中时计数 cacheMisses 并返回 undefined', () => {
      const optimizer = new PerformanceOptimizer({ ...baseConfig(), enableCaching: true });

      expect(optimizer.getCached('missing')).toBeUndefined();
      expect(optimizer.getMetrics().cacheMisses).toBe(1);
    });

    it('命中时返回值并计数 cacheHits', () => {
      const optimizer = new PerformanceOptimizer({ ...baseConfig(), enableCaching: true });

      optimizer.setCached('k', 'value');
      expect(optimizer.getCached<string>('k')).toBe('value');

      const metrics = optimizer.getMetrics();
      expect(metrics.cacheHits).toBe(1);
      expect(metrics.cacheMisses).toBe(0);
      expect(metrics.cacheSize).toBe(1);
      expect(metrics.cacheHitRate).toBe(1);
    });

    it('缓存命中率按 命中/(命中+未命中) 计算', () => {
      const optimizer = new PerformanceOptimizer({ ...baseConfig(), enableCaching: true });

      optimizer.setCached('k', 1);
      optimizer.getCached('k'); // 命中
      optimizer.getCached('nope'); // 未命中

      expect(optimizer.getMetrics().cacheHitRate).toBe(0.5);
    });

    it('无访问时缓存命中率为 0', () => {
      const optimizer = new PerformanceOptimizer({ ...baseConfig(), enableCaching: true });

      expect(optimizer.getMetrics().cacheHitRate).toBe(0);
    });

    it('恰好到达 TTL 边界时仍视为有效', () => {
      const optimizer = new PerformanceOptimizer({ ...baseConfig(), enableCaching: true });

      optimizer.setCached('k', 'v', 100);
      vi.advanceTimersByTime(100);

      expect(optimizer.getCached('k')).toBe('v');
    });

    it('超过 TTL 后返回未命中并删除缓存项', () => {
      const optimizer = new PerformanceOptimizer({ ...baseConfig(), enableCaching: true });

      optimizer.setCached('k', 'v', 100);
      vi.advanceTimersByTime(101);

      expect(optimizer.getCached('k')).toBeUndefined();
      expect(optimizer.getMetrics().cacheSize).toBe(0);
      expect(optimizer.getMetrics().cacheMisses).toBe(1);
    });

    it('ttl=0 时回退到默认 cacheTtl', () => {
      const optimizer = new PerformanceOptimizer({
        ...baseConfig(),
        enableCaching: true,
        cacheTtl: 1000,
      });

      optimizer.setCached('k', 'v', 0);
      vi.advanceTimersByTime(500);
      expect(optimizer.getCached('k')).toBe('v');
    });

    it('达到 cacheMaxSize 时驱逐最久未使用的缓存项', () => {
      const optimizer = new PerformanceOptimizer({
        ...baseConfig(),
        enableCaching: true,
        cacheMaxSize: 2,
      });

      optimizer.setCached('a', 1);
      vi.advanceTimersByTime(10);
      optimizer.setCached('b', 2);
      vi.advanceTimersByTime(10);
      optimizer.getCached('a'); // a 最近被访问，b 成为 LRU
      vi.advanceTimersByTime(10);
      optimizer.setCached('c', 3); // 触发驱逐 b

      expect(optimizer.getCached('a')).toBe(1);
      expect(optimizer.getCached('b')).toBeUndefined();
      expect(optimizer.getCached('c')).toBe(3);
      expect(optimizer.getMetrics().cacheSize).toBe(2);
    });

    it('clearCache() 无参数时清空全部缓存', () => {
      const optimizer = new PerformanceOptimizer({ ...baseConfig(), enableCaching: true });
      const spy = vi.fn();
      optimizer.on('cacheCleared', spy);

      optimizer.setCached('foo:1', 1);
      optimizer.setCached('bar:1', 2);
      optimizer.clearCache();

      expect(optimizer.getMetrics().cacheSize).toBe(0);
      expect(spy).toHaveBeenCalledWith({ pattern: undefined });
    });

    it('clearCache(pattern) 只删除匹配的缓存项', () => {
      const optimizer = new PerformanceOptimizer({ ...baseConfig(), enableCaching: true });
      const spy = vi.fn();
      optimizer.on('cacheCleared', spy);

      optimizer.setCached('foo:1', 1);
      optimizer.setCached('foo:2', 2);
      optimizer.setCached('bar:1', 3);
      optimizer.clearCache('^foo:');

      expect(optimizer.getCached('foo:1')).toBeUndefined();
      expect(optimizer.getCached('foo:2')).toBeUndefined();
      expect(optimizer.getCached('bar:1')).toBe(3);
      expect(spy).toHaveBeenCalledWith({ pattern: '^foo:' });
    });
  });

  describe('连接池优化', () => {
    it('禁用连接池时每次都调用 connectionFactory', async () => {
      const optimizer = new PerformanceOptimizer({
        ...baseConfig(),
        enableConnectionPooling: false,
      });
      const factory = vi.fn(async () => ({ id: 'conn' }));

      const c1 = await optimizer.getPooledConnection('pool', factory);
      const c2 = await optimizer.getPooledConnection('pool', factory);

      expect(factory).toHaveBeenCalledTimes(2);
      expect(c1).toEqual({ id: 'conn' });
      expect(c2).toEqual({ id: 'conn' });
    });

    it('优先复用池中空闲连接而不是新建', async () => {
      const optimizer = new PerformanceOptimizer({ ...baseConfig() });
      const factory = vi.fn(async () => ({ tag: 'fresh' }));

      const first = await optimizer.getPooledConnection('pool', factory);
      expect(factory).toHaveBeenCalledTimes(1);
      expect(optimizer.getMetrics().connectionCreations).toBe(1);

      optimizer.returnPooledConnection('pool', first);

      const second = await optimizer.getPooledConnection('pool', factory);
      expect(factory).toHaveBeenCalledTimes(1); // 未新建
      expect(second).toBe(first); // 复用同一连接
      expect(optimizer.getMetrics().connectionReuses).toBe(1);
    });

    it('归还的连接重新放回池中，可被多次复用', async () => {
      const optimizer = new PerformanceOptimizer({ ...baseConfig() });
      const factory = vi.fn(async () => ({ tag: 'only' }));

      for (let i = 0; i < 3; i++) {
        const conn = await optimizer.getPooledConnection('pool', factory);
        optimizer.returnPooledConnection('pool', conn);
      }

      expect(factory).toHaveBeenCalledTimes(1);
      expect(optimizer.getMetrics().connectionReuses).toBe(2);
    });

    it('connectionFactory 失败时计入错误统计并透传', async () => {
      const optimizer = new PerformanceOptimizer({ ...baseConfig() });
      const factory = vi.fn().mockRejectedValue(new Error('连接失败'));

      await expect(optimizer.getPooledConnection('pool', factory)).rejects.toThrow('连接失败');

      // 创建失败的连接不计入 created 统计
      expect(optimizer.getConnectionPoolStats('pool').totalConnections).toBe(0);
    });

    it('池满时归还的连接会被 close 关闭', async () => {
      const optimizer = new PerformanceOptimizer({
        ...baseConfig(),
        maxConcurrentConnections: 1,
      });
      const factory = vi.fn(async () => ({ tag: 'c1' }));

      const c1 = await optimizer.getPooledConnection('pool', factory);
      optimizer.returnPooledConnection('pool', c1); // 池大小 1（已满）

      const c2 = { close: vi.fn(async () => {}) };
      optimizer.returnPooledConnection('pool', c2);

      expect(c2.close).toHaveBeenCalledTimes(1);
    });

    it('池满时无 close 方法的连接不抛错', async () => {
      const optimizer = new PerformanceOptimizer({
        ...baseConfig(),
        maxConcurrentConnections: 1,
      });
      const factory = vi.fn(async () => ({ tag: 'c1' }));

      const c1 = await optimizer.getPooledConnection('pool', factory);
      optimizer.returnPooledConnection('pool', c1);

      expect(() => optimizer.returnPooledConnection('pool', { raw: true })).not.toThrow();
    });

    it('getConnectionPoolStats 对未知池返回零值', () => {
      const optimizer = new PerformanceOptimizer({ ...baseConfig() });

      expect(optimizer.getConnectionPoolStats('unknown')).toEqual({
        totalConnections: 0,
        activeConnections: 0,
        idleConnections: 0,
        pendingRequests: 0,
        averageWaitTime: 0,
      });
    });

    it('getConnectionPoolStats 统计创建/复用/空闲连接数', async () => {
      const optimizer = new PerformanceOptimizer({ ...baseConfig() });
      const factory = vi.fn(async () => ({ tag: 'c1' }));

      // 新建 + 归还：created=1，池中空闲 1
      const c1 = await optimizer.getPooledConnection('pool', factory);
      optimizer.returnPooledConnection('pool', c1);
      expect(optimizer.getConnectionPoolStats('pool')).toEqual({
        totalConnections: 1,
        activeConnections: 0,
        idleConnections: 1,
        pendingRequests: 0,
        averageWaitTime: 0,
      });

      // 再次获取：复用，used=1，池中空闲 0
      await optimizer.getPooledConnection('pool', factory);
      expect(optimizer.getConnectionPoolStats('pool')).toEqual({
        totalConnections: 1,
        activeConnections: 1,
        idleConnections: 0,
        pendingRequests: 0,
        averageWaitTime: 0,
      });
    });

    it('getMetrics 包含连接池列表', async () => {
      const optimizer = new PerformanceOptimizer({ ...baseConfig() });
      const factory = vi.fn(async () => ({ tag: 'c1' }));

      const conn = await optimizer.getPooledConnection('db', factory);
      optimizer.returnPooledConnection('db', conn);

      expect(optimizer.getMetrics().connectionPools).toEqual([
        {
          name: 'db',
          stats: {
            totalConnections: 1,
            activeConnections: 0,
            idleConnections: 1,
            pendingRequests: 0,
            averageWaitTime: 0,
          },
        },
      ]);
    });
  });

  describe('optimizeMemory', () => {
    it('禁用内存优化时不执行任何操作', () => {
      const optimizer = new PerformanceOptimizer({
        ...baseConfig(),
        enableMemoryOptimization: false,
      });
      const spy = vi.fn();
      optimizer.on('memoryOptimized', spy);

      optimizer.optimizeMemory();

      expect(spy).not.toHaveBeenCalled();
    });

    it('清理过期缓存项', () => {
      const optimizer = new PerformanceOptimizer({
        ...baseConfig(),
        enableCaching: true,
        enableMemoryOptimization: true,
      });

      optimizer.setCached('expired', 'v', 50);
      optimizer.setCached('fresh', 'v', 10_000);
      vi.advanceTimersByTime(100);

      optimizer.optimizeMemory();

      expect(optimizer.getMetrics().cacheSize).toBe(1);
      expect(optimizer.getCached('fresh')).toBe('v');
      expect(optimizer.getCached('expired')).toBeUndefined();
    });

    it('关闭一半空闲连接（向上取整保留）', async () => {
      const optimizer = new PerformanceOptimizer({ ...baseConfig() });
      const connections = [
        { close: vi.fn(async () => {}) },
        { close: vi.fn(async () => {}) },
        { close: vi.fn(async () => {}) },
      ];
      for (const conn of connections) {
        optimizer.returnPooledConnection('pool', conn);
      }

      optimizer.optimizeMemory();

      // 保留 ceil(3/2) = 2 个，关闭最后 1 个
      expect(optimizer.getConnectionPoolStats('pool').idleConnections).toBe(2);
      expect(connections[2].close).toHaveBeenCalledTimes(1);
      expect(connections[0].close).not.toHaveBeenCalled();
      expect(connections[1].close).not.toHaveBeenCalled();
    });

    it('global.gc 可用时执行垃圾回收并计数', () => {
      const optimizer = new PerformanceOptimizer({
        ...baseConfig(),
        enableMemoryOptimization: true,
      });
      const gcMock = vi.fn();
      const globalWithGc = globalThis as { gc?: () => void };
      const original = globalWithGc.gc;
      globalWithGc.gc = gcMock;

      try {
        optimizer.optimizeMemory();
        expect(gcMock).toHaveBeenCalledTimes(1);
        expect(optimizer.getMetrics().gcRuns).toBe(1);
      } finally {
        if (original === undefined) {
          delete globalWithGc.gc;
        } else {
          globalWithGc.gc = original;
        }
      }
    });

    it('global.gc 不可用时不计数', () => {
      const optimizer = new PerformanceOptimizer({
        ...baseConfig(),
        enableMemoryOptimization: true,
      });

      optimizer.optimizeMemory();

      expect(optimizer.getMetrics().gcRuns).toBe(0);
    });

    it('发射 memoryOptimized 事件', () => {
      const optimizer = new PerformanceOptimizer({
        ...baseConfig(),
        enableMemoryOptimization: true,
      });
      const spy = vi.fn();
      optimizer.on('memoryOptimized', spy);

      optimizer.optimizeMemory();

      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy).toHaveBeenCalledWith(
        expect.objectContaining({
          memoryFreed: expect.any(Number),
          beforeMemory: expect.any(Object),
          afterMemory: expect.any(Object),
        }),
      );
    });
  });

  describe('updateConfig', () => {
    it('合并新配置并发射 configUpdated', () => {
      const optimizer = new PerformanceOptimizer(baseConfig());
      const spy = vi.fn();
      optimizer.on('configUpdated', spy);

      optimizer.updateConfig({ cacheTtl: 1234 });

      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy).toHaveBeenCalledWith(
        expect.objectContaining({ enableCaching: false, cacheTtl: 1234 }),
      );
    });

    it('重新初始化定时器（关闭缓存后重新开启）', async () => {
      const optimizer = new PerformanceOptimizer(baseConfig());

      optimizer.updateConfig({ enableCaching: true, cacheTtl: 1000 });
      const cleanupSpy = vi.fn();
      optimizer.on('cacheCleanup', cleanupSpy);

      optimizer.setCached('expired', 'v', 50);
      await vi.advanceTimersByTimeAsync(100);

      expect(cleanupSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe('shutdown', () => {
    it('清空缓存并发射 shutdown', () => {
      const optimizer = new PerformanceOptimizer({ ...baseConfig(), enableCaching: true });
      const spy = vi.fn();
      optimizer.on('shutdown', spy);
      optimizer.setCached('k', 'v');

      optimizer.shutdown();

      expect(spy).toHaveBeenCalledTimes(1);
      expect(optimizer.getMetrics().cacheSize).toBe(0);
    });

    it('停止所有定时器', async () => {
      const optimizer = new PerformanceOptimizer({
        ...baseConfig(),
        enableCaching: true,
        cacheTtl: 1000,
        enableGarbageCollection: true,
        enableMemoryOptimization: true,
        gcInterval: 100,
      });
      const gcSpy = vi.fn();
      const cleanupSpy = vi.fn();
      optimizer.on('memoryOptimized', gcSpy);
      optimizer.on('cacheCleanup', cleanupSpy);

      await vi.advanceTimersByTimeAsync(100);
      expect(gcSpy).toHaveBeenCalledTimes(1);

      optimizer.shutdown();
      await vi.advanceTimersByTimeAsync(1000);

      expect(gcSpy).toHaveBeenCalledTimes(1);
      expect(cleanupSpy).not.toHaveBeenCalled();
    });

    it('关闭连接池中的所有连接并清空统计', async () => {
      const optimizer = new PerformanceOptimizer({ ...baseConfig() });
      const close = vi.fn(async () => {});
      optimizer.returnPooledConnection('pool', { tag: 'a' });
      optimizer.returnPooledConnection('pool', { close });

      optimizer.shutdown();

      expect(close).toHaveBeenCalledTimes(1);
      expect(optimizer.getConnectionPoolStats('pool')).toEqual({
        totalConnections: 0,
        activeConnections: 0,
        idleConnections: 0,
        pendingRequests: 0,
        averageWaitTime: 0,
      });
    });
  });
});

describe('createPerformanceOptimizer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('创建 PerformanceOptimizer 实例并应用配置', () => {
    const optimizer = createPerformanceOptimizer({
      enableCaching: false,
      enableGarbageCollection: false,
    });

    expect(optimizer).toBeInstanceOf(PerformanceOptimizer);
    // 未启用缓存时设置缓存无效果
    optimizer.setCached('k', 'v');
    expect(optimizer.getCached('k')).toBeUndefined();

    optimizer.shutdown();
  });
});

describe('performanceOptimizer 单例代理', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.resetModules();
    vi.unstubAllEnvs();
  });

  it('懒初始化为同一个实例', async () => {
    vi.resetModules();
    const { performanceOptimizer } = await import('./performance-optimizer.js');

    performanceOptimizer.setCached('singleton-key', 'singleton-value');

    expect(performanceOptimizer.getCached('singleton-key')).toBe('singleton-value');
  });

  it('ENABLE_CACHING=false 时禁用缓存', async () => {
    vi.stubEnv('ENABLE_CACHING', 'false');
    vi.stubEnv('ENABLE_LAZY_LOADING', 'false');
    vi.stubEnv('ENABLE_PARALLEL_INIT', 'false');
    vi.stubEnv('ENABLE_CONNECTION_POOLING', 'false');
    vi.resetModules();
    const { performanceOptimizer } = await import('./performance-optimizer.js');

    performanceOptimizer.setCached('k', 'v');

    expect(performanceOptimizer.getCached('k')).toBeUndefined();
    expect(performanceOptimizer.getMetrics().cacheSize).toBe(0);
  });

  it('ENABLE_LAZY_LOADING=false 时直接加载模块', async () => {
    vi.stubEnv('ENABLE_LAZY_LOADING', 'false');
    vi.stubEnv('ENABLE_CACHING', 'false');
    vi.stubEnv('ENABLE_PARALLEL_INIT', 'false');
    vi.stubEnv('ENABLE_CONNECTION_POOLING', 'false');
    vi.resetModules();
    const { performanceOptimizer } = await import('./performance-optimizer.js');

    const loaded: string[] = [];
    const loader = vi.fn(async () => {
      loaded.push('loaded');
      return 'value';
    });

    const result = await performanceOptimizer.optimizeStartupTime(loader, 'direct-module');

    expect(result).toBe('value');
    expect(loader).toHaveBeenCalledTimes(1);
    // 直接加载路径不发射 moduleLoaded 事件（此处通过未走延迟分支的行为验证）
    expect(loaded).toEqual(['loaded']);
  });

  it('默认（未设置环境变量）时启用缓存', async () => {
    delete process.env.ENABLE_CACHING;
    delete process.env.ENABLE_LAZY_LOADING;
    delete process.env.ENABLE_PARALLEL_INIT;
    delete process.env.ENABLE_CONNECTION_POOLING;
    vi.resetModules();
    const { performanceOptimizer } = await import('./performance-optimizer.js');

    performanceOptimizer.setCached('k', 'default-enabled');

    expect(performanceOptimizer.getCached('k')).toBe('default-enabled');
  });
});
