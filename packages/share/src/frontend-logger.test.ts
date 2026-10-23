/**
 * 前端日志系统测试
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ConsoleWriter,
  createFrontendLogger,
  DEFAULT_LOGGER_CONFIG,
  EnvironmentDetector,
  FrontendLogger,
  LOG_LEVEL_NAMES,
  LogLevel,
  frontendLogger,
  TextFormatter,
} from './frontend-logger.js';

const ISO = '2024-01-01T00:00:00.000Z';

describe('LOG_LEVEL_NAMES', () => {
  it('五个级别都有正确名称', () => {
    expect(LOG_LEVEL_NAMES[LogLevel.DEBUG]).toBe('DEBUG');
    expect(LOG_LEVEL_NAMES[LogLevel.INFO]).toBe('INFO');
    expect(LOG_LEVEL_NAMES[LogLevel.WARN]).toBe('WARN');
    expect(LOG_LEVEL_NAMES[LogLevel.ERROR]).toBe('ERROR');
    expect(LOG_LEVEL_NAMES[LogLevel.FATAL]).toBe('FATAL');
  });
});

describe('FrontendLogger', () => {
  let logger: FrontendLogger;
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-06-01T12:00:00.000Z'));
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    logger = new FrontendLogger({
      level: LogLevel.DEBUG,
      enableColors: false,
      enableTimestamp: false,
      enableConsole: true,
    });
  });

  afterEach(() => {
    consoleSpy.mockRestore();
    vi.useRealTimers();
  });

  it('应该记录不同级别的日志', () => {
    logger.debug('调试消息');
    logger.info('信息消息');
    logger.warn('警告消息');
    logger.error('错误消息');
    logger.fatal('致命错误消息');

    expect(consoleSpy).toHaveBeenCalledTimes(5);
  });

  it('应该根据日志级别过滤消息', () => {
    logger.setLevel(LogLevel.WARN);

    logger.debug('调试消息');
    logger.info('信息消息');
    logger.warn('警告消息');
    logger.error('错误消息');

    expect(consoleSpy).toHaveBeenCalledTimes(2); // 只有 WARN 和 ERROR
  });

  it('getLevel/setLevel 读写当前级别', () => {
    expect(logger.getLevel()).toBe(LogLevel.DEBUG);
    logger.setLevel(LogLevel.ERROR);
    expect(logger.getLevel()).toBe(LogLevel.ERROR);
  });

  it('text 格式输出 message 与上下文标识', () => {
    logger.info('测试消息', {
      component: 'TestComponent',
      serverId: 'server1',
    });

    expect(consoleSpy).toHaveBeenCalledTimes(1);
    const output = consoleSpy.mock.calls[0]?.join(' ');
    expect(output).toContain('INFO');
    expect(output).toContain('测试消息');
    expect(output).toContain('[TestComponent]');
    expect(output).toContain('[server:server1]');
  });

  it('error 输出错误消息', () => {
    logger.error('操作失败', new Error('测试错误'));

    expect(consoleSpy).toHaveBeenCalledTimes(1);
    const output = consoleSpy.mock.calls[0]?.join(' ');
    expect(output).toContain('操作失败');
    expect(output).toContain('- 测试错误');
  });
});

describe('FrontendLogger 浏览器样式输出', () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-06-01T12:00:00.000Z'));
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleSpy.mockRestore();
    vi.useRealTimers();
  });

  it('text 格式按「文本+样式」交替传参给 console.log', () => {
    const logger = new FrontendLogger({
      level: LogLevel.DEBUG,
      enableConsole: true,
      enableColors: true,
      enableTimestamp: true,
      component: 'Comp',
    });
    logger.error('boom happened', new Error('bad'), { serverId: 's1', duration: 7 });

    expect(consoleSpy).toHaveBeenCalledTimes(1);
    expect(consoleSpy).toHaveBeenCalledWith(
      '%c2024-06-01T12:00:00.000Z',
      'color: gray;',
      '%cERROR',
      'color: red;',
      '%c[Comp]',
      'color: teal;',
      'boom happened',
      '%c[server:s1]',
      'color: gray;',
      '%c(7ms)',
      'color: gray;',
      '%c- bad',
      'color: red;',
    );
  });

  it('operation 段使用紫色样式', () => {
    const logger = new FrontendLogger({
      level: LogLevel.DEBUG,
      enableConsole: true,
      enableColors: true,
      enableTimestamp: false,
    });
    logger.info('msg', { operation: 'sync' });

    expect(consoleSpy).toHaveBeenCalledWith(
      '%cINFO',
      'color: green;',
      '%c{sync}',
      'color: purple;',
      'msg',
    );
  });

  it('禁用时间戳时跳过时间戳段', () => {
    const logger = new FrontendLogger({
      level: LogLevel.DEBUG,
      enableConsole: true,
      enableColors: true,
      enableTimestamp: false,
    });
    logger.warn('msg');

    expect(consoleSpy).toHaveBeenCalledWith('%cWARN', 'color: orange;', 'msg');
  });

  it('DEBUG 级别使用青色样式', () => {
    const logger = new FrontendLogger({
      level: LogLevel.DEBUG,
      enableConsole: true,
      enableColors: true,
      enableTimestamp: false,
    });
    logger.debug('msg');

    expect(consoleSpy).toHaveBeenCalledWith('%cDEBUG', 'color: teal;', 'msg');
  });

  it('fatal 输出 FATAL 级别并提取错误信息', () => {
    const logger = new FrontendLogger({
      level: LogLevel.DEBUG,
      enableConsole: true,
      enableColors: true,
      enableTimestamp: false,
    });
    logger.fatal('crashed', new Error('dead'));

    const args = consoleSpy.mock.calls[0] as string[];
    expect(args[0]).toBe('%cFATAL');
    expect(args[1]).toBe('color: purple;');
    expect(args).toContain('%c- dead');
  });

  it('自定义 context 生成 meta 段', () => {
    const logger = new FrontendLogger({
      level: LogLevel.DEBUG,
      enableConsole: true,
      enableColors: true,
      enableTimestamp: false,
    });
    logger.info('msg', { context: { a: 1 } });

    expect(consoleSpy).toHaveBeenCalledWith(
      '%cINFO',
      'color: green;',
      'msg',
      '%c[meta:{"a":1}]',
      'color: gray;',
    );
  });

  it('json 格式输出单参数 JSON 字符串', () => {
    const logger = new FrontendLogger({
      level: LogLevel.DEBUG,
      enableConsole: true,
      format: 'json',
    });
    logger.info('hello');

    expect(consoleSpy).toHaveBeenCalledTimes(1);
    const entry = JSON.parse(consoleSpy.mock.calls[0]?.[0] as string);
    expect(entry).toEqual({
      timestamp: '2024-06-01T12:00:00.000Z',
      level: LogLevel.INFO,
      levelName: 'INFO',
      message: 'hello',
      component: 'Unknown',
    });
  });

  it('配置 component 优先且 context.component 可覆盖', () => {
    const logger = new FrontendLogger({
      level: LogLevel.DEBUG,
      enableConsole: true,
      format: 'json',
      component: 'API',
    });
    logger.info('m');
    expect(JSON.parse(consoleSpy.mock.calls.at(-1)?.[0] as string).component).toBe('API');

    logger.info('m', { component: 'Ctx' });
    expect(JSON.parse(consoleSpy.mock.calls.at(-1)?.[0] as string).component).toBe('Ctx');
  });

  it('enableConsole 为 false 时不产生输出', () => {
    const logger = new FrontendLogger({ enableConsole: false, level: LogLevel.DEBUG });
    logger.info('x');
    logger.fatal('x');
    expect(consoleSpy).not.toHaveBeenCalled();
  });

  it('close 会调用支持 close 的写入器', () => {
    const logger = new FrontendLogger({ enableConsole: false, level: LogLevel.DEBUG });
    const writer = { write: vi.fn(), close: vi.fn() };
    (logger as unknown as { writers: unknown[] }).writers.push(writer);

    logger.info('go');
    expect(writer.write).toHaveBeenCalledTimes(1);

    logger.close();
    expect(writer.close).toHaveBeenCalledTimes(1);
  });
});

describe('TextFormatter（前端版本）', () => {
  it('开启颜色时给各段加 %c 前缀（样式作为独立参数由调用方传递）', () => {
    const formatter = new TextFormatter(true, true);
    const result = formatter.format({
      timestamp: ISO,
      level: LogLevel.WARN,
      levelName: 'WARN',
      message: 'hello',
      component: 'API',
      duration: 5,
      error: { name: 'Error', message: 'boom' },
    });

    expect(result).toBe('%c2024-01-01T00:00:00.000Z %cWARN %c[API] hello %c(5ms) %c- boom');
  });

  it('关闭颜色与时间戳时输出纯文本', () => {
    const formatter = new TextFormatter(false, false);
    const result = formatter.format({
      timestamp: ISO,
      level: LogLevel.INFO,
      levelName: 'INFO',
      message: 'hello',
    });

    expect(result).toBe('INFO hello');
  });

  it('组件为 Unknown 时不输出组件段', () => {
    const formatter = new TextFormatter(false, true);
    const result = formatter.format({
      timestamp: ISO,
      level: LogLevel.INFO,
      levelName: 'INFO',
      message: 'm',
      component: 'Unknown',
    });
    expect(result).toBe('2024-01-01T00:00:00.000Z INFO m');
  });
});

describe('ConsoleWriter（前端版本）', () => {
  it('无额外参数时只传消息本身', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      new ConsoleWriter().write('msg');
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy).toHaveBeenCalledWith('msg');
    } finally {
      spy.mockRestore();
    }
  });

  it('带样式参数时原样透传', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      new ConsoleWriter().write('msg', 'color: red;', 1);
      expect(spy).toHaveBeenCalledWith('msg', 'color: red;', 1);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('EnvironmentDetector', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.NODE_ENV;
    delete process.env.VITEST;
    delete process.env.LOG_LEVEL;
    delete process.env.VITEST_DEBUG;
    delete process.env.DEBUG;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    process.env = { ...originalEnv };
  });

  describe('isTestEnvironment', () => {
    it('window 分支优先：__vitest_environment__ 为 true 时返回 true', () => {
      vi.stubGlobal('window', { __vitest_environment__: true });
      process.env.NODE_ENV = 'production';
      expect(EnvironmentDetector.isTestEnvironment()).toBe(true);
    });

    it('window 存在但标记缺失时返回 false（不再回退到 process）', () => {
      vi.stubGlobal('window', {});
      process.env.NODE_ENV = 'test';
      expect(EnvironmentDetector.isTestEnvironment()).toBe(false);
    });

    it('window 访问抛错时安全返回 false', () => {
      const evil: Record<string, unknown> = {};
      Object.defineProperty(evil, '__vitest_environment__', {
        get() {
          throw new Error('boom');
        },
      });
      vi.stubGlobal('window', evil);
      expect(EnvironmentDetector.isTestEnvironment()).toBe(false);
    });

    it('process 分支：NODE_ENV=test 或 VITEST 置位时返回 true', () => {
      process.env.NODE_ENV = 'test';
      expect(EnvironmentDetector.isTestEnvironment()).toBe(true);

      process.env.NODE_ENV = 'production';
      process.env.VITEST = 'true';
      expect(EnvironmentDetector.isTestEnvironment()).toBe(true);

      process.env.NODE_ENV = 'production';
      delete process.env.VITEST;
      expect(EnvironmentDetector.isTestEnvironment()).toBe(false);
    });
  });

  describe('isDebugMode', () => {
    it('window.__vitest_debug__ 为 true 时返回 true', () => {
      vi.stubGlobal('window', { __vitest_debug__: true });
      expect(EnvironmentDetector.isDebugMode()).toBe(true);
    });

    it('window 存在但标记缺失时返回 false', () => {
      vi.stubGlobal('window', {});
      process.env.VITEST_DEBUG = 'true';
      expect(EnvironmentDetector.isDebugMode()).toBe(false);
    });

    it('process 分支识别 VITEST_DEBUG / DEBUG', () => {
      process.env.VITEST_DEBUG = 'true';
      expect(EnvironmentDetector.isDebugMode()).toBe(true);

      delete process.env.VITEST_DEBUG;
      process.env.DEBUG = 'true';
      expect(EnvironmentDetector.isDebugMode()).toBe(true);

      process.env.DEBUG = 'false';
      expect(EnvironmentDetector.isDebugMode()).toBe(false);
    });

    it('process 不可用时回退检查 localStorage', () => {
      vi.stubGlobal('process', undefined);
      const store = {
        getItem: (key: string) => (key === 'DEBUG' ? 'true' : null),
      };
      vi.stubGlobal('localStorage', store);
      expect(EnvironmentDetector.isDebugMode()).toBe(true);

      vi.stubGlobal('localStorage', { getItem: () => null });
      expect(EnvironmentDetector.isDebugMode()).toBe(false);
    });
  });

  describe('getEnvironmentLogLevel', () => {
    it('process.env.LOG_LEVEL 优先（大小写不敏感）', () => {
      process.env.LOG_LEVEL = 'ERROR';
      expect(EnvironmentDetector.getEnvironmentLogLevel()).toBe(LogLevel.ERROR);

      process.env.LOG_LEVEL = 'debug';
      expect(EnvironmentDetector.getEnvironmentLogLevel()).toBe(LogLevel.DEBUG);
    });

    it('process.env.LOG_LEVEL 非法时继续向后回退', () => {
      process.env.LOG_LEVEL = 'NOPE';
      vi.stubGlobal('localStorage', { getItem: () => 'fatal' });
      expect(EnvironmentDetector.getEnvironmentLogLevel()).toBe(LogLevel.FATAL);
    });

    it('process 不可用时读取 localStorage 的 LOG_LEVEL', () => {
      vi.stubGlobal('process', undefined);
      vi.stubGlobal('localStorage', {
        getItem: (key: string) => (key === 'LOG_LEVEL' ? 'warn' : null),
      });
      expect(EnvironmentDetector.getEnvironmentLogLevel()).toBe(LogLevel.WARN);
    });

    it('localStorage 值非法时继续回退到默认级别', () => {
      vi.stubGlobal('localStorage', { getItem: () => 'NOPE' });
      expect(EnvironmentDetector.getEnvironmentLogLevel()).toBe(LogLevel.INFO);
    });

    it('调试模式返回 DEBUG', () => {
      process.env.VITEST_DEBUG = 'true';
      expect(EnvironmentDetector.getEnvironmentLogLevel()).toBe(LogLevel.DEBUG);
    });

    it('测试环境（未开调试）返回 WARN', () => {
      process.env.NODE_ENV = 'test';
      expect(EnvironmentDetector.getEnvironmentLogLevel()).toBe(LogLevel.WARN);
    });

    it('普通环境返回传入的默认级别', () => {
      process.env.NODE_ENV = 'production';
      expect(EnvironmentDetector.getEnvironmentLogLevel()).toBe(LogLevel.INFO);
      expect(EnvironmentDetector.getEnvironmentLogLevel(LogLevel.FATAL)).toBe(LogLevel.FATAL);
    });
  });

  describe('getEnvironmentConsoleEnabled', () => {
    it('测试环境跟随调试模式', () => {
      process.env.NODE_ENV = 'test';
      expect(EnvironmentDetector.getEnvironmentConsoleEnabled()).toBe(false);

      process.env.VITEST_DEBUG = 'true';
      expect(EnvironmentDetector.getEnvironmentConsoleEnabled()).toBe(true);
    });

    it('非测试环境跟随默认参数', () => {
      process.env.NODE_ENV = 'production';
      expect(EnvironmentDetector.getEnvironmentConsoleEnabled()).toBe(true);
      expect(EnvironmentDetector.getEnvironmentConsoleEnabled(false)).toBe(false);
    });
  });
});

describe('DEFAULT_LOGGER_CONFIG', () => {
  it('固定字段为 text 格式且开启颜色与时间戳', () => {
    expect(DEFAULT_LOGGER_CONFIG.format).toBe('text');
    expect(DEFAULT_LOGGER_CONFIG.enableColors).toBe(true);
    expect(DEFAULT_LOGGER_CONFIG.enableTimestamp).toBe(true);
  });

  it('级别与控制台开关按当前环境计算', () => {
    expect(DEFAULT_LOGGER_CONFIG.level).toBe(
      EnvironmentDetector.getEnvironmentLogLevel(LogLevel.INFO),
    );
    expect(DEFAULT_LOGGER_CONFIG.enableConsole).toBe(
      EnvironmentDetector.getEnvironmentConsoleEnabled(true),
    );
  });
});

describe('createFrontendLogger', () => {
  it('应该创建前端日志记录器', () => {
    const logger = createFrontendLogger();
    expect(logger).toBeInstanceOf(FrontendLogger);
    expect(frontendLogger).toBeInstanceOf(FrontendLogger);
  });

  it('应该使用自定义配置创建日志记录器', () => {
    const logger = createFrontendLogger({
      level: LogLevel.DEBUG,
      format: 'json',
    });

    expect(logger).toBeInstanceOf(FrontendLogger);
    expect(logger.getLevel()).toBe(LogLevel.DEBUG);
  });
});
