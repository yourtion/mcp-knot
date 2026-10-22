/**
 * 错误处理器测试
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ConfigError,
  ConnectionError,
  ErrorCategory,
  ErrorCode,
  type ErrorContext,
  ErrorFactory,
  ErrorSeverity,
  type FallbackStrategy,
  McpKnotCoreError,
  ServiceError,
  ToolExecutionError,
  UnifiedErrorHandler,
  ValidationError,
  AuthError,
} from './index';

describe('UnifiedErrorHandler', () => {
  let errorHandler: UnifiedErrorHandler;
  let mockLogger: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockLogger = vi.fn();
    errorHandler = new UnifiedErrorHandler(mockLogger);
  });

  describe('handleError', () => {
    it('应该正确处理 McpKnotCoreError', () => {
      const error = new McpKnotCoreError(
        ErrorCode.TOOL_NOT_FOUND,
        '工具未找到',
        { toolName: 'test-tool' },
        { serverId: 'server1' },
      );
      const context: ErrorContext = {
        operation: 'callTool',
        component: 'ToolManager',
      };

      const response = errorHandler.handleError(error, context);

      expect(response.success).toBe(false);
      expect(response.error.code).toBe(ErrorCode.TOOL_NOT_FOUND);
      expect(response.error.message).toBe('工具未找到');
      expect(response.error.category).toBe(ErrorCategory.RUNTIME);
      expect(response.error.severity).toBe(ErrorSeverity.LOW);
      expect(mockLogger).toHaveBeenCalled();
    });

    it('应该正确处理普通 Error', () => {
      const error = new Error('普通错误');
      const context: ErrorContext = {
        operation: 'test',
        component: 'TestComponent',
      };

      const response = errorHandler.handleError(error, context);

      expect(response.success).toBe(false);
      expect(response.error.code).toBe(ErrorCode.UNKNOWN_ERROR);
      expect(response.error.message).toBe('普通错误');
      expect(response.error.category).toBe(ErrorCategory.SYSTEM);
      expect(response.error.severity).toBe(ErrorSeverity.HIGH);
    });
  });

  describe('shouldRetry', () => {
    it('应该对可重试错误返回 true', () => {
      const error = new ConnectionError(ErrorCode.CONNECTION_TIMEOUT);
      expect(errorHandler.shouldRetry(error)).toBe(true);
    });

    it('应该对不可重试错误返回 false', () => {
      const error = new ConfigError(ErrorCode.INVALID_SERVER_CONFIG);
      expect(errorHandler.shouldRetry(error)).toBe(false);
    });

    it('应该对普通错误返回 false', () => {
      const error = new Error('普通错误');
      expect(errorHandler.shouldRetry(error)).toBe(false);
    });
  });

  describe('executeWithRetry', () => {
    it('应该在第一次成功时直接返回结果', async () => {
      const operation = vi.fn().mockResolvedValue('success');
      const context: ErrorContext = {
        operation: 'test',
        component: 'TestComponent',
      };

      const result = await errorHandler.executeWithRetry(operation, context);

      expect(result).toBe('success');
      expect(operation).toHaveBeenCalledTimes(1);
    });

    it('应该在可重试错误时进行重试', async () => {
      const operation = vi
        .fn()
        .mockRejectedValueOnce(new ConnectionError(ErrorCode.CONNECTION_TIMEOUT))
        .mockRejectedValueOnce(new ConnectionError(ErrorCode.CONNECTION_TIMEOUT))
        .mockResolvedValue('success');

      const context: ErrorContext = {
        operation: 'test',
        component: 'TestComponent',
      };

      const result = await errorHandler.executeWithRetry(operation, context, {
        maxAttempts: 3,
        baseDelay: 10, // 减少测试时间
      });

      expect(result).toBe('success');
      expect(operation).toHaveBeenCalledTimes(3);
    });

    it('应该在达到最大重试次数后抛出错误', async () => {
      const error = new ConnectionError(ErrorCode.CONNECTION_TIMEOUT);
      const operation = vi.fn().mockRejectedValue(error);
      const context: ErrorContext = {
        operation: 'test',
        component: 'TestComponent',
      };

      await expect(
        errorHandler.executeWithRetry(operation, context, {
          maxAttempts: 2,
          baseDelay: 10,
        }),
      ).rejects.toThrow(error);

      expect(operation).toHaveBeenCalledTimes(2);
    });

    it('应该在不可重试错误时立即抛出', async () => {
      const error = new ConfigError(ErrorCode.INVALID_SERVER_CONFIG);
      const operation = vi.fn().mockRejectedValue(error);
      const context: ErrorContext = {
        operation: 'test',
        component: 'TestComponent',
      };

      await expect(errorHandler.executeWithRetry(operation, context)).rejects.toThrow(error);

      expect(operation).toHaveBeenCalledTimes(1);
    });

    it('应该按指数退避计算延迟并在日志中记录 attempt 与 delay', async () => {
      const operation = vi
        .fn()
        .mockRejectedValueOnce(new ConnectionError(ErrorCode.CONNECTION_TIMEOUT))
        .mockRejectedValueOnce(new ConnectionError(ErrorCode.CONNECTION_TIMEOUT))
        .mockResolvedValue('success');
      const context: ErrorContext = {
        operation: 'test',
        component: 'TestComponent',
        metadata: { traceId: 't-1' },
      };

      await errorHandler.executeWithRetry(operation, context, {
        maxAttempts: 3,
        baseDelay: 10,
        backoffMultiplier: 2,
        maxDelay: 10000,
      });

      const retryCalls = mockLogger.mock.calls.filter(([, logData]) =>
        String(logData?.error?.message ?? '').startsWith('重试第'),
      );
      expect(retryCalls.map(([, logData]) => logData.error.message)).toEqual([
        '重试第 1 次失败，10ms 后重试',
        '重试第 2 次失败，20ms 后重试',
      ]);
      // 日志消息使用 [component] operation 失败 格式
      expect(retryCalls[0][0]).toBe('[TestComponent] test 失败');
      // metadata 应保留原字段并附带 attempt/delay
      expect(retryCalls[0][1].context.metadata).toEqual({ traceId: 't-1', attempt: 1, delay: 10 });
      expect(retryCalls[1][1].context.metadata).toEqual({ traceId: 't-1', attempt: 2, delay: 20 });
    });

    it('最后一次尝试失败后应立即抛出，不再记录重试日志', async () => {
      const operation = vi
        .fn()
        .mockRejectedValue(new ConnectionError(ErrorCode.CONNECTION_TIMEOUT));
      const context: ErrorContext = {
        operation: 'test',
        component: 'TestComponent',
      };

      await expect(
        errorHandler.executeWithRetry(operation, context, { maxAttempts: 2, baseDelay: 10 }),
      ).rejects.toThrow();

      expect(operation).toHaveBeenCalledTimes(2);
      const retryCalls = mockLogger.mock.calls.filter(([, logData]) =>
        String(logData?.error?.message ?? '').startsWith('重试第'),
      );
      expect(retryCalls).toHaveLength(1);
    });

    it('maxAttempts 为 0 时应直接抛出兜底错误', async () => {
      const operation = vi.fn().mockResolvedValue('success');
      const context: ErrorContext = {
        operation: 'test',
        component: 'TestComponent',
      };

      await expect(
        errorHandler.executeWithRetry(operation, context, { maxAttempts: 0 }),
      ).rejects.toThrow('Operation failed after retries');

      expect(operation).not.toHaveBeenCalled();
    });

    it('重试之间应真实等待 sleep 时长', async () => {
      vi.useFakeTimers();
      try {
        const operation = vi
          .fn()
          .mockRejectedValueOnce(new ConnectionError(ErrorCode.CONNECTION_TIMEOUT))
          .mockResolvedValue('success');
        const context: ErrorContext = {
          operation: 'test',
          component: 'TestComponent',
        };

        const promise = errorHandler.executeWithRetry(operation, context, {
          maxAttempts: 2,
          baseDelay: 5000,
          maxDelay: 10000,
        });

        await vi.advanceTimersByTimeAsync(0);
        // 第一次失败后处于 sleep(5000) 中，不应执行第二次
        expect(operation).toHaveBeenCalledTimes(1);

        await vi.advanceTimersByTimeAsync(5000);
        await expect(promise).resolves.toBe('success');
        expect(operation).toHaveBeenCalledTimes(2);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('executeWithFallback', () => {
    it('应该在操作成功时返回结果', async () => {
      const operation = vi.fn().mockResolvedValue('success');
      const context: ErrorContext = {
        operation: 'test',
        component: 'TestComponent',
      };
      const fallbackStrategy: FallbackStrategy = {
        enabled: true,
        fallbackValue: 'fallback',
      };

      const result = await errorHandler.executeWithFallback(operation, context, fallbackStrategy);

      expect(result).toBe('success');
      expect(operation).toHaveBeenCalledTimes(1);
    });

    it('应该在操作失败且启用降级时返回降级值', async () => {
      const failure = new Error('操作失败');
      const operation = vi.fn().mockRejectedValue(failure);
      const context: ErrorContext = {
        operation: 'test',
        component: 'TestComponent',
        metadata: { traceId: 't-9' },
      };
      const fallbackStrategy: FallbackStrategy = {
        enabled: true,
        fallbackValue: 'fallback',
      };

      const result = await errorHandler.executeWithFallback(operation, context, fallbackStrategy);

      expect(result).toBe('fallback');
      expect(mockLogger).toHaveBeenCalledTimes(1);
      const [message, logData] = mockLogger.mock.calls[0];
      expect(message).toBe('[TestComponent] test 失败');
      expect(logData.error.message).toBe('操作失败，使用降级策略');
      expect(logData.context.metadata).toEqual({ traceId: 't-9', originalError: failure });
    });

    it('应该在操作失败且启用降级函数时调用降级函数', async () => {
      const operation = vi.fn().mockRejectedValue(new Error('操作失败'));
      const context: ErrorContext = {
        operation: 'test',
        component: 'TestComponent',
      };
      const fallbackFunction = vi.fn().mockReturnValue('function-fallback');
      const fallbackStrategy: FallbackStrategy = {
        enabled: true,
        fallbackFunction,
      };

      const result = await errorHandler.executeWithFallback(operation, context, fallbackStrategy);

      expect(result).toBe('function-fallback');
      expect(fallbackFunction).toHaveBeenCalled();
    });

    it('应该在操作失败且未启用降级时抛出错误', async () => {
      const error = new Error('操作失败');
      const operation = vi.fn().mockRejectedValue(error);
      const context: ErrorContext = {
        operation: 'test',
        component: 'TestComponent',
      };
      const fallbackStrategy: FallbackStrategy = {
        enabled: false,
      };

      await expect(
        errorHandler.executeWithFallback(operation, context, fallbackStrategy),
      ).rejects.toThrow(error);
    });
  });

  describe('formatSuccessResponse', () => {
    it('应该正确格式化成功响应', () => {
      const data = { result: 'test' };
      const response = errorHandler.formatSuccessResponse(data);

      expect(response.success).toBe(true);
      expect(response.data).toEqual(data);
      expect(response.timestamp).toBeDefined();
    });
  });

  describe('formatErrorResponse', () => {
    it('普通 Error 应填充 originalError 与 context 精简信息', () => {
      const response = errorHandler.formatErrorResponse(new TypeError('类型错误'), {
        operation: 'op',
        component: 'Comp',
      });

      expect(response.success).toBe(false);
      expect(response.error.code).toBe(ErrorCode.UNKNOWN_ERROR);
      expect(response.error.message).toBe('类型错误');
      expect(response.error.details).toEqual({ originalError: 'TypeError' });
      expect(response.error.context).toEqual({ operation: 'op', component: 'Comp' });
    });

    it('普通 Error 无 context 时 error.context 应为 undefined', () => {
      const response = errorHandler.formatErrorResponse(new TypeError('类型错误'));

      expect(response.error.context).toBeUndefined();
    });

    it('应该透传 requestId', () => {
      const response = errorHandler.formatErrorResponse(
        new McpKnotCoreError(ErrorCode.UNKNOWN_ERROR),
        { operation: 'op', component: 'Comp' },
        'req-42',
      );

      expect(response.requestId).toBe('req-42');
    });
  });
});

describe('ErrorFactory', () => {
  it('应该创建配置错误', () => {
    const error = ErrorFactory.createConfigError(
      ErrorCode.INVALID_SERVER_CONFIG,
      '自定义消息',
      { detail: 'test' },
      { context: 'test' },
    );

    expect(error).toBeInstanceOf(ConfigError);
    expect(error.code).toBe(ErrorCode.INVALID_SERVER_CONFIG);
    expect(error.message).toBe('自定义消息');
    expect(error.details).toEqual({ detail: 'test' });
    expect(error.context).toEqual({ context: 'test' });
  });

  it('应该创建连接错误', () => {
    const error = ErrorFactory.createConnectionError(ErrorCode.CONNECTION_TIMEOUT);

    expect(error).toBeInstanceOf(ConnectionError);
    expect(error.code).toBe(ErrorCode.CONNECTION_TIMEOUT);
    expect(error.message).toBe('连接超时');
  });

  it('应该创建服务错误', () => {
    const error = ErrorFactory.createServiceError(ErrorCode.SERVICE_UNAVAILABLE);

    expect(error).toBeInstanceOf(Error);
    expect(error.code).toBe(ErrorCode.SERVICE_UNAVAILABLE);
  });

  it('应该创建工具执行错误', () => {
    const error = ErrorFactory.createToolExecutionError(ErrorCode.TOOL_EXECUTION_FAILED);

    expect(error).toBeInstanceOf(Error);
    expect(error.code).toBe(ErrorCode.TOOL_EXECUTION_FAILED);
  });

  it('应该创建验证错误', () => {
    const error = ErrorFactory.createValidationError(ErrorCode.INVALID_REQUEST_FORMAT);

    expect(error).toBeInstanceOf(Error);
    expect(error.code).toBe(ErrorCode.INVALID_REQUEST_FORMAT);
  });

  it('应该创建认证错误', () => {
    const error = ErrorFactory.createAuthError(
      ErrorCode.AUTH_ACCESS_DENIED,
      '自定义认证消息',
      { reason: 'forbidden' },
      { requestId: 'r-1' },
    );

    expect(error).toBeInstanceOf(AuthError);
    expect(error).toBeInstanceOf(McpKnotCoreError);
    expect(error.name).toBe('AuthError');
    expect(error.code).toBe(ErrorCode.AUTH_ACCESS_DENIED);
    expect(error.message).toBe('自定义认证消息');
    expect(error.details).toEqual({ reason: 'forbidden' });
    expect(error.context).toEqual({ requestId: 'r-1' });
    expect(error.severity).toBe(ErrorSeverity.HIGH);
  });
});

describe('错误子类的 name 与类别', () => {
  const cases = [
    { factory: () => new ConfigError(ErrorCode.INVALID_SERVER_CONFIG), name: 'ConfigError' },
    { factory: () => new ConnectionError(ErrorCode.CONNECTION_REFUSED), name: 'ConnectionError' },
    { factory: () => new ServiceError(ErrorCode.SERVICE_UNAVAILABLE), name: 'ServiceError' },
    {
      factory: () => new ToolExecutionError(ErrorCode.TOOL_EXECUTION_FAILED),
      name: 'ToolExecutionError',
    },
    {
      factory: () => new ValidationError(ErrorCode.PARAMETER_TYPE_MISMATCH),
      name: 'ValidationError',
    },
    { factory: () => new AuthError(ErrorCode.AUTH_TOKEN_INVALID), name: 'AuthError' },
  ];

  for (const { factory, name } of cases) {
    it(`${name} 的 name 与 instanceof 应正确`, () => {
      const error = factory();
      expect(error.name).toBe(name);
      expect(error).toBeInstanceOf(McpKnotCoreError);
      expect(error).toBeInstanceOf(Error);
      expect(error.toJSON().name).toBe(name);
    });
  }
});

describe('McpKnotCoreError', () => {
  it('应该正确设置错误属性', () => {
    const error = new McpKnotCoreError(
      ErrorCode.TOOL_NOT_FOUND,
      '自定义消息',
      { toolName: 'test' },
      { serverId: 'server1' },
    );

    expect(error.code).toBe(ErrorCode.TOOL_NOT_FOUND);
    expect(error.message).toBe('自定义消息');
    expect(error.category).toBe(ErrorCategory.RUNTIME);
    expect(error.severity).toBe(ErrorSeverity.LOW);
    expect(error.details).toEqual({ toolName: 'test' });
    expect(error.context).toEqual({ serverId: 'server1' });
    expect(error.timestamp).toBeInstanceOf(Date);
  });

  it('应该使用默认错误消息', () => {
    const error = new McpKnotCoreError(ErrorCode.TOOL_NOT_FOUND);

    expect(error.message).toBe('工具未找到');
  });

  it('空字符串 message 应回落到错误码默认消息', () => {
    const error = new McpKnotCoreError(ErrorCode.CONFIG_FILE_NOT_FOUND, '');

    expect(error.message).toBe('配置文件未找到');
  });

  it('应该正确转换为JSON', () => {
    const error = new McpKnotCoreError(
      ErrorCode.TOOL_NOT_FOUND,
      '自定义消息',
      { toolName: 'test' },
      { serverId: 'server1' },
    );

    const json = error.toJSON();

    expect(json.name).toBe('McpKnotCoreError');
    expect(json.code).toBe(ErrorCode.TOOL_NOT_FOUND);
    expect(json.message).toBe('自定义消息');
    expect(json.category).toBe(ErrorCategory.RUNTIME);
    expect(json.severity).toBe(ErrorSeverity.LOW);
    expect(json.details).toEqual({ toolName: 'test' });
    expect(json.context).toEqual({ serverId: 'server1' });
    expect(json.timestamp).toBeDefined();
    expect(json.stack).toBeDefined();
  });
});
