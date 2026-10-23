/**
 * 安全日志记录器测试
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { logger } from '../../../utils/logger.js';
import { type SecurityEvent, SecurityEventType } from '../../types/security.js';
import { SecurityLoggerImpl } from './security-logger.js';

// Mock日志记录器
vi.mock('../../../utils/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

interface StoredApiCallLog {
  toolId: string;
  timestamp: Date;
  parameters: Record<string, unknown>;
  response?: unknown;
  success: boolean;
  error?: string;
}

/** 读取私有日志存储，用于断言脱敏结果 */
const storedLogs = (instance: SecurityLoggerImpl): StoredApiCallLog[] =>
  (instance as unknown as { apiCallLogs: StoredApiCallLog[] }).apiCallLogs;

/** 读取私有事件存储，用于断言事件内容 */
const storedEvents = (instance: SecurityLoggerImpl): SecurityEvent[] =>
  (instance as unknown as { securityEvents: SecurityEvent[] }).securityEvents;

describe('SecurityLoggerImpl', () => {
  let securityLogger: SecurityLoggerImpl;
  let alerts: Array<{
    type: string;
    level: string;
    message: string;
    data: Record<string, unknown>;
    timestamp: Date;
  }>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
    alerts = [];
    securityLogger = new SecurityLoggerImpl();
    securityLogger.setAlertCallback((alert) => {
      alerts.push(alert);
    });
  });

  afterEach(() => {
    securityLogger.dispose();
    vi.useRealTimers();
  });

  describe('API调用日志记录', () => {
    it('应该记录成功的API调用并输出 info 日志', async () => {
      const timestamp = new Date();
      securityLogger.logApiCall({
        toolId: 'test-tool',
        clientId: 'client-123',
        timestamp,
        parameters: { query: 'test' },
        response: { result: 'success' },
        duration: 150,
        success: true,
      });

      const logs = storedLogs(securityLogger);
      expect(logs).toHaveLength(1);
      expect(logs[0]).toMatchObject({
        toolId: 'test-tool',
        clientId: 'client-123',
        duration: 150,
        success: true,
        parameters: { query: 'test' },
        response: { result: 'success' },
      });
      expect(logs[0].timestamp).toBe(timestamp);
      expect(vi.mocked(logger.info)).toHaveBeenCalledWith('API调用成功');
      expect(vi.mocked(logger.warn)).not.toHaveBeenCalled();

      const stats = await securityLogger.getSecurityStats(3600);
      expect(stats.totalRequests).toBe(1);
      expect(stats.successfulRequests).toBe(1);
      expect(stats.failedRequests).toBe(0);
    });

    it('应该记录失败的API调用并输出 warn 日志', async () => {
      securityLogger.logApiCall({
        toolId: 'test-tool',
        timestamp: new Date(),
        parameters: { query: 'test' },
        duration: 50,
        success: false,
        error: 'API调用失败',
      });

      const logs = storedLogs(securityLogger);
      expect(logs).toHaveLength(1);
      expect(logs[0].success).toBe(false);
      expect(logs[0].error).toBe('API调用失败');
      expect(vi.mocked(logger.warn)).toHaveBeenCalledWith('API调用失败');

      const stats = await securityLogger.getSecurityStats(3600);
      expect(stats.totalRequests).toBe(1);
      expect(stats.successfulRequests).toBe(0);
      expect(stats.failedRequests).toBe(1);
    });
  });

  describe('敏感数据脱敏', () => {
    const maskResult = (parameters: Record<string, unknown>): Record<string, unknown> => {
      securityLogger.logApiCall({
        toolId: 'test-tool',
        timestamp: new Date(),
        parameters,
        success: true,
      });
      const logs = storedLogs(securityLogger);
      return logs[logs.length - 1].parameters;
    };

    it('长字符串敏感值应保留前后4位并掩码中间', () => {
      // 18 字符 > keepChars*2=8：保留前4后4，中间10位掩码
      expect(maskResult({ password: 'verysecretpassword' }).password).toBe('very**********word');
    });

    it('长度恰好为 keepChars*2 的敏感值应全部掩码', () => {
      expect(maskResult({ password: '12345678' }).password).toBe('********');
    });

    it('长度超过 keepChars*2 一位的敏感值只掩码中间一位', () => {
      // 9 字符：前4 + 1位掩码 + 后4
      expect(maskResult({ password: '123456789' }).password).toBe('1234*6789');
    });

    it('短敏感值应全部掩码且长度不变', () => {
      expect(maskResult({ token: 'abc' }).token).toBe('***');
    });

    it('非字符串敏感值应掩码为8个掩码字符', () => {
      expect(maskResult({ password: 12345678 }).password).toBe('********');
      expect(maskResult({ secret: { nested: true } }).secret).toBe('********');
      expect(maskResult({ apiKey: null }).apiKey).toBe('********');
    });

    it('字段名匹配应不区分大小写且支持部分匹配', () => {
      const result = maskResult({
        UserPassword: 'verysecretpassword',
        myTokenField: 'abcdefghijklmnop',
        myAPIKEY: 'abcdefghijklmnop',
      });
      expect(result.UserPassword).toBe('very**********word');
      expect(result.myTokenField).toBe('abcd********mnop');
      expect(result.myAPIKEY).toBe('abcd********mnop');
    });

    it('非敏感字段值应原样保留', () => {
      const result = maskResult({
        username: 'testuser',
        count: 42,
        active: true,
        list: [1, 2, 3],
      });
      expect(result).toEqual({
        username: 'testuser',
        count: 42,
        active: true,
        list: [1, 2, 3],
      });
    });

    it('嵌套对象中的敏感数据应被脱敏', () => {
      const result = maskResult({
        user: { username: 'testuser', password: 'secretpassword' },
        auth: { token: 'bearer-token-xyz' },
      });
      expect(result.user).toEqual({ username: 'testuser', password: 'secr******word' });
      expect(result.auth).toEqual({ token: 'bear********-xyz' });
    });

    it('数组中每个元素的敏感字段都应被脱敏', () => {
      const result = maskResult({
        credentials: [
          { username: 'user1', password: 'password-one' },
          { username: 'user2', password: 'password-two' },
        ],
      });
      const credentials = result.credentials as Array<Record<string, unknown>>;
      expect(credentials).toHaveLength(2);
      expect(credentials[0]).toEqual({ username: 'user1', password: 'pass****-one' });
      expect(credentials[1]).toEqual({ username: 'user2', password: 'pass****-two' });
    });

    it('response 数据同样应被脱敏', () => {
      securityLogger.logApiCall({
        toolId: 'test-tool',
        timestamp: new Date(),
        parameters: {},
        response: { data: { apiKey: 'abcdefghijklmnop' } },
        success: true,
      });

      expect(storedLogs(securityLogger)[0].response).toEqual({
        data: { apiKey: 'abcd********mnop' },
      });
    });

    it('response 为 undefined 时应保持 undefined', () => {
      securityLogger.logApiCall({
        toolId: 'test-tool',
        timestamp: new Date(),
        parameters: {},
        success: true,
      });

      expect(storedLogs(securityLogger)[0].response).toBeUndefined();
    });

    describe('字符串内敏感模式脱敏', () => {
      it('应该掩码 Bearer token 模式', () => {
        const result = maskResult({
          header: 'Bearer eyJabc123def456xyz',
        });
        expect(result.header).toBe('Bearer eyJa**********6xyz');
      });

      it('小写 bearer 同样应被匹配', () => {
        const result = maskResult({ header: 'bearer abcdefghijklmnop' });
        expect(result.header).toBe('bearer abcd********mnop');
      });

      it('应该掩码 api_key= / api-key: 模式', () => {
        expect(maskResult({ query: 'api_key=abcdefgh12345678' }).query).toBe(
          'api_key=abcd********5678',
        );
        expect(maskResult({ query: 'apikey: abcdefgh12345678' }).query).toBe(
          'apikey: abcd********5678',
        );
      });

      it('应该掩码 token: 模式', () => {
        expect(maskResult({ text: 'token abcdefghijklmnop' }).text).toBe('token abcd********mnop');
      });

      it('无敏感模式的字符串应原样保留', () => {
        const text = '这是一段普通文本 without secrets';
        expect(maskResult({ text }).text).toBe(text);
      });
    });
  });

  describe('自定义脱敏配置', () => {
    it('应该使用自定义敏感字段、掩码字符与保留位数', () => {
      const customLogger = new SecurityLoggerImpl({
        sensitiveFields: ['customSecret', 'privateKey'],
        maskChar: '#',
        keepChars: 2,
      });

      customLogger.logApiCall({
        toolId: 'test-tool',
        timestamp: new Date(),
        parameters: {
          customSecret: 'mysecretvalue',
          publicKey: 'not-sensitive',
          password: 'should-not-mask',
        },
        success: true,
      });

      // 自定义配置完全覆盖默认敏感字段：password 不再脱敏
      expect(storedLogs(customLogger)[0].parameters).toEqual({
        customSecret: 'my#########ue',
        publicKey: 'not-sensitive',
        password: 'should-not-mask',
      });
      customLogger.dispose();
    });
  });

  describe('安全事件记录', () => {
    it('logAuthFailure 应记录包含错误详情的 medium 事件', async () => {
      const error = new Error('认证失败');

      securityLogger.logAuthFailure('test-tool', 'client-123', error, '192.168.1.1');

      const events = storedEvents(securityLogger);
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe(SecurityEventType.AUTH_FAILURE);
      expect(events[0].toolId).toBe('test-tool');
      expect(events[0].clientId).toBe('client-123');
      expect(events[0].severity).toBe('medium');
      expect(events[0].timestamp).toBeInstanceOf(Date);
      const details = events[0].details as Record<string, unknown>;
      expect(details.clientIp).toBe('192.168.1.1');
      const errorDetail = details.error as Record<string, unknown>;
      expect(errorDetail.name).toBe('Error');
      expect(errorDetail.message).toBe('认证失败');
      expect(errorDetail.stack).toBe(error.stack);

      expect(vi.mocked(logger.warn)).toHaveBeenCalledWith('安全事件');
      expect(vi.mocked(logger.warn)).toHaveBeenCalledWith('认证失败');

      const stats = await securityLogger.getSecurityStats(3600);
      expect(stats.authFailures).toBe(1);
    });

    it('logAccessDenied 应记录拒绝原因与IP的 medium 事件', async () => {
      securityLogger.logAccessDenied('test-tool', 'client-123', '域名不在白名单', '192.168.1.1');

      const events = storedEvents(securityLogger);
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe(SecurityEventType.ACCESS_DENIED);
      expect(events[0].severity).toBe('medium');
      expect(events[0].details).toEqual({
        reason: '域名不在白名单',
        clientIp: '192.168.1.1',
      });
      expect(vi.mocked(logger.warn)).toHaveBeenCalledWith('访问被拒绝');

      const stats = await securityLogger.getSecurityStats(3600);
      expect(stats.accessDenied).toBe(1);
    });

    it('critical 与 high 级别事件应输出 error 日志，其余输出 warn', () => {
      const buildEvent = (severity: SecurityEvent['severity']): SecurityEvent => ({
        type: SecurityEventType.SUSPICIOUS_ACTIVITY,
        toolId: 'test-tool',
        timestamp: new Date(),
        details: {},
        severity,
      });

      vi.mocked(logger.error).mockClear();
      securityLogger.logSecurityEvent(buildEvent('critical'));
      securityLogger.logSecurityEvent(buildEvent('high'));
      expect(vi.mocked(logger.error)).toHaveBeenCalledTimes(2);
      expect(vi.mocked(logger.warn)).not.toHaveBeenCalledWith('安全事件');

      vi.mocked(logger.error).mockClear();
      securityLogger.logSecurityEvent(buildEvent('medium'));
      securityLogger.logSecurityEvent(buildEvent('low'));
      expect(vi.mocked(logger.error)).not.toHaveBeenCalled();
      expect(vi.mocked(logger.warn)).toHaveBeenCalledWith('安全事件');
    });

    it('安全事件详情中的敏感字段应被脱敏后存储', () => {
      securityLogger.logSecurityEvent({
        type: SecurityEventType.SUSPICIOUS_ACTIVITY,
        toolId: 'test-tool',
        timestamp: new Date(),
        details: {
          reason: '重放攻击',
          password: 'verysecretpassword',
        },
        severity: 'high',
      });

      expect(storedEvents(securityLogger)[0].details).toEqual({
        reason: '重放攻击',
        password: 'very**********word',
      });
    });

    it('alertingEnabled 关闭时不应触发任何告警', () => {
      const disabledLogger = new SecurityLoggerImpl(undefined, { alertingEnabled: false });
      const received: unknown[] = [];
      disabledLogger.setAlertCallback((alert) => {
        received.push(alert);
      });

      for (let i = 0; i < 6; i++) {
        disabledLogger.logAuthFailure('test-tool', 'client-123', new Error('认证失败'));
      }
      for (let i = 0; i < 20; i++) {
        disabledLogger.logApiCall({
          toolId: 'test-tool',
          timestamp: new Date(),
          parameters: {},
          success: false,
        });
      }

      expect(received).toHaveLength(0);
      disabledLogger.dispose();
    });

    it('未设置告警回调时记录调用不应抛出异常', () => {
      const noCallbackLogger = new SecurityLoggerImpl();
      expect(() => {
        noCallbackLogger.logApiCall({
          toolId: 'test-tool',
          timestamp: new Date(),
          parameters: {},
          success: false,
        });
      }).not.toThrow();
      expect(alerts).toHaveLength(0);
      noCallbackLogger.dispose();
    });
  });

  describe('安全统计', () => {
    it('无任何记录时统计应为零且错误率为0', async () => {
      const stats = await securityLogger.getSecurityStats(3600);

      expect(stats.totalRequests).toBe(0);
      expect(stats.successfulRequests).toBe(0);
      expect(stats.failedRequests).toBe(0);
      expect(stats.errorRate).toBe(0);
      expect(stats.authFailures).toBe(0);
      expect(stats.accessDenied).toBe(0);
      expect(stats.rateLimitExceeded).toBe(0);
      expect(stats.suspiciousActivities).toBe(0);
    });

    it('应该正确计算错误率与各事件计数', async () => {
      const now = new Date();

      securityLogger.logApiCall({
        toolId: 'test-tool',
        timestamp: now,
        parameters: {},
        success: true,
      });
      securityLogger.logApiCall({
        toolId: 'test-tool',
        timestamp: now,
        parameters: {},
        success: false,
        error: '测试错误',
      });
      securityLogger.logAuthFailure('test-tool', 'client-123', new Error('认证失败'));
      securityLogger.logSecurityEvent({
        type: SecurityEventType.RATE_LIMIT_EXCEEDED,
        toolId: 'test-tool',
        timestamp: now,
        details: {},
        severity: 'medium',
      });

      const stats = await securityLogger.getSecurityStats(3600);

      expect(stats.totalRequests).toBe(2);
      expect(stats.successfulRequests).toBe(1);
      expect(stats.failedRequests).toBe(1);
      expect(stats.errorRate).toBe(50);
      expect(stats.authFailures).toBe(1);
      expect(stats.rateLimitExceeded).toBe(1);
      expect(stats.suspiciousActivities).toBe(0);
    });

    it('应该只统计指定时间窗口内的数据', async () => {
      const now = new Date();
      const oldTime = new Date(now.getTime() - 2 * 60 * 60 * 1000); // 2小时前

      securityLogger.logApiCall({
        toolId: 'test-tool',
        timestamp: oldTime,
        parameters: {},
        success: true,
      });
      securityLogger.logApiCall({
        toolId: 'test-tool',
        timestamp: now,
        parameters: {},
        success: false,
      });
      securityLogger.logAuthFailure('test-tool', 'client-123', new Error('认证失败'));
      // 窗口外的安全事件
      securityLogger.logSecurityEvent({
        type: SecurityEventType.SUSPICIOUS_ACTIVITY,
        toolId: 'test-tool',
        timestamp: oldTime,
        details: {},
        severity: 'medium',
      });

      const stats = await securityLogger.getSecurityStats(3600);

      expect(stats.totalRequests).toBe(1);
      expect(stats.failedRequests).toBe(1);
      expect(stats.authFailures).toBe(1);
      expect(stats.suspiciousActivities).toBe(0);
    });

    it('时间窗口边界（恰好等于 startTime）的记录应被包含', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-01-01T12:00:00Z'));
      const boundary = new Date('2026-01-01T11:59:00Z'); // 恰好 60 秒前

      securityLogger.logApiCall({
        toolId: 'test-tool',
        timestamp: boundary,
        parameters: {},
        success: false,
      });

      const stats = await securityLogger.getSecurityStats(60);
      expect(stats.totalRequests).toBe(1);
    });

    it('timeRange 应精确反映 [now-window, now]', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-01-01T12:00:00Z'));

      const stats = await securityLogger.getSecurityStats(90);

      expect(stats.timeRange.start).toEqual(new Date('2026-01-01T11:58:30Z'));
      expect(stats.timeRange.end).toEqual(new Date('2026-01-01T12:00:00Z'));
    });
  });

  describe('高错误率告警', () => {
    const logCalls = (count: number, success: boolean, timestamp = new Date()) => {
      for (let i = 0; i < count; i++) {
        securityLogger.logApiCall({
          toolId: 'test-tool',
          timestamp,
          parameters: {},
          success,
        });
      }
    };

    it('错误率恰好达到阈值时应触发 warning 告警', () => {
      logCalls(5, false);
      logCalls(5, true); // 50% 错误率，恰好等于阈值 50%

      expect(alerts).toHaveLength(1);
      expect(alerts[0].type).toBe('HIGH_ERROR_RATE');
      expect(alerts[0].level).toBe('warning');
      expect(alerts[0].message).toBe('检测到高错误率: 50.00%');
      expect(alerts[0].data).toEqual({
        errorRate: 50,
        totalRequests: 10,
        failedRequests: 5,
        timeWindow: 300,
      });
    });

    it('错误率低于阈值时不应触发告警', () => {
      logCalls(4, false);
      logCalls(6, true); // 40% < 50%

      expect(alerts).toHaveLength(0);
    });

    it('请求总数未达到 minRequests 时不应触发告警', () => {
      logCalls(9, false); // 100% 错误率但只有 9 个请求 < 10

      expect(alerts).toHaveLength(0);

      logCalls(1, false); // 第 10 个请求后触发
      expect(alerts).toHaveLength(1);
      expect(alerts[0].data).toMatchObject({ totalRequests: 10, failedRequests: 10 });
    });

    it('错误率达到80%及以上时告警级别应为 critical', () => {
      logCalls(8, false);
      logCalls(2, true); // 80% 错误率

      expect(alerts).toHaveLength(1);
      expect(alerts[0].level).toBe('critical');
    });

    it('错误率低于80%时告警级别应为 warning', () => {
      logCalls(7, false);
      logCalls(3, true); // 70% 错误率

      expect(alerts).toHaveLength(1);
      expect(alerts[0].level).toBe('warning');
    });

    it('告警时间窗口之外的失败请求不应计入', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-01-01T12:00:00Z'));

      // 窗口外（6分钟前 > 300秒窗口）的失败请求
      logCalls(10, false, new Date('2026-01-01T11:54:00Z'));
      expect(alerts).toHaveLength(0);

      // 窗口内的成功请求不影响：10 个窗口外失败不计入告警
      logCalls(10, true, new Date('2026-01-01T11:59:30Z'));
      expect(alerts).toHaveLength(0);
    });

    it('关闭实时监控时不应触发高错误率告警', () => {
      const passiveLogger = new SecurityLoggerImpl(undefined, { realTimeMonitoring: false });
      const received: unknown[] = [];
      passiveLogger.setAlertCallback((alert) => {
        received.push(alert);
      });

      for (let i = 0; i < 10; i++) {
        passiveLogger.logApiCall({
          toolId: 'test-tool',
          timestamp: new Date(),
          parameters: {},
          success: false,
        });
      }

      expect(received).toHaveLength(0);
      passiveLogger.dispose();
    });
  });

  describe('多次认证失败告警', () => {
    it('同一客户端 5 分钟内失败达到 5 次应触发 critical 告警', () => {
      for (let i = 0; i < 4; i++) {
        securityLogger.logAuthFailure('test-tool', 'client-123', new Error('认证失败'));
      }
      expect(alerts).toHaveLength(0);

      securityLogger.logAuthFailure('test-tool', 'client-123', new Error('认证失败'));

      expect(alerts).toHaveLength(1);
      expect(alerts[0].type).toBe('MULTIPLE_AUTH_FAILURES');
      expect(alerts[0].level).toBe('critical');
      expect(alerts[0].message).toContain('client-123');
      expect(alerts[0].message).toContain('5次');
      expect(alerts[0].data).toEqual({
        clientId: 'client-123',
        failureCount: 5,
        toolId: 'test-tool',
      });
    });

    it('第 6 次失败应再次触发告警且计数为 6', () => {
      for (let i = 0; i < 6; i++) {
        securityLogger.logAuthFailure('test-tool', 'client-123', new Error('认证失败'));
      }

      const authAlerts = alerts.filter((a) => a.type === 'MULTIPLE_AUTH_FAILURES');
      expect(authAlerts).toHaveLength(2);
      expect(authAlerts[1].data).toEqual({
        clientId: 'client-123',
        failureCount: 6,
        toolId: 'test-tool',
      });
    });

    it('不同客户端的失败次数不应累计', () => {
      // 两个客户端各 4 次：合计 8 次超过阈值，但按客户端统计均未达 5 次
      for (let i = 0; i < 4; i++) {
        securityLogger.logAuthFailure('test-tool', 'client-a', new Error('认证失败'));
      }
      for (let i = 0; i < 4; i++) {
        securityLogger.logAuthFailure('test-tool', 'client-b', new Error('认证失败'));
      }

      expect(alerts).toHaveLength(0);
    });

    it('超过 5 分钟的失败记录不应计入', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-01-01T12:00:00Z'));

      securityLogger.logAuthFailure('test-tool', 'client-123', new Error('第一次'));
      // 推进 5 分 01 秒，第一条记录已超出 5 分钟窗口
      vi.advanceTimersByTime(5 * 60 * 1000 + 1000);
      for (let i = 0; i < 4; i++) {
        securityLogger.logAuthFailure('test-tool', 'client-123', new Error('后续'));
      }

      expect(alerts).toHaveLength(0);
    });

    it('恰好 5 分钟前的失败记录仍应计入', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-01-01T12:00:00Z'));

      securityLogger.logAuthFailure('test-tool', 'client-123', new Error('第一次'));
      // 恰好 5 分钟：边界使用 >=，仍计入
      vi.advanceTimersByTime(5 * 60 * 1000);
      for (let i = 0; i < 4; i++) {
        securityLogger.logAuthFailure('test-tool', 'client-123', new Error('后续'));
      }

      expect(alerts).toHaveLength(1);
      expect(alerts[0].type).toBe('MULTIPLE_AUTH_FAILURES');
    });
  });

  describe('频率限制滥用告警', () => {
    const logRateLimitEvent = () => {
      securityLogger.logSecurityEvent({
        type: SecurityEventType.RATE_LIMIT_EXCEEDED,
        toolId: 'test-tool',
        clientId: 'client-123',
        timestamp: new Date(),
        details: {},
        severity: 'medium',
      });
    };

    it('同一客户端 10 分钟内违规达到 10 次应触发 warning 告警', () => {
      for (let i = 0; i < 9; i++) {
        logRateLimitEvent();
      }
      expect(alerts).toHaveLength(0);

      logRateLimitEvent();

      expect(alerts).toHaveLength(1);
      expect(alerts[0].type).toBe('RATE_LIMIT_ABUSE');
      expect(alerts[0].level).toBe('warning');
      expect(alerts[0].message).toContain('client-123');
      expect(alerts[0].message).toContain('10分钟');
      expect(alerts[0].message).toContain('10次');
      expect(alerts[0].data).toEqual({
        clientId: 'client-123',
        violationCount: 10,
        toolId: 'test-tool',
      });
    });

    it('超过 10 分钟的违规记录不应计入', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-01-01T12:00:00Z'));

      // 11 分钟前的 5 次违规已超出窗口
      const oldLogger = securityLogger;
      for (let i = 0; i < 5; i++) {
        oldLogger.logSecurityEvent({
          type: SecurityEventType.RATE_LIMIT_EXCEEDED,
          toolId: 'test-tool',
          clientId: 'client-123',
          timestamp: new Date('2026-01-01T11:49:00Z'),
          details: {},
          severity: 'medium',
        });
      }

      vi.setSystemTime(new Date('2026-01-01T12:00:00Z'));
      // 窗口内只有 9 次违规，未达 10 次阈值
      for (let i = 0; i < 9; i++) {
        logRateLimitEvent();
      }

      expect(alerts).toHaveLength(0);
    });
  });

  describe('可疑活动告警', () => {
    it('critical 可疑活动应触发 critical 告警并包含原因', () => {
      securityLogger.logSecurityEvent({
        type: SecurityEventType.SUSPICIOUS_ACTIVITY,
        toolId: 'test-tool',
        clientId: 'client-123',
        timestamp: new Date(),
        details: { reason: '异常访问模式' },
        severity: 'critical',
      });

      expect(alerts).toHaveLength(1);
      expect(alerts[0].type).toBe('SUSPICIOUS_ACTIVITY');
      expect(alerts[0].level).toBe('critical');
      expect(alerts[0].message).toBe('检测到可疑活动: 异常访问模式');
      expect(alerts[0].data).toEqual({
        toolId: 'test-tool',
        clientId: 'client-123',
        details: { reason: '异常访问模式' },
      });
    });

    it('非 critical 严重级别的可疑活动告警级别应为 warning', () => {
      securityLogger.logSecurityEvent({
        type: SecurityEventType.SUSPICIOUS_ACTIVITY,
        toolId: 'test-tool',
        timestamp: new Date(),
        details: { reason: '异常访问模式' },
        severity: 'high',
      });

      expect(alerts).toHaveLength(1);
      expect(alerts[0].level).toBe('warning');
    });

    it('缺少原因时应显示未知原因', () => {
      securityLogger.logSecurityEvent({
        type: SecurityEventType.SUSPICIOUS_ACTIVITY,
        toolId: 'test-tool',
        timestamp: new Date(),
        details: {},
        severity: 'medium',
      });

      expect(alerts).toHaveLength(1);
      expect(alerts[0].message).toBe('检测到可疑活动: 未知原因');
    });
  });

  describe('旧日志定期清理', () => {
    it('每小时应清理超过 24 小时的日志与事件', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-01-01T12:00:00Z'));
      const cleaner = new SecurityLoggerImpl();
      cleaner.setAlertCallback(() => {});

      const oneDayAgo = new Date('2025-12-31T11:30:00Z'); // 超过24小时
      const recent = new Date('2026-01-01T11:00:00Z'); // 24小时内

      cleaner.logApiCall({
        toolId: 'old-tool',
        timestamp: oneDayAgo,
        parameters: {},
        success: false,
      });
      cleaner.logApiCall({
        toolId: 'new-tool',
        timestamp: recent,
        parameters: {},
        success: true,
      });
      cleaner.logSecurityEvent({
        type: SecurityEventType.SUSPICIOUS_ACTIVITY,
        toolId: 'old-tool',
        timestamp: oneDayAgo,
        details: {},
        severity: 'medium',
      });

      vi.advanceTimersByTime(60 * 60 * 1000); // 触发每小时清理

      expect(vi.mocked(logger.debug)).toHaveBeenCalledWith('清理旧日志完成');

      const logs = storedLogs(cleaner);
      expect(logs).toHaveLength(1);
      expect(logs[0].toolId).toBe('new-tool');
      expect(storedEvents(cleaner)).toHaveLength(0);

      cleaner.dispose();
    });

    it('dispose 后应停止定时清理', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-01-01T12:00:00Z'));
      const cleaner = new SecurityLoggerImpl();

      cleaner.logApiCall({
        toolId: 'old-tool',
        timestamp: new Date('2025-12-31T11:30:00Z'),
        parameters: {},
        success: true,
      });

      cleaner.dispose();
      cleaner.dispose(); // 幂等
      vi.advanceTimersByTime(60 * 60 * 1000);

      expect(storedLogs(cleaner)).toHaveLength(1); // 未被清理
    });
  });

  describe('自定义监控配置', () => {
    it('应该使用自定义告警阈值触发告警', async () => {
      const customLogger = new SecurityLoggerImpl(undefined, {
        alertThresholds: {
          errorRate: 25,
          timeWindow: 60,
          minRequests: 5,
        },
      });

      const customAlerts: Array<{
        type: string;
        level: string;
        message: string;
        data: Record<string, unknown>;
        timestamp: Date;
      }> = [];
      customLogger.setAlertCallback((alert) => {
        customAlerts.push(alert);
      });

      // 3 失败 + 7 成功 = 30% 错误率 > 25% 阈值，minRequests=5
      // 从第 5 次调用开始（3 失败 + 2 成功，错误率 60%）每次 logApiCall 都会触发告警
      for (let i = 0; i < 3; i++) {
        customLogger.logApiCall({
          toolId: 'test-tool',
          timestamp: new Date(),
          parameters: {},
          success: false,
        });
      }
      for (let i = 0; i < 7; i++) {
        customLogger.logApiCall({
          toolId: 'test-tool',
          timestamp: new Date(),
          parameters: {},
          success: true,
        });
      }

      expect(customAlerts).toHaveLength(6);
      expect(customAlerts.every((a) => a.type === 'HIGH_ERROR_RATE')).toBe(true);
      expect(customAlerts[0].data).toEqual({
        errorRate: 60,
        totalRequests: 5,
        failedRequests: 3,
        timeWindow: 60,
      });
      expect(customAlerts[5].level).toBe('warning');
      expect(customAlerts[5].data).toEqual({
        errorRate: 30,
        totalRequests: 10,
        failedRequests: 3,
        timeWindow: 60,
      });
      customLogger.dispose();
    });
  });
});
