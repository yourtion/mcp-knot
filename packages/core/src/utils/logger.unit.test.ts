/**
 * Core 包日志系统测试
 * 覆盖 utils/logger.ts 的 StructuredLogger 与本地封装
 */
import { EnvironmentDetector, LogLevel } from '@mcp-core/mcp-knot-share';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createLogger,
  DEFAULT_LOGGER_CONFIG,
  logger as moduleLogger,
  StructuredLogger,
  type LoggerConfig,
} from './logger.js';

/** 构造输出到控制台（文本格式、无颜色/时间戳）的记录器 */
function makeLogger(config: Partial<LoggerConfig> = {}): StructuredLogger {
  return new StructuredLogger({
    level: LogLevel.DEBUG,
    enableConsole: true,
    enableFile: false,
    format: 'text',
    enableColors: false,
    enableTimestamp: false,
    ...config,
  });
}

describe('DEFAULT_LOGGER_CONFIG', () => {
  it('默认配置值正确', () => {
    expect(DEFAULT_LOGGER_CONFIG).toEqual({
      level: EnvironmentDetector.getEnvironmentLogLevel(LogLevel.INFO),
      enableConsole: EnvironmentDetector.getEnvironmentConsoleEnabled(true),
      enableFile: false,
      maxFileSize: 10 * 1024 * 1024,
      maxFiles: 5,
      enableRotation: true,
      format: 'json',
      enableColors: true,
      enableTimestamp: true,
    });
    // 具体数值断言，防止算术表达式被改写
    expect(DEFAULT_LOGGER_CONFIG.maxFileSize).toBe(10_485_760);
  });
});

describe('StructuredLogger', () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  it('未指定 component 时默认使用 Core', () => {
    makeLogger().info('hello');

    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('[Core]'));
  });

  it('指定 component 时使用传入的组件名', () => {
    makeLogger({ component: 'CustomComponent' }).info('hello');

    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('[CustomComponent]'));
  });

  it.each([
    ['debug', '调试消息', 'DEBUG'],
    ['info', '信息消息', 'INFO'],
    ['warn', '警告消息', 'WARN'],
  ] as const)('%s 级别日志输出消息与级别名', (method, message, levelName) => {
    makeLogger()[method](message);

    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining(message));
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining(levelName));
  });

  it('error 级别日志包含错误对象信息', () => {
    makeLogger().error('操作失败', new Error('具体错误原因'));

    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('操作失败'));
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('具体错误原因'));
  });

  it('fatal 级别日志正常输出', () => {
    makeLogger().fatal('致命错误', new Error('崩溃'));

    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('致命错误'));
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('FATAL'));
  });

  it('getLevel 返回构造时的级别，setLevel 运行时可调整过滤', () => {
    const log = makeLogger({ level: LogLevel.WARN });

    expect(log.getLevel()).toBe(LogLevel.WARN);

    log.info('不应输出');
    expect(consoleSpy).not.toHaveBeenCalled();

    log.setLevel(LogLevel.DEBUG);
    log.info('应该输出');
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('应该输出'));
  });

  describe('logServerConnection', () => {
    it('connected/disconnected 记录 INFO 级别消息', () => {
      const log = makeLogger({ level: LogLevel.INFO });

      log.logServerConnection('srv-1', 'connected');
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Server srv-1 connected'));

      log.logServerConnection('srv-1', 'disconnected');
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Server srv-1 disconnected'));
    });

    it('error 状态记录 ERROR 级别消息（WARN 级别下仍输出）', () => {
      const log = makeLogger({ level: LogLevel.WARN });

      log.logServerConnection('srv-1', 'error');

      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Server srv-1 error'));
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('ERROR'));
    });

    it('非 error 状态在 WARN 级别下被过滤', () => {
      const log = makeLogger({ level: LogLevel.WARN });

      log.logServerConnection('srv-1', 'connected');

      expect(consoleSpy).not.toHaveBeenCalled();
    });
  });

  describe('logToolDiscovery', () => {
    it('记录发现的工具数量与服务器 ID', () => {
      makeLogger().logToolDiscovery('srv-1', 5);

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('Discovered 5 tools from server srv-1'),
      );
    });
  });

  describe('logToolExecution', () => {
    it('started/completed 记录 INFO 级别消息', () => {
      const log = makeLogger();

      log.logToolExecution('tool-a', 'srv-1', 'started');
      log.logToolExecution('tool-a', 'srv-1', 'completed', 42);

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('Tool tool-a execution started'),
      );
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('Tool tool-a execution completed'),
      );
    });

    it('failed 状态记录 ERROR 级别（WARN 级别下仍输出）', () => {
      const log = makeLogger({ level: LogLevel.WARN });

      log.logToolExecution('tool-a', 'srv-1', 'failed');

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('Tool tool-a execution failed'),
      );
    });

    it('非 failed 状态在 ERROR 级别下被过滤', () => {
      const log = makeLogger({ level: LogLevel.ERROR });

      log.logToolExecution('tool-a', 'srv-1', 'completed');

      expect(consoleSpy).not.toHaveBeenCalled();
    });
  });

  describe('logConfigReload', () => {
    it('记录配置重载消息', () => {
      makeLogger().logConfigReload({ actor: 'tester' });

      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Configuration reloaded'));
    });
  });

  describe('操作追踪', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('startOperation 返回 req_ 前缀的请求 ID 并记录开始消息', () => {
      const log = makeLogger();

      const requestId = log.startOperation('fetchTools', 'ToolManager');

      expect(requestId).toMatch(/^req_\d+_[a-z0-9]+$/);
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Starting fetchTools'));
    });

    it('startOperation 两次生成的请求 ID 不同', () => {
      const log = makeLogger();

      const id1 = log.startOperation('op-a', 'c');
      const id2 = log.startOperation('op-b', 'c');

      expect(id1).not.toBe(id2);
    });

    it('endOperation 记录完成消息与耗时', () => {
      const log = makeLogger();
      const requestId = log.startOperation('fetchTools', 'ToolManager');

      vi.advanceTimersByTime(250);
      log.endOperation('fetchTools', 'ToolManager', requestId, Date.now() - 250);

      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Completed fetchTools'));
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('(250ms)'));
    });

    it('failOperation 记录失败消息、错误与耗时', () => {
      const log = makeLogger();
      const requestId = log.startOperation('fetchTools', 'ToolManager');

      vi.advanceTimersByTime(120);
      log.failOperation(
        'fetchTools',
        'ToolManager',
        requestId,
        new Error('工具调用失败'),
        Date.now() - 120,
      );

      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Failed fetchTools'));
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('工具调用失败'));
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('(120ms)'));
    });
  });

  it('close 不抛出异常', () => {
    const log = makeLogger();

    expect(() => log.close()).not.toThrow();
  });
});

describe('createLogger（本地封装）', () => {
  it('返回 StructuredLogger 实例并应用默认配置', () => {
    const log = createLogger();

    expect(log).toBeInstanceOf(StructuredLogger);
    expect(log.getLevel()).toBe(DEFAULT_LOGGER_CONFIG.level);
  });

  it('自定义配置覆盖默认值', () => {
    const log = createLogger({ level: LogLevel.DEBUG });

    expect(log.getLevel()).toBe(LogLevel.DEBUG);
  });
});

describe('logger 模块实例', () => {
  afterEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
  });

  it('未设置 LOG_LEVEL 时使用环境推导级别（测试环境为 WARN）', () => {
    delete process.env.LOG_LEVEL;

    expect(moduleLogger.getLevel()).toBe(LogLevel.WARN);
  });

  it('LOG_LEVEL 指定有效级别时优先使用', async () => {
    vi.stubEnv('LOG_LEVEL', 'error');
    vi.resetModules();
    const { logger } = await import('./logger.js');

    expect(logger.getLevel()).toBe(LogLevel.ERROR);
  });

  it('LOG_LEVEL 指定无效级别时回退到 INFO', async () => {
    vi.stubEnv('LOG_LEVEL', 'not-a-level');
    vi.resetModules();
    const { logger } = await import('./logger.js');

    expect(logger.getLevel()).toBe(LogLevel.INFO);
  });
});
