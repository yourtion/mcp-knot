/**
 * 缓存管理器实现
 * 提供多级缓存支持，包括内存缓存和可选的Redis缓存
 */

import crypto from 'node:crypto';

import { ErrorCode, ServiceError } from '../../errors/index.js';
import { logger } from '../../utils/logger.js';

import type { CacheConfig, CacheKeyGenerator } from '../types/api-config.js';
import type { CacheEntry, CacheStats, CacheStrategy } from '../types/cache.js';

/**
 * 缓存管理器接口
 */
export interface CacheManager {
  /** 获取缓存值 */
  get(key: string): Promise<unknown | null>;

  /** 设置缓存值 */
  set(key: string, value: unknown, ttl?: number): Promise<void>;

  /** 删除缓存项 */
  delete(key: string): Promise<void>;

  /** 清空所有缓存 */
  clear(): Promise<void>;

  /** 生成缓存键 */
  generateCacheKey(toolId: string, parameters: Record<string, unknown>): string;

  /** 获取缓存统计信息 */
  getStats(): CacheStats;

  /** 设置缓存策略 */
  setStrategy(strategy: CacheStrategy): void;

  /** 手动清理过期项 */
  cleanup(): Promise<void>;
}

/**
 * 默认缓存键生成器
 */
const defaultKeyGenerator: CacheKeyGenerator = (
  toolId: string,
  parameters: Record<string, unknown>,
): string => {
  try {
    // 对参数进行排序以确保一致性
    const sortedParams = Object.keys(parameters)
      .toSorted()
      .reduce(
        (result, key) => {
          result[key] = parameters[key];
          return result;
        },
        {} as Record<string, unknown>,
      );

    // 创建参数的哈希值
    const paramsStr = JSON.stringify(sortedParams);
    const paramsHash = crypto.createHash('sha256').update(paramsStr).digest('hex').slice(0, 16);

    return `${toolId}:${paramsHash}`;
  } catch (error) {
    logger.error('生成缓存键时出错:', error instanceof Error ? error : new Error(String(error)));
    throw new ServiceError(
      ErrorCode.API_TO_MCP_INTERNAL,
      `无法生成缓存键: ${error instanceof Error ? error.message : '未知错误'}`,
      undefined,
      { cause: error instanceof Error ? error.message : String(error) },
    );
  }
};

/**
 * 内存缓存管理器实现
 */
export class CacheManagerImpl implements CacheManager {
  private cache = new Map<string, CacheEntry>();
  private stats: CacheStats = {
    totalRequests: 0,
    hits: 0,
    misses: 0,
    hitRate: 0,
    currentSize: 0,
    maxSize: 1000, // 默认最大1000个条目
  };
  private strategy?: CacheStrategy;
  private keyGenerator: CacheKeyGenerator = defaultKeyGenerator;
  private defaultTtl = 300; // 默认5分钟TTL
  private cleanupInterval?: NodeJS.Timeout;

  constructor(config?: CacheConfig) {
    if (config) {
      this.defaultTtl = config.ttl;
      if (config.maxSize) {
        this.stats.maxSize = config.maxSize;
      }
      if (config.keyGenerator) {
        this.keyGenerator = config.keyGenerator;
      }
    }

    // 启动定期清理过期项
    this.startCleanupTimer();
  }

  /**
   * 获取缓存值
   */
  async get(key: string): Promise<unknown | null> {
    this.stats.totalRequests++;

    const entry = this.cache.get(key);

    if (!entry) {
      this.stats.misses++;
      this.updateHitRate();
      return null;
    }

    // 检查是否过期
    if (this.isExpired(entry)) {
      this.cache.delete(key);
      this.stats.currentSize = this.cache.size;
      this.stats.misses++;
      this.updateHitRate();
      return null;
    }

    // 更新访问信息
    entry.accessCount++;
    entry.lastAccessedAt = new Date();

    this.stats.hits++;
    this.updateHitRate();

    logger.debug(`缓存命中: ${key}`);
    return entry.value;
  }

  /**
   * 设置缓存值
   */
  async set(key: string, value: unknown, ttl?: number): Promise<void> {
    const effectiveTtl = ttl ?? this.defaultTtl;
    const now = new Date();
    const expiresAt = new Date(now.getTime() + effectiveTtl * 1000);

    // 检查是否应该缓存
    if (this.strategy && !this.strategy.shouldCache(key, value)) {
      logger.debug(`策略拒绝缓存: ${key}`);
      return;
    }

    // 如果使用策略，获取策略的TTL
    const strategyTtl = this.strategy?.getTtl(key, value);
    if (strategyTtl !== undefined) {
      expiresAt.setTime(now.getTime() + strategyTtl * 1000);
    }

    const entry: CacheEntry = {
      key,
      value,
      createdAt: now,
      expiresAt,
      accessCount: 0,
      lastAccessedAt: now,
    };

    // 检查缓存大小限制
    if (this.cache.size >= this.stats.maxSize && !this.cache.has(key)) {
      await this.evictLeastRecentlyUsed();
    }

    this.cache.set(key, entry);
    this.stats.currentSize = this.cache.size;

    logger.debug(`缓存设置: ${key}, TTL: ${effectiveTtl}秒`);
  }

  /**
   * 删除缓存项
   */
  async delete(key: string): Promise<void> {
    const deleted = this.cache.delete(key);
    if (deleted) {
      this.stats.currentSize = this.cache.size;
      logger.debug(`缓存删除: ${key}`);
    }
  }

  /**
   * 清空所有缓存
   */
  async clear(): Promise<void> {
    this.cache.clear();
    this.stats.currentSize = 0;
    this.stats.totalRequests = 0;
    this.stats.hits = 0;
    this.stats.misses = 0;
    this.stats.hitRate = 0;
    logger.debug('缓存已清空');
  }

  /**
   * 生成缓存键
   */
  generateCacheKey(toolId: string, parameters: Record<string, unknown>): string {
    return this.keyGenerator(toolId, parameters);
  }

  /**
   * 获取缓存统计信息
   */
  getStats(): CacheStats {
    return { ...this.stats };
  }

  /**
   * 设置缓存策略
   */
  setStrategy(strategy: CacheStrategy): void {
    this.strategy = strategy;
    logger.debug(`缓存策略已设置: ${strategy.name}`);
  }

  /**
   * 手动清理过期项
   */
  async cleanup(): Promise<void> {
    const now = new Date();
    const expiredKeys: string[] = [];

    for (const [key, entry] of this.cache.entries()) {
      if (entry.expiresAt <= now) {
        expiredKeys.push(key);
      }
    }

    for (const key of expiredKeys) {
      this.cache.delete(key);
    }

    this.stats.currentSize = this.cache.size;

    if (expiredKeys.length > 0) {
      logger.debug(`清理了 ${expiredKeys.length} 个过期缓存项`);
    }
  }

  /**
   * 检查缓存项是否过期
   */
  private isExpired(entry: CacheEntry): boolean {
    return entry.expiresAt <= new Date();
  }

  /**
   * 更新命中率
   */
  private updateHitRate(): void {
    if (this.stats.totalRequests > 0) {
      this.stats.hitRate = this.stats.hits / this.stats.totalRequests;
    }
  }

  /**
   * 驱逐最近最少使用的项
   */
  private async evictLeastRecentlyUsed(): Promise<void> {
    let lruKey: string | null = null;
    let lruTime = Number.POSITIVE_INFINITY;

    for (const [key, entry] of this.cache.entries()) {
      const accessedAt = entry.lastAccessedAt.getTime();
      if (accessedAt < lruTime) {
        lruTime = accessedAt;
        lruKey = key;
      }
    }

    if (lruKey !== null) {
      this.cache.delete(lruKey);
      this.stats.currentSize = this.cache.size;
      logger.debug(`驱逐LRU缓存项: ${lruKey}`);
    }
  }

  /**
   * 启动清理定时器
   */
  private startCleanupTimer(): void {
    // 每分钟清理一次过期项
    this.cleanupInterval = setInterval(() => {
      this.cleanup().catch((error) => {
        logger.error('定期清理缓存时出错:', error);
      });
    }, 60000);
    this.cleanupInterval.unref?.();
  }

  /**
   * 停止清理定时器
   */
  destroy(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = undefined;
    }
  }
}

/**
 * Redis缓存管理器实现（可选）
 * 注意：这是一个基础实现，实际使用时需要安装redis客户端
 */
export class RedisCacheManager implements CacheManager {
  private stats: CacheStats = {
    totalRequests: 0,
    hits: 0,
    misses: 0,
    hitRate: 0,
    currentSize: 0,
    maxSize: -1, // Redis没有固定的大小限制
  };
  private keyGenerator: CacheKeyGenerator = defaultKeyGenerator;
  private defaultTtl = 300;
  private strategy?: CacheStrategy;

  constructor(config?: CacheConfig & { redisUrl?: string }) {
    if (config) {
      this.defaultTtl = config.ttl;
      if (config.keyGenerator) {
        this.keyGenerator = config.keyGenerator;
      }
    }

    // 注意：实际实现需要初始化Redis客户端
    logger.warn('RedisCacheManager 是一个占位符实现，需要实际的Redis客户端');
  }

  async get(_key: string): Promise<unknown | null> {
    this.stats.totalRequests++;

    // TODO: 实现Redis GET操作
    // const value = await this.redisClient.get(key);

    this.stats.misses++;
    this.updateHitRate();
    return null;
  }

  async set(key: string, _value: unknown, ttl?: number): Promise<void> {
    const effectiveTtl = ttl ?? this.defaultTtl;

    // TODO: 实现Redis SET操作
    // await this.redisClient.setex(key, effectiveTtl, JSON.stringify(value));

    logger.debug(`Redis缓存设置: ${key}, TTL: ${effectiveTtl}秒`);
  }

  async delete(key: string): Promise<void> {
    // TODO: 实现Redis DEL操作
    // await this.redisClient.del(key);

    logger.debug(`Redis缓存删除: ${key}`);
  }

  async clear(): Promise<void> {
    // TODO: 实现Redis FLUSHDB操作
    // await this.redisClient.flushdb();

    this.stats.totalRequests = 0;
    this.stats.hits = 0;
    this.stats.misses = 0;
    this.stats.hitRate = 0;
    logger.debug('Redis缓存已清空');
  }

  generateCacheKey(toolId: string, parameters: Record<string, unknown>): string {
    return this.keyGenerator(toolId, parameters);
  }

  getStats(): CacheStats {
    return { ...this.stats };
  }

  setStrategy(strategy: CacheStrategy): void {
    this.strategy = strategy;
    logger.debug(`Redis缓存策略已设置: ${strategy.name}`);
  }

  async cleanup(): Promise<void> {
    // Redis会自动处理TTL过期，不需要手动清理
    logger.debug('Redis自动处理过期项，无需手动清理');
  }

  private updateHitRate(): void {
    if (this.stats.totalRequests > 0) {
      this.stats.hitRate = this.stats.hits / this.stats.totalRequests;
    }
  }
}

/**
 * 多级缓存管理器
 * 结合内存缓存和Redis缓存
 */
export class MultiLevelCacheManager implements CacheManager {
  private l1Cache: CacheManager; // 内存缓存
  private l2Cache?: CacheManager; // Redis缓存（可选）
  private keyGenerator: CacheKeyGenerator = defaultKeyGenerator;

  constructor(l1Config?: CacheConfig, l2Config?: CacheConfig & { redisUrl?: string }) {
    this.l1Cache = new CacheManagerImpl(l1Config);

    if (l2Config) {
      this.l2Cache = new RedisCacheManager(l2Config);
    }

    if (l1Config?.keyGenerator) {
      this.keyGenerator = l1Config.keyGenerator;
    }
  }

  async get(key: string): Promise<unknown | null> {
    // 先尝试L1缓存
    let value = await this.l1Cache.get(key);

    if (value !== null) {
      return value;
    }

    // 如果L1缓存未命中，尝试L2缓存
    if (this.l2Cache) {
      value = await this.l2Cache.get(key);

      if (value !== null) {
        // 将L2缓存的值写入L1缓存
        await this.l1Cache.set(key, value);
        return value;
      }
    }

    return null;
  }

  async set(key: string, value: unknown, ttl?: number): Promise<void> {
    // 同时写入L1和L2缓存
    await this.l1Cache.set(key, value, ttl);

    if (this.l2Cache) {
      await this.l2Cache.set(key, value, ttl);
    }
  }

  async delete(key: string): Promise<void> {
    await this.l1Cache.delete(key);

    if (this.l2Cache) {
      await this.l2Cache.delete(key);
    }
  }

  async clear(): Promise<void> {
    await this.l1Cache.clear();

    if (this.l2Cache) {
      await this.l2Cache.clear();
    }
  }

  generateCacheKey(toolId: string, parameters: Record<string, unknown>): string {
    return this.keyGenerator(toolId, parameters);
  }

  getStats(): CacheStats {
    const l1Stats = this.l1Cache.getStats();
    const l2Stats = this.l2Cache?.getStats();

    if (!l2Stats) {
      return l1Stats;
    }

    // 合并统计信息
    return {
      totalRequests: l1Stats.totalRequests + l2Stats.totalRequests,
      hits: l1Stats.hits + l2Stats.hits,
      misses: l1Stats.misses + l2Stats.misses,
      hitRate: (l1Stats.hits + l2Stats.hits) / (l1Stats.totalRequests + l2Stats.totalRequests) || 0,
      currentSize: l1Stats.currentSize + l2Stats.currentSize,
      maxSize: l1Stats.maxSize + l2Stats.maxSize,
    };
  }

  setStrategy(strategy: CacheStrategy): void {
    this.l1Cache.setStrategy(strategy);

    if (this.l2Cache) {
      this.l2Cache.setStrategy(strategy);
    }
  }

  async cleanup(): Promise<void> {
    await this.l1Cache.cleanup();

    if (this.l2Cache) {
      await this.l2Cache.cleanup();
    }
  }
}

/**
 * 创建缓存管理器的工厂函数
 */
export function createCacheManager(
  config?: CacheConfig & {
    type?: 'memory' | 'redis' | 'multi';
    redisUrl?: string;
  },
): CacheManager {
  const type = config?.type || 'memory';

  switch (type) {
    case 'memory':
      return new CacheManagerImpl(config);

    case 'redis':
      return new RedisCacheManager(config);

    case 'multi':
      return new MultiLevelCacheManager(config, config);

    default:
      throw new ServiceError(ErrorCode.API_TO_MCP_INTERNAL, `不支持的缓存类型: ${type}`);
  }
}
