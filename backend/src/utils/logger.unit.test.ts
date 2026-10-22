import { LogLevel } from '@mcp-core/mcp-knot-share';
/**
 * ConsoleLogger 测试
 * mock createMcpLogger，验证各方法向统一日志器的委托与参数封装
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ConsoleLogger } from './logger.js';

const mcpLoggerMock = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  logServerConnection: vi.fn(),
  logToolDiscovery: vi.fn(),
  logToolExecution: vi.fn(),
  logConfigReload: vi.fn(),
}));

const createMcpLogger = vi.hoisted(() => vi.fn(() => mcpLoggerMock));

vi.mock('@mcp-core/mcp-knot-share', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mcp-core/mcp-knot-share')>();
  return { ...actual, createMcpLogger };
});

describe('ConsoleLogger', () => {
  let consoleLogger: ConsoleLogger;

  beforeEach(() => {
    vi.clearAllMocks();
    consoleLogger = new ConsoleLogger();
  });

  it('默认以 INFO 级别、Backend 组件创建统一日志器', () => {
    expect(createMcpLogger).toHaveBeenCalledWith({
      level: LogLevel.INFO,
      component: 'Backend',
    });
  });

  it('支持指定最低日志级别', () => {
    new ConsoleLogger(LogLevel.DEBUG);

    expect(createMcpLogger).toHaveBeenLastCalledWith({
      level: LogLevel.DEBUG,
      component: 'Backend',
    });
  });

  it('debug 委托并包装 context', () => {
    consoleLogger.debug('调试信息', { key: 'value' });

    expect(mcpLoggerMock.debug).toHaveBeenCalledWith('调试信息', { context: { key: 'value' } });
  });

  it('info 委托并包装 context', () => {
    consoleLogger.info('一般信息', { key: 'value' });

    expect(mcpLoggerMock.info).toHaveBeenCalledWith('一般信息', { context: { key: 'value' } });
  });

  it('warn 委托并包装 context', () => {
    consoleLogger.warn('警告信息', { key: 'value' });

    expect(mcpLoggerMock.warn).toHaveBeenCalledWith('警告信息', { context: { key: 'value' } });
  });

  it('error 委托时传递错误对象并包装 context', () => {
    const error = new Error('出错了');
    consoleLogger.error('错误信息', error, { code: 'E1' });

    expect(mcpLoggerMock.error).toHaveBeenCalledWith('错误信息', error, {
      context: { code: 'E1' },
    });
  });

  it('logServerConnection 原样委托 MCP 专用参数', () => {
    consoleLogger.logServerConnection('server-1', 'connected', { region: 'cn' });

    expect(mcpLoggerMock.logServerConnection).toHaveBeenCalledWith('server-1', 'connected', {
      region: 'cn',
    });
  });

  it('logToolDiscovery 原样委托', () => {
    consoleLogger.logToolDiscovery('server-1', 42);

    expect(mcpLoggerMock.logToolDiscovery).toHaveBeenCalledWith('server-1', 42, undefined);
  });

  it('logToolExecution 原样委托', () => {
    consoleLogger.logToolExecution('search', 'group-1', 'failed');

    expect(mcpLoggerMock.logToolExecution).toHaveBeenCalledWith(
      'search',
      'group-1',
      'failed',
      undefined,
    );
  });

  it('logConfigReload 原样委托', () => {
    consoleLogger.logConfigReload(['mcp_server.json'], { by: 'admin' });

    expect(mcpLoggerMock.logConfigReload).toHaveBeenCalledWith(['mcp_server.json'], {
      by: 'admin',
    });
  });
});
