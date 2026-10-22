import { beforeAll, describe, expect, it, vi } from 'vitest';

import {
  ErrorCode,
  ERROR_MESSAGES,
  ERROR_SEVERITY,
  ErrorSeverity,
  ErrorCategory,
  McpKnotCoreError,
  ServiceError,
  UnifiedErrorHandler,
  getHttpStatusForError,
} from './index.js';

const { loggerSpies, mockCreateLogger } = vi.hoisted(() => {
  const mockCreateLogger = vi.fn();
  const loggerSpies = { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
  mockCreateLogger.mockReturnValue(loggerSpies);
  return { loggerSpies, mockCreateLogger };
});

vi.mock('../utils/logger.js', () => ({
  createLogger: mockCreateLogger,
}));

describe('模块级 logger 初始化', () => {
  // clearMocks 会在每个用例前清空调用记录，模块加载期的调用只能在 beforeAll 中断言
  beforeAll(() => {
    expect(mockCreateLogger).toHaveBeenCalledTimes(1);
    expect(mockCreateLogger).toHaveBeenCalledWith({ component: 'ErrorHandler' });
  });

  it('应该以 ErrorHandler 组件名创建 logger', () => {
    expect(mockCreateLogger).not.toBeNull();
  });
});

describe('ERROR_MESSAGES 全量中文消息映射', () => {
  const expected: Array<[ErrorCode, string]> = [
    // 配置错误
    [ErrorCode.INVALID_SERVER_CONFIG, '服务器配置无效'],
    [ErrorCode.MISSING_GROUP_REFERENCE, '缺少组引用'],
    [ErrorCode.SCHEMA_VALIDATION_FAILED, '配置架构验证失败'],
    [ErrorCode.CONFIG_FILE_NOT_FOUND, '配置文件未找到'],
    [ErrorCode.INVALID_CONFIG_FORMAT, '配置文件格式无效'],
    // 连接错误
    [ErrorCode.SERVER_STARTUP_FAILED, '服务器启动失败'],
    [ErrorCode.NETWORK_CONNECTIVITY_FAILED, '网络连接失败'],
    [ErrorCode.AUTHENTICATION_FAILED, '身份验证失败'],
    [ErrorCode.SERVER_UNAVAILABLE, '服务器不可用'],
    [ErrorCode.CONNECTION_TIMEOUT, '连接超时'],
    [ErrorCode.CONNECTION_REFUSED, '连接被拒绝'],
    // 运行时错误
    [ErrorCode.TOOL_EXECUTION_FAILED, '工具执行失败'],
    [ErrorCode.SERVER_DISCONNECTED, '服务器连接断开'],
    [ErrorCode.INVALID_TOOL_ARGUMENTS, '工具参数无效'],
    [ErrorCode.TOOL_NOT_FOUND, '工具未找到'],
    [ErrorCode.GROUP_NOT_FOUND, '组未找到'],
    [ErrorCode.TOOL_ACCESS_DENIED, '工具访问被拒绝'],
    [ErrorCode.SERVICE_UNAVAILABLE, '服务不可用'],
    // 验证错误
    [ErrorCode.INVALID_REQUEST_FORMAT, '请求格式无效'],
    [ErrorCode.MISSING_REQUIRED_PARAMETER, '缺少必需参数'],
    [ErrorCode.PARAMETER_TYPE_MISMATCH, '参数类型不匹配'],
    [ErrorCode.INVALID_PARAMETER_VALUE, '参数值无效'],
    // 系统错误
    [ErrorCode.INTERNAL_SERVER_ERROR, '内部服务器错误'],
    [ErrorCode.MEMORY_LIMIT_EXCEEDED, '内存限制超出'],
    [ErrorCode.TIMEOUT_ERROR, '操作超时'],
    [ErrorCode.UNKNOWN_ERROR, '未知错误'],
    // 认证错误
    [ErrorCode.AUTH_INVALID_CREDENTIALS, '用户名或密码无效'],
    [ErrorCode.AUTH_TOKEN_EXPIRED, '认证令牌已过期'],
    [ErrorCode.AUTH_TOKEN_INVALID, '认证令牌无效'],
    [ErrorCode.AUTH_ACCESS_DENIED, '访问被拒绝'],
    [ErrorCode.AUTH_ACCOUNT_LOCKED, '账户已被锁定'],
    // OAuth 入站错误
    [ErrorCode.OAUTH_MISSING_TOKEN, '缺少 OAuth 令牌'],
    [ErrorCode.OAUTH_INVALID_TOKEN, 'OAuth 令牌无效'],
    [ErrorCode.OAUTH_TOKEN_EXPIRED, 'OAuth 令牌已过期'],
    [ErrorCode.OAUTH_INVALID_AUDIENCE, 'OAuth 令牌受众不匹配'],
    [ErrorCode.OAUTH_INSUFFICIENT_SCOPE, 'OAuth 权限范围不足'],
    [ErrorCode.OAUTH_SERVER_ERROR, 'OAuth 服务错误'],
    [ErrorCode.OAUTH_CONFIG_ERROR, 'OAuth 配置错误'],
    // OAuth 出站错误
    [ErrorCode.OAUTH_OUTBOUND_CONFIG_INVALID, 'OAuth 出站配置无效'],
    [ErrorCode.OAUTH_OUTBOUND_TOKEN_FETCH_FAILED, 'OAuth 出站 token 获取失败'],
    [ErrorCode.OAUTH_OUTBOUND_TOKEN_EXPIRED, 'OAuth 出站 token 已过期'],
    [ErrorCode.OAUTH_OUTBOUND_ENV_VAR_MISSING, 'OAuth 出站环境变量未定义'],
  ];

  for (const [code, message] of expected) {
    it(`${code} →「${message}」`, () => {
      expect(ERROR_MESSAGES[code]).toBe(message);
      // 构造器未传 message 时应回落到该表
      expect(new McpKnotCoreError(code).message).toBe(message);
    });
  }
});

describe('错误类别分段判定（getCategory 边界）', () => {
  const cases: Array<[number, ErrorCategory]> = [
    [1000, ErrorCategory.CONFIGURATION],
    [1999, ErrorCategory.CONFIGURATION],
    [2000, ErrorCategory.CONNECTION],
    [2999, ErrorCategory.CONNECTION],
    [3000, ErrorCategory.RUNTIME],
    [3999, ErrorCategory.RUNTIME],
    [4000, ErrorCategory.VALIDATION],
    [4999, ErrorCategory.VALIDATION],
    [5000, ErrorCategory.SYSTEM],
    [5999, ErrorCategory.SYSTEM],
    [6000, ErrorCategory.RUNTIME],
    [6999, ErrorCategory.RUNTIME],
    [7000, ErrorCategory.RUNTIME],
    [7999, ErrorCategory.RUNTIME],
    [8000, ErrorCategory.SYSTEM],
    [9999, ErrorCategory.SYSTEM],
  ];

  for (const [code, category] of cases) {
    it(`code ${code} → ${category}`, () => {
      expect(new McpKnotCoreError(code as ErrorCode).category).toBe(category);
    });
  }

  it('未知 code 的消息与严重程度走兜底值', () => {
    const error = new McpKnotCoreError(9999 as ErrorCode);
    expect(error.message).toBe('未知错误');
    expect(error.severity).toBe(ErrorSeverity.MEDIUM);
  });
});

describe('UnifiedErrorHandler 日志输出', () => {
  it('注入 logger 时应传递精确消息与结构化日志数据', () => {
    const injectedLogger = vi.fn();
    const handler = new UnifiedErrorHandler(injectedLogger);

    handler.logError(new Error('boom'), { operation: 'op', component: 'Comp' });

    expect(injectedLogger).toHaveBeenCalledTimes(1);
    const [message, logData] = injectedLogger.mock.calls[0];
    expect(message).toBe('[Comp] op 失败');
    expect(logData.error.name).toBe('Error');
    expect(logData.error.message).toBe('boom');
    expect(logData.error.stack).toBeTypeOf('string');
    expect(logData.context).toEqual({ operation: 'op', component: 'Comp' });
    expect(logData.timestamp).toBeTypeOf('string');
  });

  it('未注入 logger 时应回落到全局 logger.error', () => {
    loggerSpies.error.mockClear();
    const handler = new UnifiedErrorHandler();
    const error = new McpKnotCoreError(ErrorCode.TOOL_NOT_FOUND, '工具未找到');

    handler.logError(error, { operation: 'callTool', component: 'ToolManager' });

    expect(loggerSpies.error).toHaveBeenCalledTimes(1);
    const [message, secondArg, thirdArg] = loggerSpies.error.mock.calls[0];
    expect(message).toBe('[ToolManager] callTool 失败');
    expect(secondArg).toBeUndefined();
    const logData = (thirdArg as { context: { logData: Record<string, unknown> } }).context.logData;
    expect(logData.error).toEqual({
      name: 'McpKnotCoreError',
      message: '工具未找到',
      stack: error.stack,
    });
    expect(logData.context).toEqual({ operation: 'callTool', component: 'ToolManager' });
    expect(logData.timestamp).toBeTypeOf('string');
  });
});

describe('P3 出站 OAuth 错误码', () => {
  it('6200-6203 错误码已定义', () => {
    expect(ErrorCode.OAUTH_OUTBOUND_CONFIG_INVALID).toBe(6200);
    expect(ErrorCode.OAUTH_OUTBOUND_TOKEN_FETCH_FAILED).toBe(6201);
    expect(ErrorCode.OAUTH_OUTBOUND_TOKEN_EXPIRED).toBe(6202);
    expect(ErrorCode.OAUTH_OUTBOUND_ENV_VAR_MISSING).toBe(6203);
  });

  it('每个错误码都有严重程度', () => {
    expect(ERROR_SEVERITY[ErrorCode.OAUTH_OUTBOUND_CONFIG_INVALID]).toBe(ErrorSeverity.LOW);
    expect(ERROR_SEVERITY[ErrorCode.OAUTH_OUTBOUND_TOKEN_FETCH_FAILED]).toBe(ErrorSeverity.HIGH);
    expect(ERROR_SEVERITY[ErrorCode.OAUTH_OUTBOUND_TOKEN_EXPIRED]).toBe(ErrorSeverity.HIGH);
    expect(ERROR_SEVERITY[ErrorCode.OAUTH_OUTBOUND_ENV_VAR_MISSING]).toBe(ErrorSeverity.LOW);
  });
});

describe('API-to-MCP 错误码段 (7000-7499)', () => {
  it('7001 CONFIG_ERROR 三表映射正确', () => {
    expect(ErrorCode.API_TO_MCP_CONFIG_ERROR).toBe(7001);
    expect(ERROR_MESSAGES[ErrorCode.API_TO_MCP_CONFIG_ERROR]).toBe('API-to-MCP 配置错误');
    expect(ERROR_SEVERITY[ErrorCode.API_TO_MCP_CONFIG_ERROR]).toBe(ErrorSeverity.HIGH);
    expect(getHttpStatusForError(ErrorCode.API_TO_MCP_CONFIG_ERROR)).toBe(500);
  });
  it('7002 BUILD_FAILED 三表映射正确', () => {
    expect(ErrorCode.API_TO_MCP_BUILD_FAILED).toBe(7002);
    expect(ERROR_MESSAGES[ErrorCode.API_TO_MCP_BUILD_FAILED]).toBe('API-to-MCP 请求构建失败');
    expect(ERROR_SEVERITY[ErrorCode.API_TO_MCP_BUILD_FAILED]).toBe(ErrorSeverity.MEDIUM);
    expect(getHttpStatusForError(ErrorCode.API_TO_MCP_BUILD_FAILED)).toBe(400);
  });
  it('7003 EXECUTION_FAILED 三表映射正确', () => {
    expect(ErrorCode.API_TO_MCP_EXECUTION_FAILED).toBe(7003);
    expect(ERROR_MESSAGES[ErrorCode.API_TO_MCP_EXECUTION_FAILED]).toBe('API-to-MCP 执行失败');
    expect(ERROR_SEVERITY[ErrorCode.API_TO_MCP_EXECUTION_FAILED]).toBe(ErrorSeverity.MEDIUM);
    expect(getHttpStatusForError(ErrorCode.API_TO_MCP_EXECUTION_FAILED)).toBe(502);
  });
  it('7004 INTERNAL 三表映射正确', () => {
    expect(ErrorCode.API_TO_MCP_INTERNAL).toBe(7004);
    expect(ERROR_MESSAGES[ErrorCode.API_TO_MCP_INTERNAL]).toBe('API-to-MCP 内部错误');
    expect(ERROR_SEVERITY[ErrorCode.API_TO_MCP_INTERNAL]).toBe(ErrorSeverity.HIGH);
    expect(getHttpStatusForError(ErrorCode.API_TO_MCP_INTERNAL)).toBe(500);
  });
  it('7000 段归类为 RUNTIME', () => {
    const err = new ServiceError(ErrorCode.API_TO_MCP_INTERNAL);
    expect(err.category).toBe(ErrorCategory.RUNTIME);
  });
});
