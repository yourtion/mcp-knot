/**
 * 频率限制器测试
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { logger } from '../../../utils/logger.js';
import { RateLimiterImpl } from './rate-limiter.js';

import type { RateLimitConfig } from '../../types/api-config.js';
import type { SecurityEvent } from '../../types/security.js';

// Mock日志记录器
vi.mock('../../../utils/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

const loggerMock = vi.mocked(logger);

describe('RateLimiterImpl', () => {
  let rateLimiter: RateLimiterImpl;
  let securityEvents: SecurityEvent[];

  beforeEach(() => {
    securityEvents = [];
    rateLimiter = new RateLimiterImpl();
    rateLimiter.setSecurityEventCallback((event) => {
      securityEvents.push(event);
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  describe('基本频率限制', () => {
    it('应该允许在限制范围内的请求', async () => {
      // 使用自定义配置
      const config: RateLimitConfig = {
        windowSeconds: 60,
        maxRequests: 10,
        enabled: true,
      };
      const rateLimiterWithConfig = new RateLimiterImpl(config);

      // 前10个请求应该被允许
      for (let i = 0; i < 10; i++) {
        const allowed = await rateLimiterWithConfig.checkLimit('test-tool');
        expect(allowed).toBe(true);
        await rateLimiterWithConfig.recordCall('test-tool');
      }
    });

    it('应该拒绝超出限制的请求', async () => {
      const config: RateLimitConfig = {
        windowSeconds: 60,
        maxRequests: 5,
        enabled: true,
      };
      const rateLimiterWithConfig = new RateLimiterImpl(config);
      const events: SecurityEvent[] = [];
      rateLimiterWithConfig.setSecurityEventCallback((event) => {
        events.push(event);
      });

      // 前5个请求应该被允许
      for (let i = 0; i < 5; i++) {
        expect(await rateLimiterWithConfig.checkLimit('test-tool')).toBe(true);
        await rateLimiterWithConfig.recordCall('test-tool');
      }

      // 第6个请求应该被拒绝
      expect(await rateLimiterWithConfig.checkLimit('test-tool')).toBe(false);

      // 应该触发安全事件
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('RATE_LIMIT_EXCEEDED');
    });

    it('应该在时间窗口重置后允许新请求', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });

      const config: RateLimitConfig = {
        windowSeconds: 0.1,
        maxRequests: 2,
        enabled: true,
      };
      const rateLimiterWithConfig = new RateLimiterImpl(config);

      // 使用完配额
      expect(await rateLimiterWithConfig.checkLimit('test-tool')).toBe(true);
      await rateLimiterWithConfig.recordCall('test-tool');
      expect(await rateLimiterWithConfig.checkLimit('test-tool')).toBe(true);
      await rateLimiterWithConfig.recordCall('test-tool');

      // 应该被拒绝
      expect(await rateLimiterWithConfig.checkLimit('test-tool')).toBe(false);

      // 等待时间窗口重置
      await vi.advanceTimersByTimeAsync(150);

      // 现在应该被允许
      expect(await rateLimiterWithConfig.checkLimit('test-tool')).toBe(true);

      vi.useRealTimers();
    });

    it('应该在禁用时允许所有请求', async () => {
      const config: RateLimitConfig = {
        windowSeconds: 60,
        maxRequests: 1,
        enabled: false,
      };
      const rateLimiterWithConfig = new RateLimiterImpl(config);

      // 即使超过限制也应该被允许
      for (let i = 0; i < 10; i++) {
        expect(await rateLimiterWithConfig.checkLimit('test-tool')).toBe(true);
        await rateLimiterWithConfig.recordCall('test-tool');
      }
    });
  });

  describe('客户端特定限制', () => {
    it('应该为不同客户端分别计算限制', async () => {
      const config: RateLimitConfig = {
        windowSeconds: 60,
        maxRequests: 2,
        enabled: true,
      };
      const rateLimiterWithConfig = new RateLimiterImpl(config);

      // 客户端A使用配额
      expect(await rateLimiterWithConfig.checkLimit('test-tool', 'client-a')).toBe(true);
      await rateLimiterWithConfig.recordCall('test-tool', 'client-a');
      expect(await rateLimiterWithConfig.checkLimit('test-tool', 'client-a')).toBe(true);
      await rateLimiterWithConfig.recordCall('test-tool', 'client-a');

      // 客户端A应该被限制
      expect(await rateLimiterWithConfig.checkLimit('test-tool', 'client-a')).toBe(false);

      // 但客户端B应该仍然被允许
      expect(await rateLimiterWithConfig.checkLimit('test-tool', 'client-b')).toBe(true);
      await rateLimiterWithConfig.recordCall('test-tool', 'client-b');
    });

    it('应该支持工具特定的限制配置', async () => {
      const config: RateLimitConfig = {
        windowSeconds: 60,
        maxRequests: 10,
        enabled: true,
        toolSpecific: {
          'restricted-tool': {
            windowSeconds: 60,
            maxRequests: 2,
          },
        },
      };
      const rateLimiterWithConfig = new RateLimiterImpl(config);

      // 普通工具应该有10个请求的限制
      for (let i = 0; i < 10; i++) {
        expect(await rateLimiterWithConfig.checkLimit('normal-tool')).toBe(true);
        await rateLimiterWithConfig.recordCall('normal-tool');
      }

      // 受限工具应该只有2个请求的限制
      expect(await rateLimiterWithConfig.checkLimit('restricted-tool')).toBe(true);
      await rateLimiterWithConfig.recordCall('restricted-tool');
      expect(await rateLimiterWithConfig.checkLimit('restricted-tool')).toBe(true);
      await rateLimiterWithConfig.recordCall('restricted-tool');
      expect(await rateLimiterWithConfig.checkLimit('restricted-tool')).toBe(false);
    });
  });

  describe('基本功能测试', () => {
    it('应该获取剩余请求次数', async () => {
      const config: RateLimitConfig = {
        windowSeconds: 60,
        maxRequests: 5,
        enabled: true,
      };
      const rateLimiterWithConfig = new RateLimiterImpl(config);

      // 初始状态应该有5个剩余请求
      expect(await rateLimiterWithConfig.getRemainingRequests('test-tool')).toBe(5);

      // 使用2个请求
      await rateLimiterWithConfig.recordCall('test-tool');
      await rateLimiterWithConfig.recordCall('test-tool');

      // 应该剩余3个请求
      expect(await rateLimiterWithConfig.getRemainingRequests('test-tool')).toBe(3);
    });

    it('应该重置计数器', async () => {
      const config: RateLimitConfig = {
        windowSeconds: 60,
        maxRequests: 5,
        enabled: true,
      };
      const rateLimiterWithConfig = new RateLimiterImpl(config);

      // 使用一些请求
      await rateLimiterWithConfig.recordCall('test-tool');
      await rateLimiterWithConfig.recordCall('test-tool');

      expect(await rateLimiterWithConfig.getRemainingRequests('test-tool')).toBe(3);

      // 重置计数器
      await rateLimiterWithConfig.resetCounter('test-tool');

      // 应该恢复到初始状态
      expect(await rateLimiterWithConfig.getRemainingRequests('test-tool')).toBe(5);
    });

    it('应该获取频率限制状态', async () => {
      const config: RateLimitConfig = {
        windowSeconds: 60,
        maxRequests: 5,
        enabled: true,
      };
      const rateLimiterWithConfig = new RateLimiterImpl(config);

      // 初始状态
      let status = await rateLimiterWithConfig.getStatus('test-tool');
      expect(status.limited).toBe(false);
      expect(status.remaining).toBe(5);

      // 使用完配额
      for (let i = 0; i < 5; i++) {
        await rateLimiterWithConfig.recordCall('test-tool');
      }

      status = await rateLimiterWithConfig.getStatus('test-tool');
      expect(status.limited).toBe(true);
      expect(status.remaining).toBe(0);
    });
  });

  describe('异常检测', () => {
    it('应该检测连续违规行为', async () => {
      const config: RateLimitConfig = {
        windowSeconds: 60,
        maxRequests: 1,
        enabled: true,
      };
      const anomalyConfig = {
        violationThreshold: 3,
        detectionWindow: 300,
        enabled: true,
      };
      const rateLimiterWithConfig = new RateLimiterImpl(config, anomalyConfig);
      const events: SecurityEvent[] = [];
      rateLimiterWithConfig.setSecurityEventCallback((event) => {
        events.push(event);
      });

      // 使用配额
      await rateLimiterWithConfig.recordCall('test-tool');

      // 连续违规
      for (let i = 0; i < 4; i++) {
        await rateLimiterWithConfig.checkLimit('test-tool');
      }

      // 应该检测到异常活动
      const anomalies = await rateLimiterWithConfig.detectAnomalies('test-tool');
      expect(anomalies).toHaveLength(1);
      expect(anomalies[0].type).toBe('SUSPICIOUS_ACTIVITY');
      expect(anomalies[0].severity).toBe('high');
    });

    it('应该在禁用异常检测时不检测异常', async () => {
      const config: RateLimitConfig = {
        windowSeconds: 60,
        maxRequests: 1,
        enabled: true,
      };
      const anomalyConfig = {
        violationThreshold: 3,
        detectionWindow: 300,
        enabled: false,
      };
      const rateLimiterWithConfig = new RateLimiterImpl(config, anomalyConfig);

      // 使用配额
      await rateLimiterWithConfig.recordCall('test-tool');

      // 连续违规
      for (let i = 0; i < 5; i++) {
        await rateLimiterWithConfig.checkLimit('test-tool');
      }

      // 不应该检测到异常
      const anomalies = await rateLimiterWithConfig.detectAnomalies('test-tool');
      expect(anomalies).toHaveLength(0);
    });

    it('无调用记录的工具 → 无异常事件', async () => {
      const anomalies = await rateLimiter.detectAnomalies('never-called-tool');

      expect(anomalies).toEqual([]);
    });

    it('默认配置（未显式传 enabled）仍然启用限流与异常检测', async () => {
      const limiter = new RateLimiterImpl({ maxRequests: 2, windowSeconds: 60 });
      const events: SecurityEvent[] = [];
      limiter.setSecurityEventCallback((event) => events.push(event));

      // 限流生效
      await limiter.recordCall('t');
      await limiter.recordCall('t');
      expect(await limiter.checkLimit('t')).toBe(false);

      // 默认 anomalyConfig.violationThreshold = 5
      for (let i = 0; i < 5; i++) {
        await limiter.checkLimit('t');
      }
      expect(await limiter.detectAnomalies('t')).toHaveLength(1);
    });
  });

  describe('窗口与时间边界（fake timers）', () => {
    const T0 = new Date('2026-01-01T00:00:00Z').getTime();

    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(T0);
    });

    it('窗口内（未过期）recordCall 持续累加，不重置计数', async () => {
      const limiter = new RateLimiterImpl({ windowSeconds: 60, maxRequests: 5 });

      await limiter.recordCall('t');
      await limiter.recordCall('t');
      await limiter.recordCall('t');
      vi.setSystemTime(T0 + 1_000); // 1 秒后仍在窗口内
      await limiter.recordCall('t');

      expect(await limiter.getRemainingRequests('t')).toBe(1);
    });

    it('窗口恰好过期（60s 整）时 recordCall 不重置；超出后才重置', async () => {
      const limiter = new RateLimiterImpl({ windowSeconds: 60, maxRequests: 5 });

      await limiter.recordCall('t');
      await limiter.recordCall('t');
      await limiter.recordCall('t');

      // 恰好 60 秒：record.windowStart === 窗口起点，不算过期
      vi.setSystemTime(T0 + 60_000);
      await limiter.recordCall('t');
      expect(await limiter.getRemainingRequests('t')).toBe(1);

      // 超过 60 秒：重置后从 1 开始计数
      vi.setSystemTime(T0 + 121_000);
      await limiter.recordCall('t');
      expect(await limiter.getRemainingRequests('t')).toBe(4);
    });

    it('窗口内配额耗尽 → checkLimit 仍拒绝；恰 60 秒仍未重置', async () => {
      const limiter = new RateLimiterImpl({ windowSeconds: 60, maxRequests: 3 });

      for (let i = 0; i < 3; i++) {
        await limiter.recordCall('t');
      }

      vi.setSystemTime(T0 + 1_000);
      expect(await limiter.checkLimit('t')).toBe(false);

      vi.setSystemTime(T0 + 60_000);
      expect(await limiter.checkLimit('t')).toBe(false);

      vi.setSystemTime(T0 + 60_001);
      expect(await limiter.checkLimit('t')).toBe(true);
    });

    it('getRemainingRequests：窗口内递减，恰 60 秒不重置，过期后回满', async () => {
      const limiter = new RateLimiterImpl({ windowSeconds: 60, maxRequests: 5 });

      for (let i = 0; i < 3; i++) {
        await limiter.recordCall('t');
      }

      vi.setSystemTime(T0 + 1_000);
      expect(await limiter.getRemainingRequests('t')).toBe(2);

      vi.setSystemTime(T0 + 60_000);
      expect(await limiter.getRemainingRequests('t')).toBe(2);

      vi.setSystemTime(T0 + 60_100);
      expect(await limiter.getRemainingRequests('t')).toBe(5);
    });

    it('禁用限流时 getRemainingRequests 返回 MAX_SAFE_INTEGER', async () => {
      const limiter = new RateLimiterImpl({ windowSeconds: 60, maxRequests: 1, enabled: false });

      await limiter.recordCall('t');

      expect(await limiter.getRemainingRequests('t')).toBe(Number.MAX_SAFE_INTEGER);
    });

    it('禁用限流时即使已有超限记录，checkLimit 仍放行', async () => {
      const limiter = new RateLimiterImpl({ windowSeconds: 60, maxRequests: 1, enabled: false });

      // 注入启用期间遗留的超限记录（records 为私有字段）
      const now = new Date();
      (
        limiter as unknown as {
          records: Map<
            string,
            { count: number; windowStart: Date; lastRequest: Date; violationCount: number }
          >;
        }
      ).records.set('t', {
        count: 5,
        windowStart: now,
        lastRequest: now,
        violationCount: 0,
      });

      expect(await limiter.checkLimit('t')).toBe(true);
    });
  });

  describe('getStatus 时间语义（fake timers）', () => {
    const T0 = new Date('2026-01-01T00:00:00Z').getTime();

    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(T0);
    });

    it('无记录 → resetTime/windowStart 按当前时间 + 窗口推算', async () => {
      const limiter = new RateLimiterImpl({ windowSeconds: 60, maxRequests: 5 });

      const status = await limiter.getStatus('t');

      expect(status.limited).toBe(false);
      expect(status.remaining).toBe(5);
      expect(status.windowStart.getTime()).toBe(T0);
      expect(status.resetTime.getTime()).toBe(T0 + 60_000);
    });

    it('部分使用配额 → limited=false、remaining 精确递减、resetTime 基于窗口起点', async () => {
      const limiter = new RateLimiterImpl({ windowSeconds: 60, maxRequests: 5 });

      for (let i = 0; i < 3; i++) {
        await limiter.recordCall('t');
      }
      vi.setSystemTime(T0 + 1_000);

      const status = await limiter.getStatus('t');

      expect(status.limited).toBe(false);
      expect(status.remaining).toBe(2);
      expect(status.resetTime.getTime()).toBe(T0 + 60_000);
      expect(status.windowStart.getTime()).toBe(T0);
    });

    it('配额耗尽但窗口已过期 → limited=false 且 remaining 回满、windowStart 更新为当前', async () => {
      const limiter = new RateLimiterImpl({ windowSeconds: 60, maxRequests: 2 });

      for (let i = 0; i < 2; i++) {
        await limiter.recordCall('t');
      }
      vi.setSystemTime(T0 + 61_000);

      const status = await limiter.getStatus('t');

      expect(status.limited).toBe(false);
      expect(status.remaining).toBe(2);
      expect(status.windowStart.getTime()).toBe(T0 + 61_000);
    });
  });

  describe('违规事件细节（fake timers）', () => {
    const T0 = new Date('2026-01-01T00:00:00Z').getTime();

    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(T0);
    });

    it('首次违规 → severity=medium，details 携带计数明细，记录 warn 日志', async () => {
      const limiter = new RateLimiterImpl(
        { windowSeconds: 60, maxRequests: 1 },
        { violationThreshold: 3 },
      );
      const events: SecurityEvent[] = [];
      limiter.setSecurityEventCallback((event) => events.push(event));

      await limiter.recordCall('t');
      await limiter.checkLimit('t'); // 违规 1 次

      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('RATE_LIMIT_EXCEEDED');
      expect(events[0].severity).toBe('medium');
      expect(events[0].details).toEqual({
        currentCount: 1,
        maxRequests: 1,
        violationCount: 1,
      });
      expect(events[0].timestamp.getTime()).toBe(T0);
      expect(loggerMock.warn).toHaveBeenCalledWith('频率限制违规');
    });

    it('violationCount 超过阈值 → severity=high', async () => {
      const limiter = new RateLimiterImpl(
        { windowSeconds: 60, maxRequests: 1 },
        { violationThreshold: 2 },
      );
      const events: SecurityEvent[] = [];
      limiter.setSecurityEventCallback((event) => events.push(event));

      await limiter.recordCall('t');
      await limiter.checkLimit('t'); // violation 1 → medium
      await limiter.checkLimit('t'); // violation 2 → 达到阈值
      await limiter.checkLimit('t'); // violation 3 → 超过阈值 → high

      expect(events[0].severity).toBe('medium');
      expect(events[2].severity).toBe('high');
    });

    it('达到阈值当次违规 → 同步回调 SUSPICIOUS_ACTIVITY 异常事件', async () => {
      const limiter = new RateLimiterImpl(
        { windowSeconds: 60, maxRequests: 1 },
        { violationThreshold: 3 },
      );
      const events: SecurityEvent[] = [];
      limiter.setSecurityEventCallback((event) => events.push(event));

      await limiter.recordCall('t');
      for (let i = 0; i < 3; i++) {
        await limiter.checkLimit('t');
      }

      const types = events.map((e) => e.type);
      expect(types).toContain('SUSPICIOUS_ACTIVITY');
      const anomaly = events.find((e) => e.type === 'SUSPICIOUS_ACTIVITY');
      expect(anomaly?.severity).toBe('high');
      expect(anomaly?.details).toMatchObject({
        violationCount: 3,
        reason: '连续违反频率限制',
      });
    });

    it('detectAnomalies：violationCount 恰好等于阈值 → 产生事件', async () => {
      const limiter = new RateLimiterImpl(
        { windowSeconds: 60, maxRequests: 1 },
        { violationThreshold: 3 },
      );

      await limiter.recordCall('t');
      for (let i = 0; i < 3; i++) {
        await limiter.checkLimit('t');
      }

      const anomalies = await limiter.detectAnomalies('t');
      expect(anomalies).toHaveLength(1);
      expect(anomalies[0].details).toMatchObject({
        violationCount: 3,
        reason: '连续违反频率限制',
      });
    });

    it('最后一次违规在检测窗口（300s）内 → 有事件；恰好过期 → 无事件', async () => {
      const limiter = new RateLimiterImpl(
        { windowSeconds: 60, maxRequests: 1 },
        { violationThreshold: 1, detectionWindow: 300 },
      );

      await limiter.recordCall('t');
      await limiter.checkLimit('t'); // violation 1（达到阈值 1）

      vi.setSystemTime(T0 + 200_000); // 窗口内
      expect(await limiter.detectAnomalies('t')).toHaveLength(1);

      vi.setSystemTime(T0 + 300_000); // 恰好到期
      expect(await limiter.detectAnomalies('t')).toHaveLength(0);
    });

    it('recordCall 记录 debug 日志', async () => {
      const limiter = new RateLimiterImpl({ windowSeconds: 60, maxRequests: 5 });

      await limiter.recordCall('t');

      expect(loggerMock.debug).toHaveBeenCalledWith('记录API调用');
    });
  });
});
