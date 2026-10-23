/**
 * Logger 单元测试
 * 测试核心日志功能
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  CliLogger,
  ConsoleWriter,
  createCliLogger,
  createLogger,
  createMcpLogger,
  DEFAULT_LOGGER_CONFIG,
  EnvironmentDetector,
  JsonFormatter,
  LOG_LEVEL_NAMES,
  LogLevel,
  logger,
  McpLogger,
  TextFormatter,
  UnifiedLogger,
} from './logger.js';

const ISO = '2024-01-01T00:00:00.000Z';

describe('LogLevel', () => {
  it('应该有正确的级别值', () => {
    expect(LogLevel.DEBUG).toBe(0);
    expect(LogLevel.INFO).toBe(1);
    expect(LogLevel.WARN).toBe(2);
    expect(LogLevel.ERROR).toBe(3);
    expect(LogLevel.FATAL).toBe(4);
  });

  it('应该有正确的级别名称映射', () => {
    expect(LOG_LEVEL_NAMES[LogLevel.DEBUG]).toBe('DEBUG');
    expect(LOG_LEVEL_NAMES[LogLevel.INFO]).toBe('INFO');
    expect(LOG_LEVEL_NAMES[LogLevel.WARN]).toBe('WARN');
    expect(LOG_LEVEL_NAMES[LogLevel.ERROR]).toBe('ERROR');
    expect(LOG_LEVEL_NAMES[LogLevel.FATAL]).toBe('FATAL');
  });
});

describe('EnvironmentDetector', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    // 恢复环境变量
    process.env = { ...originalEnv };
    delete process.env.NODE_ENV;
    delete process.env.VITEST;
    delete process.env.LOG_LEVEL;
    delete process.env.VITEST_DEBUG;
    delete process.env.DEBUG;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('应该检测测试环境', () => {
    process.env.NODE_ENV = 'test';
    expect(EnvironmentDetector.isTestEnvironment()).toBe(true);

    process.env.NODE_ENV = 'production';
    expect(EnvironmentDetector.isTestEnvironment()).toBe(false);
  });

  it('应该检测 VITEST 环境变量', () => {
    delete process.env.NODE_ENV;
    process.env.VITEST = 'true';
    expect(EnvironmentDetector.isTestEnvironment()).toBe(true);
  });

  it('应该检测调试模式', () => {
    process.env.VITEST_DEBUG = 'true';
    expect(EnvironmentDetector.isDebugMode()).toBe(true);

    delete process.env.VITEST_DEBUG;
    process.env.DEBUG = 'true';
    expect(EnvironmentDetector.isDebugMode()).toBe(true);
  });

  it('非调试字符串不算调试模式', () => {
    process.env.VITEST_DEBUG = 'false';
    process.env.DEBUG = 'false';
    expect(EnvironmentDetector.isDebugMode()).toBe(false);
  });

  it('应该从环境变量获取日志级别（大小写不敏感）', () => {
    process.env.LOG_LEVEL = 'DEBUG';
    expect(EnvironmentDetector.getEnvironmentLogLevel()).toBe(LogLevel.DEBUG);

    process.env.LOG_LEVEL = 'fatal';
    expect(EnvironmentDetector.getEnvironmentLogLevel()).toBe(LogLevel.FATAL);
  });

  it('LOG_LEVEL 为非法值时回退到默认级别', () => {
    process.env.LOG_LEVEL = 'NOT_A_LEVEL';
    expect(EnvironmentDetector.getEnvironmentLogLevel()).toBe(LogLevel.INFO);
    expect(EnvironmentDetector.getEnvironmentLogLevel(LogLevel.ERROR)).toBe(LogLevel.ERROR);
  });

  it('LOG_LEVEL 优先于调试模式', () => {
    process.env.LOG_LEVEL = 'error';
    process.env.VITEST_DEBUG = 'true';
    expect(EnvironmentDetector.getEnvironmentLogLevel()).toBe(LogLevel.ERROR);
  });

  it('应该在测试环境中默认使用 WARN 级别', () => {
    process.env.NODE_ENV = 'test';
    delete process.env.LOG_LEVEL;

    expect(EnvironmentDetector.getEnvironmentLogLevel()).toBe(LogLevel.WARN);
  });

  it('测试环境开启调试模式时使用默认级别而非 WARN', () => {
    process.env.NODE_ENV = 'test';
    process.env.VITEST_DEBUG = 'true';

    expect(EnvironmentDetector.getEnvironmentLogLevel(LogLevel.DEBUG)).toBe(LogLevel.DEBUG);
  });

  it('应该在测试调试模式下启用控制台', () => {
    process.env.NODE_ENV = 'test';
    process.env.VITEST_DEBUG = 'true';

    expect(EnvironmentDetector.getEnvironmentConsoleEnabled()).toBe(true);
  });

  it('应该在测试环境中默认禁用控制台', () => {
    process.env.NODE_ENV = 'test';

    expect(EnvironmentDetector.getEnvironmentConsoleEnabled()).toBe(false);
  });

  it('非测试环境控制台开关跟随默认参数', () => {
    process.env.NODE_ENV = 'production';

    expect(EnvironmentDetector.getEnvironmentConsoleEnabled()).toBe(true);
    expect(EnvironmentDetector.getEnvironmentConsoleEnabled(false)).toBe(false);
  });
});

describe('JsonFormatter', () => {
  it('应该格式化日志条目为 JSON', () => {
    const formatter = new JsonFormatter();
    const entry = {
      timestamp: ISO,
      level: LogLevel.INFO,
      levelName: 'INFO',
      message: 'Test message',
      component: 'TestComponent',
    };

    const result = formatter.format(entry);
    const parsed = JSON.parse(result);

    expect(parsed).toEqual(entry);
  });

  it('应该处理包含错误的日志条目', () => {
    const formatter = new JsonFormatter();
    const entry = {
      timestamp: ISO,
      level: LogLevel.ERROR,
      levelName: 'ERROR',
      message: 'Test error',
      error: {
        name: 'Error',
        message: 'Test error message',
        stack: 'Error: Test error message\n    at test.ts:1:1',
      },
    };

    const result = formatter.format(entry);
    const parsed = JSON.parse(result);

    expect(parsed.error).toEqual(entry.error);
  });
});

describe('TextFormatter', () => {
  it('应该格式化日志条目为文本', () => {
    const formatter = new TextFormatter(true, true);
    const entry = {
      timestamp: ISO,
      level: LogLevel.INFO,
      levelName: 'INFO',
      message: 'Test message',
    };

    const result = formatter.format(entry);

    expect(result).toContain('INFO');
    expect(result).toContain('Test message');
    expect(result).toContain('2024-01-01');
  });

  it('应该包含组件信息', () => {
    const formatter = new TextFormatter(true, true);
    const entry = {
      timestamp: ISO,
      level: LogLevel.INFO,
      levelName: 'INFO',
      message: 'Test message',
      component: 'TestComponent',
    };

    const result = formatter.format(entry);

    expect(result).toContain('[TestComponent]');
  });

  it('应该包含持续时间', () => {
    const formatter = new TextFormatter(true, true);
    const entry = {
      timestamp: ISO,
      level: LogLevel.INFO,
      levelName: 'INFO',
      message: 'Test message',
      duration: 1234,
    };

    const result = formatter.format(entry);

    expect(result).toContain('(1234ms)');
  });

  it('应该禁用颜色和时间戳', () => {
    const formatter = new TextFormatter(false, false);
    const entry = {
      timestamp: ISO,
      level: LogLevel.INFO,
      levelName: 'INFO',
      message: 'Test message',
    };

    const result = formatter.format(entry);

    // 不应包含 ANSI 颜色代码
    expect(result).not.toContain('\x1b[');
    // 不应包含时间戳（被禁用）
    expect(result).not.toContain('2024-01-01');
  });

  it('无颜色无时间戳时输出「级别 消息」', () => {
    const formatter = new TextFormatter(false, false);
    const result = formatter.format({
      timestamp: ISO,
      level: LogLevel.INFO,
      levelName: 'INFO',
      message: 'hello',
    });

    expect(result).toBe('INFO hello');
  });

  it('完整字段时按固定顺序拼接并带 ANSI 颜色', () => {
    const formatter = new TextFormatter(true, true);
    const result = formatter.format({
      timestamp: ISO,
      level: LogLevel.WARN,
      levelName: 'WARN',
      message: 'hello',
      component: 'API',
      operation: 'sync',
      serverId: 's1',
      groupId: 'g1',
      duration: 42,
      error: { name: 'Error', message: 'boom' },
    });

    expect(result).toBe(
      [
        '\x1b[90m2024-01-01T00:00:00.000Z\x1b[0m',
        '\x1b[33mWARN\x1b[0m',
        '\x1b[36m[API]\x1b[0m',
        '\x1b[35m{sync}\x1b[0m',
        'hello',
        '\x1b[90m[server:s1, group:g1]\x1b[0m',
        '\x1b[90m(42ms)\x1b[0m',
        '\x1b[31m- boom\x1b[0m',
      ].join(' '),
    );
  });

  it('组件为 Unknown 或缺失时不输出组件段', () => {
    const formatter = new TextFormatter(false, false);

    const withUnknown = formatter.format({
      timestamp: ISO,
      level: LogLevel.INFO,
      levelName: 'INFO',
      message: 'm',
      component: 'Unknown',
    });
    expect(withUnknown).toBe('INFO m');

    const withoutComponent = formatter.format({
      timestamp: ISO,
      level: LogLevel.INFO,
      levelName: 'INFO',
      message: 'm',
    });
    expect(withoutComponent).toBe('INFO m');
  });

  it.each([
    [LogLevel.DEBUG, 'DEBUG', '\x1b[36m'],
    [LogLevel.INFO, 'INFO', '\x1b[32m'],
    [LogLevel.WARN, 'WARN', '\x1b[33m'],
    [LogLevel.ERROR, 'ERROR', '\x1b[31m'],
    [LogLevel.FATAL, 'FATAL', '\x1b[35m'],
  ])('级别 %s 使用对应颜色', (level, levelName, color) => {
    const formatter = new TextFormatter(true, false);
    const result = formatter.format({ timestamp: ISO, level, levelName, message: 'm' });
    expect(result).toBe(`${color}${levelName}\x1b[0m m`);
  });

  it('未知级别回退到重置颜色', () => {
    const formatter = new TextFormatter(true, false);
    const result = formatter.format({
      timestamp: ISO,
      level: 99 as LogLevel,
      levelName: 'CUSTOM',
      message: 'm',
    });
    expect(result).toBe('\x1b[0mCUSTOM\x1b[0m m');
  });

  it('自定义 context 优先生成 meta 段', () => {
    const formatter = new TextFormatter(false, false);
    const result = formatter.format({
      timestamp: ISO,
      level: LogLevel.INFO,
      levelName: 'INFO',
      message: 'm',
      serverId: 'ignored-by-meta',
      context: { a: 1, b: 'x' },
    });
    expect(result).toBe('INFO m [meta:{"a":1,"b":"x"}]');
  });

  it('空 context 对象时回退到 serverId/groupId/toolName 段', () => {
    const formatter = new TextFormatter(false, false);
    const result = formatter.format({
      timestamp: ISO,
      level: LogLevel.INFO,
      levelName: 'INFO',
      message: 'm',
      serverId: 's1',
      groupId: 'g1',
      toolName: 't1',
      context: {},
    });
    expect(result).toBe('INFO m [server:s1, group:g1, tool:t1]');
  });

  it('空消息被过滤掉，不产生多余空格', () => {
    const formatter = new TextFormatter(false, false);
    const result = formatter.format({
      timestamp: ISO,
      level: LogLevel.INFO,
      levelName: 'INFO',
      message: '',
    });
    expect(result).toBe('INFO');
  });

  it('colorize 关闭时原样返回文本', () => {
    const formatter = new TextFormatter(false, true);
    const result = formatter.format({
      timestamp: ISO,
      level: LogLevel.INFO,
      levelName: 'INFO',
      message: 'm',
    });
    expect(result).toBe('2024-01-01T00:00:00.000Z INFO m');
  });

  it('默认构造开启颜色与时间戳', () => {
    const formatter = new TextFormatter();
    const result = formatter.format({
      timestamp: ISO,
      level: LogLevel.INFO,
      levelName: 'INFO',
      message: 'm',
    });
    expect(result).toBe('\x1b[90m2024-01-01T00:00:00.000Z\x1b[0m \x1b[32mINFO\x1b[0m m');
  });
});

describe('ConsoleWriter', () => {
  it('write 输出到 console.log', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const writer = new ConsoleWriter();
      writer.write('line');
      expect(spy).toHaveBeenCalledWith('line');
    } finally {
      spy.mockRestore();
    }
  });
});

describe('DEFAULT_LOGGER_CONFIG', () => {
  it('包含固定的默认配置', () => {
    expect(DEFAULT_LOGGER_CONFIG.enableFile).toBe(false);
    expect(DEFAULT_LOGGER_CONFIG.maxFileSize).toBe(10 * 1024 * 1024);
    expect(DEFAULT_LOGGER_CONFIG.maxFiles).toBe(5);
    expect(DEFAULT_LOGGER_CONFIG.enableRotation).toBe(true);
    expect(DEFAULT_LOGGER_CONFIG.format).toBe('text');
    expect(DEFAULT_LOGGER_CONFIG.enableColors).toBe(true);
    expect(DEFAULT_LOGGER_CONFIG.enableTimestamp).toBe(true);
  });

  it('级别与控制台开关根据当前环境计算', () => {
    expect(DEFAULT_LOGGER_CONFIG.level).toBe(
      EnvironmentDetector.getEnvironmentLogLevel(LogLevel.INFO),
    );
    expect(DEFAULT_LOGGER_CONFIG.enableConsole).toBe(
      EnvironmentDetector.getEnvironmentConsoleEnabled(true),
    );
  });
});

describe('UnifiedLogger', () => {
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

  const jsonLogger = (config = {}) =>
    new UnifiedLogger({
      level: LogLevel.DEBUG,
      enableConsole: true,
      format: 'json',
      ...config,
    });

  const lastEntry = () => JSON.parse(consoleSpy.mock.calls.at(-1)?.[0] as string);

  it('以 JSON 输出完整日志条目（含时间戳与级别名）', () => {
    jsonLogger().info('hello');

    expect(consoleSpy).toHaveBeenCalledTimes(1);
    expect(lastEntry()).toEqual({
      timestamp: '2024-06-01T12:00:00.000Z',
      level: LogLevel.INFO,
      levelName: 'INFO',
      message: 'hello',
      component: 'Unknown',
    });
  });

  it('配置中的 component 优先，context 可覆盖', () => {
    jsonLogger({ component: 'API' }).info('m');
    expect(lastEntry().component).toBe('API');

    jsonLogger().info('m', { component: 'Ctx' });
    expect(lastEntry().component).toBe('Ctx');
  });

  it('context 字段展开进日志条目', () => {
    jsonLogger().info('m', { serverId: 's1', operation: 'sync', duration: 9 });
    expect(lastEntry()).toMatchObject({ serverId: 's1', operation: 'sync', duration: 9 });
  });

  it('低于配置级别的日志被过滤，达到阈值的日志输出', () => {
    const log = jsonLogger({ level: LogLevel.WARN });

    log.debug('d');
    log.info('i');
    expect(consoleSpy).not.toHaveBeenCalled();

    log.warn('w');
    log.error('e');
    log.fatal('f');
    expect(consoleSpy).toHaveBeenCalledTimes(3);
  });

  it('setLevel 运行时可调整过滤级别', () => {
    const log = jsonLogger({ level: LogLevel.ERROR });

    expect(log.getLevel()).toBe(LogLevel.ERROR);
    log.info('hidden');
    expect(consoleSpy).not.toHaveBeenCalled();

    log.setLevel(LogLevel.DEBUG);
    expect(log.getLevel()).toBe(LogLevel.DEBUG);
    log.info('shown');
    expect(consoleSpy).toHaveBeenCalledTimes(1);
  });

  it('error 提取 Error 对象的 name/message/stack', () => {
    jsonLogger().error('failed', new Error('boom'));

    const entry = lastEntry();
    expect(entry.level).toBe(LogLevel.ERROR);
    expect(entry.levelName).toBe('ERROR');
    expect(entry.error.name).toBe('Error');
    expect(entry.error.message).toBe('boom');
    expect(typeof entry.error.stack).toBe('string');
  });

  it('error 未提供 Error 时不产生 error 字段', () => {
    jsonLogger().error('failed');
    expect(lastEntry().error).toBeUndefined();
  });

  it('fatal 记录 FATAL 级别并提取错误信息', () => {
    jsonLogger().fatal('crashed', new Error('dead'));

    const entry = lastEntry();
    expect(entry.level).toBe(LogLevel.FATAL);
    expect(entry.levelName).toBe('FATAL');
    expect(entry.error.message).toBe('dead');
  });

  it('text 格式输出带 ANSI 颜色的单行文本', () => {
    const log = new UnifiedLogger({ level: LogLevel.INFO, enableConsole: true });
    log.info('plain');

    const arg = consoleSpy.mock.calls[0]?.[0] as string;
    expect(arg).toContain('plain');
    expect(arg).toContain('\x1b[32mINFO\x1b[0m');
    expect(arg).toContain('\x1b[90m2024-06-01T12:00:00.000Z\x1b[0m');
    expect(arg).not.toContain('Unknown');
  });

  it('enableConsole 为 false 时不产生任何输出', () => {
    const log = new UnifiedLogger({ level: LogLevel.DEBUG, enableConsole: false, format: 'json' });
    log.info('quiet');
    log.error('quiet');
    expect(consoleSpy).not.toHaveBeenCalled();
  });

  it('写入器循环输出且 close 调用支持 close 的写入器', () => {
    const log = new UnifiedLogger({ level: LogLevel.DEBUG, enableConsole: false, format: 'json' });
    const writer = { write: vi.fn(), close: vi.fn() };
    (log as unknown as { writers: unknown[] }).writers.push(writer);

    log.info('go');
    expect(writer.write).toHaveBeenCalledTimes(1);
    expect(JSON.parse(writer.write.mock.calls[0][0] as string).message).toBe('go');

    log.close();
    expect(writer.close).toHaveBeenCalledTimes(1);
  });
});

describe('CliLogger', () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-06-01T12:00:00.000Z'));
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleSpy.mockRestore();
    vi.useRealTimers();
    process.env = { ...originalEnv };
  });

  const makeLogger = (config = {}) =>
    new CliLogger({ level: LogLevel.DEBUG, enableConsole: true, format: 'json', ...config });

  const lastEntry = () => JSON.parse(consoleSpy.mock.calls.at(-1)?.[0] as string);

  it('默认组件名为 CLI', () => {
    makeLogger().info('m');
    expect(lastEntry().component).toBe('CLI');
  });

  it('success/warning/failure/progress 添加对应前缀', () => {
    makeLogger().success('done');
    expect(lastEntry().message).toBe('✅ done');

    makeLogger().warning('careful');
    expect(lastEntry().message).toBe('⚠️  careful');

    makeLogger().progress('working');
    expect(lastEntry().message).toBe('🔄 working');

    makeLogger().failure('broke', new Error('bad'));
    const entry = lastEntry();
    expect(entry.message).toBe('❌ broke');
    expect(entry.level).toBe(LogLevel.ERROR);
    expect(entry.error.message).toBe('bad');
  });

  describe('静默模式（测试环境且未开调试）', () => {
    beforeEach(() => {
      process.env = { ...originalEnv, NODE_ENV: 'test' };
      delete process.env.VITEST_DEBUG;
      delete process.env.DEBUG;
    });

    it('showBanner/showConfig/showServers/showTools/showHelp 不直接打印', () => {
      const cli = makeLogger();
      const callsBefore = () => consoleSpy.mock.calls.length;

      cli.showBanner('1.0.0');
      expect(consoleSpy).not.toHaveBeenCalled();

      cli.showConfig({ a: 1 });
      expect(callsBefore()).toBe(1); // 只有 info('当前配置:') 一条
      expect(consoleSpy.mock.calls[0]?.[0]).toContain('当前配置');

      consoleSpy.mockClear();
      cli.showServers([{ id: 's1', status: 'connected', tools: 3 }]);
      expect(callsBefore()).toBe(1);

      consoleSpy.mockClear();
      cli.showTools([{ name: 't', serverId: 's1' }]);
      expect(callsBefore()).toBe(1);

      consoleSpy.mockClear();
      cli.showHelp([{ name: 'start', description: 'd' }]);
      expect(consoleSpy).not.toHaveBeenCalled();
    });
  });

  describe('非测试环境直接打印', () => {
    beforeEach(() => {
      process.env = { ...originalEnv, NODE_ENV: 'production' };
      delete process.env.VITEST;
      delete process.env.VITEST_DEBUG;
      delete process.env.DEBUG;
    });

    it('showBanner 打印带颜色的版本横幅', () => {
      makeLogger().showBanner('1.2.3');

      expect(consoleSpy).toHaveBeenCalledTimes(1);
      const banner = consoleSpy.mock.calls[0]?.[0] as string;
      expect(banner.startsWith('\x1b[36m\n╭─')).toBe(true);
      expect(banner.endsWith('╯\n\x1b[0m')).toBe(true);
      expect(banner).toContain('│           MCP Knot CLI              │');
      expect(banner).toContain(`│           版本 ${'1.2.3'.padEnd(20)} │`);
    });

    it('showConfig 逐行打印键值', () => {
      makeLogger().showConfig({ port: 8181, list: ['a'] });

      const lines = consoleSpy.mock.calls.map((c) => c[0]);
      expect(lines).toHaveLength(3);
      expect(JSON.parse(lines[0]).message).toBe('当前配置:');
      expect(lines[1]).toBe('  port: 8181');
      expect(lines[2]).toBe('  list: ["a"]');
    });

    it('showServers 按状态显示图标', () => {
      makeLogger().showServers([
        { id: 's1', status: 'connected', tools: 3 },
        { id: 's2', status: 'error', tools: 0 },
      ]);

      const lines = consoleSpy.mock.calls.map((c) => c[0]);
      expect(lines[1]).toBe('  🟢 s1 (3 个工具)');
      expect(lines[2]).toBe('  🔴 s2 (0 个工具)');
    });

    it('showTools 显示名称、来源与可选描述', () => {
      makeLogger().showTools([
        { name: 't', serverId: 's1' },
        { name: 'u', description: 'desc', serverId: 's2' },
      ]);

      const lines = consoleSpy.mock.calls.map((c) => c[0]);
      expect(lines[1]).toBe('  🔧 t [s1]');
      expect(lines[2]).toBe('  🔧 u [s2] - desc');
    });

    it('showHelp 打印命令列表并保持对齐', () => {
      makeLogger().showHelp([{ name: 'start', description: 'Start server' }]);

      expect(consoleSpy).toHaveBeenCalledTimes(3);
      expect(consoleSpy.mock.calls[0]?.[0]).toBe('\n可用命令:');
      expect(consoleSpy.mock.calls[1]?.[0]).toBe(`  ${'start'.padEnd(20)} Start server`);
      expect(consoleSpy.mock.calls[2]?.[0]).toBe('');
    });
  });
});

describe('McpLogger', () => {
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

  const makeLogger = (config = {}) =>
    new McpLogger({ level: LogLevel.DEBUG, enableConsole: true, format: 'json', ...config });

  const lastEntry = () => JSON.parse(consoleSpy.mock.calls.at(-1)?.[0] as string);

  it('默认组件名为 MCP，可被配置覆盖', () => {
    makeLogger().info('m');
    expect(lastEntry().component).toBe('MCP');

    makeLogger({ component: 'Custom' }).info('m');
    expect(lastEntry().component).toBe('Custom');
  });

  it('logServerConnection 连接/断开记 INFO，失败记 ERROR', () => {
    const mcp = makeLogger();

    mcp.logServerConnection('s1', 'connected');
    expect(lastEntry()).toMatchObject({
      level: LogLevel.INFO,
      message: 'Server connected',
      serverId: 's1',
    });

    mcp.logServerConnection('s1', 'disconnected');
    expect(lastEntry()).toMatchObject({ level: LogLevel.INFO, message: 'Server disconnected' });

    mcp.logServerConnection('s1', 'failed', { reason: 'timeout' });
    expect(lastEntry()).toMatchObject({
      level: LogLevel.ERROR,
      levelName: 'ERROR',
      message: 'Server failed',
      serverId: 's1',
      reason: 'timeout',
    });
  });

  it('logToolDiscovery 记录工具数量', () => {
    makeLogger().logToolDiscovery('s1', 5, { total: 5 });
    expect(lastEntry()).toMatchObject({ message: 'Discovered 5 tools', serverId: 's1', total: 5 });
  });

  it('logToolExecution started/completed 记 INFO，failed 记 ERROR', () => {
    const mcp = makeLogger();

    mcp.logToolExecution('t1', 'g1', 'started');
    expect(lastEntry()).toMatchObject({
      level: LogLevel.INFO,
      message: 'Tool execution started',
      toolName: 't1',
      groupId: 'g1',
    });

    mcp.logToolExecution('t1', 'g1', 'completed', { duration: 10 });
    expect(lastEntry()).toMatchObject({ message: 'Tool execution completed', duration: 10 });

    mcp.logToolExecution('t1', 'g1', 'failed');
    expect(lastEntry()).toMatchObject({
      level: LogLevel.ERROR,
      levelName: 'ERROR',
      message: 'Tool execution failed',
    });
  });

  it('logConfigReload 拼接变更列表', () => {
    makeLogger().logConfigReload(['servers', 'groups'], { actor: 'admin' });
    expect(lastEntry()).toMatchObject({
      message: 'Configuration reloaded with changes: servers, groups',
      actor: 'admin',
    });
  });
});

describe('工厂函数与默认实例', () => {
  it('createLogger 返回 UnifiedLogger 并应用配置', () => {
    const log = createLogger({ level: LogLevel.ERROR, enableConsole: false, component: 'X' });
    expect(log).toBeInstanceOf(UnifiedLogger);
    expect(log.getLevel()).toBe(LogLevel.ERROR);
  });

  it('createCliLogger / createMcpLogger 返回对应子类', () => {
    expect(createCliLogger({ enableConsole: false })).toBeInstanceOf(CliLogger);
    expect(createMcpLogger({ enableConsole: false })).toBeInstanceOf(McpLogger);
    expect(createCliLogger({ enableConsole: false })).toBeInstanceOf(UnifiedLogger);
  });

  it('默认导出 logger 是 UnifiedLogger 实例', () => {
    expect(logger).toBeInstanceOf(UnifiedLogger);
  });
});
