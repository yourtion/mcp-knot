/**
 * CLI日志系统测试
 */

import { EnvironmentDetector, LogLevel } from '@mcp-core/mcp-knot-share';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CliLogger, createCliLoggerFromOptions, DEFAULT_CLI_LOGGER_CONFIG } from './logger';

import type { LoggerConfig } from '@mcp-core/mcp-knot-share';

/** UnifiedLogger 未公开 config 读取器，测试中经此断言构造时派生的配置 */
function getInternalConfig(logger: CliLogger): LoggerConfig {
  return (logger as unknown as { config: LoggerConfig }).config;
}

describe('CliLogger', () => {
  let logger: CliLogger;
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    // 在测试中明确禁用静默模式，以便测试日志输出
    logger = new CliLogger({
      ...DEFAULT_CLI_LOGGER_CONFIG,
      level: LogLevel.DEBUG,
      enableColors: false,
      enableTimestamp: false,
      quiet: false, // 明确禁用静默模式
      enableConsole: true, // 明确启用控制台输出
    });
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  it('应该记录成功消息', () => {
    logger.success('操作成功');

    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('✅ 操作成功'));
  });

  it('应该记录警告消息', () => {
    logger.warning('这是一个警告');

    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('⚠️  这是一个警告'));
  });

  it('应该记录失败消息', () => {
    const error = new Error('测试错误');
    logger.failure('操作失败', error);

    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('❌ 操作失败'));
  });

  it('应该记录进度消息', () => {
    logger.progress('正在处理...');

    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('🔄 正在处理...'));
  });

  it('应该显示启动横幅', () => {
    // 在非测试环境中测试横幅显示
    const originalEnv = process.env.NODE_ENV;
    const originalVitest = process.env.VITEST;
    delete process.env.NODE_ENV;
    delete process.env.VITEST;

    const nonTestLogger = new CliLogger({
      ...DEFAULT_CLI_LOGGER_CONFIG,
      level: LogLevel.DEBUG,
      enableColors: false,
      enableTimestamp: false,
      quiet: false,
      enableConsole: true,
    });

    nonTestLogger.showBanner('1.0.0');

    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('MCP Knot CLI'));
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('版本 1.0.0'));

    // 恢复环境变量
    if (originalEnv) process.env.NODE_ENV = originalEnv;
    if (originalVitest) process.env.VITEST = originalVitest;
  });

  it('应该显示配置信息', () => {
    const config = {
      level: 'INFO',
      enableFile: false,
      servers: ['server1', 'server2'],
    };

    logger.showConfig(config);

    // 只检查 info 日志调用，因为在测试环境中 console.log 被阻止
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('当前配置:'));
  });

  it('应该显示服务器列表', () => {
    const servers = [
      { id: 'server1', status: 'connected', tools: 5 },
      { id: 'server2', status: 'disconnected', tools: 3 },
    ];

    logger.showServers(servers);

    // 只检查 info 日志调用，因为在测试环境中 console.log 被阻止
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('已配置的服务器:'));
  });

  it('应该显示工具列表', () => {
    const tools = [
      { name: 'tool1', description: '工具1描述', serverId: 'server1' },
      { name: 'tool2', serverId: 'server2' },
    ];

    logger.showTools(tools);

    // 只检查 info 日志调用，因为在测试环境中 console.log 被阻止
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('可用工具:'));
  });

  it('应该显示帮助信息', () => {
    const commands = [
      { name: 'start', description: '启动MCP服务器' },
      { name: 'list', description: '列出可用工具' },
    ];

    // 在非测试环境中测试帮助信息显示
    const originalEnv = process.env.NODE_ENV;
    const originalVitest = process.env.VITEST;
    delete process.env.NODE_ENV;
    delete process.env.VITEST;

    const nonTestLogger = new CliLogger({
      ...DEFAULT_CLI_LOGGER_CONFIG,
      level: LogLevel.DEBUG,
      enableColors: false,
      enableTimestamp: false,
      quiet: false,
      enableConsole: true,
    });

    nonTestLogger.showHelp(commands);

    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('可用命令:'));
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('start                启动MCP服务器'),
    );
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('list                 列出可用工具'),
    );

    // 恢复环境变量
    if (originalEnv) process.env.NODE_ENV = originalEnv;
    if (originalVitest) process.env.VITEST = originalVitest;
  });

  it('应该在静默模式下调整日志级别', () => {
    const quietLogger = new CliLogger({
      ...DEFAULT_CLI_LOGGER_CONFIG,
      quiet: true,
    });

    expect(quietLogger.getLevel()).toBe(LogLevel.WARN);
  });

  it('应该在详细模式下调整日志级别', () => {
    // 在非测试环境中测试详细模式
    const originalEnv = process.env.NODE_ENV;
    const originalVitest = process.env.VITEST;
    delete process.env.NODE_ENV;
    delete process.env.VITEST;

    const verboseLogger = new CliLogger({
      ...DEFAULT_CLI_LOGGER_CONFIG,
      verbose: true,
      quiet: false, // 明确禁用静默模式
    });

    expect(verboseLogger.getLevel()).toBe(LogLevel.DEBUG);

    // 恢复环境变量
    if (originalEnv) process.env.NODE_ENV = originalEnv;
    if (originalVitest) process.env.VITEST = originalVitest;
  });
});

describe('createCliLoggerFromOptions', () => {
  it('应该根据选项创建CLI日志记录器', () => {
    const logger = createCliLoggerFromOptions({
      verbose: true,
      quiet: false,
      logFile: '/tmp/test.log',
      noColor: true,
      logLevel: 'DEBUG',
    });

    expect(logger).toBeInstanceOf(CliLogger);
    expect(logger.getLevel()).toBe(LogLevel.DEBUG);
  });

  it('应该处理静默模式', () => {
    const logger = createCliLoggerFromOptions({
      quiet: true,
    });

    expect(logger.getLevel()).toBe(LogLevel.WARN);
  });

  it('应该处理详细模式', () => {
    const logger = createCliLoggerFromOptions({
      verbose: true,
    });

    expect(logger.getLevel()).toBe(LogLevel.DEBUG);
  });

  it('应该处理无效的日志级别', () => {
    const logger = createCliLoggerFromOptions({
      logLevel: 'INVALID',
    });

    // 应该使用默认级别
    expect(logger.getLevel()).toBe(LogLevel.INFO);
  });

  it('应该启用文件日志当提供日志文件路径时', () => {
    const logger = createCliLoggerFromOptions({
      logFile: '/tmp/test.log',
    });

    expect(logger).toBeInstanceOf(CliLogger);
  });
});

describe('DEFAULT_CLI_LOGGER_CONFIG', () => {
  it('应包含确定的默认配置值', () => {
    expect(DEFAULT_CLI_LOGGER_CONFIG).toEqual({
      level: LogLevel.INFO,
      enableConsole: true,
      enableFile: false,
      format: 'text',
      enableColors: true,
      enableTimestamp: true,
      quiet: EnvironmentDetector.isTestEnvironment() && !EnvironmentDetector.isDebugMode(),
      verbose: false,
      logDir: path.join(os.homedir(), '.mcp-knot', 'logs'),
      maxFileSize: 5 * 1024 * 1024,
      maxFiles: 3,
      enableRotation: true,
    });
  });
});

describe('CliLogger 构造时的配置派生', () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    // 显式锁定测试环境，避免依赖运行时的 NODE_ENV/VITEST 取值
    process.env.VITEST = '1';
    process.env.NODE_ENV = 'test';
  });

  afterEach(() => {
    consoleSpy.mockRestore();
    delete process.env.NODE_ENV;
  });

  it('测试环境下未显式指定 quiet 时应自动静默并提升日志级别', () => {
    // quiet 未传（undefined）→ 测试环境自动开启静默 → 级别收敛到 WARN
    const logger = new CliLogger({
      level: LogLevel.DEBUG,
      enableConsole: true,
    });

    expect(logger.getLevel()).toBe(LogLevel.WARN);
  });

  it('静默模式下若未显式开启控制台应禁用控制台输出', () => {
    const quietLogger = new CliLogger({ quiet: true });
    quietLogger.warn('静默警告');

    expect(consoleSpy).not.toHaveBeenCalled();

    // 显式 enableConsole: true 时静默模式不屏蔽控制台
    consoleSpy.mockClear();
    const explicitConsoleLogger = new CliLogger({ quiet: true, enableConsole: true });
    explicitConsoleLogger.warn('显式控制台警告');

    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('显式控制台警告'));
  });

  it('verbose 优先级高于 quiet，两者同时设置时按 verbose 处理', () => {
    const logger = new CliLogger({ verbose: true, quiet: true });

    expect(logger.getLevel()).toBe(LogLevel.DEBUG);
    expect(getInternalConfig(logger).quiet).toBe(false);
  });

  it('启用文件日志且提供 logDir 时应派生日志文件路径', () => {
    const logger = new CliLogger({ enableFile: true, logDir: '/tmp/mcp-knot-test' });

    expect(getInternalConfig(logger).filePath).toBe('/tmp/mcp-knot-test/mcp-knot-cli.log');
  });
});

describe('createCliLoggerFromOptions 配置映射', () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  it('默认应启用彩色输出', () => {
    const logger = createCliLoggerFromOptions({ quiet: false });
    logger.info('彩色消息');

    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('\x1b['));
  });

  it('noColor 选项应关闭彩色输出', () => {
    const logger = createCliLoggerFromOptions({ quiet: false, noColor: true });
    logger.info('纯文本消息');

    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('INFO [CLI] 纯文本消息'));
    expect(consoleSpy).not.toHaveBeenCalledWith(expect.stringContaining('\x1b['));
  });

  it('仅指定 logLevel 时应使用该级别而不是默认 INFO', () => {
    const warnLogger = createCliLoggerFromOptions({ logLevel: 'warn' });
    expect(warnLogger.getLevel()).toBe(LogLevel.WARN);

    const errorLogger = createCliLoggerFromOptions({ logLevel: 'ERROR' });
    expect(errorLogger.getLevel()).toBe(LogLevel.ERROR);
  });

  it('提供 logFile 时应启用文件日志（注意：路径会被构造器的 logDir 派生值覆盖）', () => {
    const logger = createCliLoggerFromOptions({ logFile: '/tmp/test-cli.log' });
    const config = getInternalConfig(logger);

    expect(config.enableFile).toBe(true);
    // 疑似缺陷：options.logFile 传入的 filePath 在 CliLogger 构造器中被
    // enableFile && logDir 分支改写为 logDir 下的默认文件名，此处断言现状。
    expect(config.filePath).toBe(path.join(os.homedir(), '.mcp-knot', 'logs', 'mcp-knot-cli.log'));
  });

  it('未提供 logFile 时不应启用文件日志', () => {
    const logger = createCliLoggerFromOptions({});

    expect(getInternalConfig(logger).enableFile).toBe(false);
  });
});
