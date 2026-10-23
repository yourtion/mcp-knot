/**
 * MCP协议处理器单元测试
 */

import { UnifiedLogger } from '@mcp-core/mcp-knot-share';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { McpErrorCode, McpProtocolHandler } from './mcp-protocol-handler';

import type { McpServiceManager } from '@mcp-core/mcp-knot-core';

// Mock核心服务管理器
const mockCoreService = {
  getAllTools: vi.fn(),
  isToolAvailable: vi.fn(),
  executeToolCall: vi.fn(),
  getServiceStatus: vi.fn(),
} as unknown as McpServiceManager;

describe('McpProtocolHandler', () => {
  let handler: McpProtocolHandler;

  beforeEach(() => {
    handler = new McpProtocolHandler(mockCoreService);
    vi.clearAllMocks();
  });

  describe('handleListTools', () => {
    it('应该成功返回工具列表', async () => {
      const mockTools = [
        {
          name: 'test_tool_1',
          description: '测试工具1',
          serverId: 'server1',
        },
        {
          name: 'test_tool_2',
          description: '测试工具2',
          serverId: 'server2',
        },
      ];

      vi.mocked(mockCoreService.getAllTools).mockResolvedValue(mockTools);

      const result = await handler.handleListTools();

      expect(result.tools).toHaveLength(2);
      expect(result.tools[0]).toEqual({
        name: 'test_tool_1',
        description: '测试工具1',
        inputSchema: {
          type: 'object',
          properties: {},
          additionalProperties: true,
        },
      });
      expect(result.tools[1]).toEqual({
        name: 'test_tool_2',
        description: '测试工具2',
        inputSchema: {
          type: 'object',
          properties: {},
          additionalProperties: true,
        },
      });
    });

    it('应该为没有描述的工具生成默认描述', async () => {
      const mockTools = [
        {
          name: 'test_tool',
          description: '',
          serverId: 'server1',
        },
      ];

      vi.mocked(mockCoreService.getAllTools).mockResolvedValue(mockTools);

      const result = await handler.handleListTools();

      expect(result.tools[0].description).toBe('来自服务器 server1 的工具');
    });
  });

  describe('validateCallToolParams', () => {
    it('应该验证有效的参数', () => {
      const params = {
        name: 'test_tool',
        arguments: { param1: 'value1' },
      };

      const result = handler.validateCallToolParams(params);

      expect(result.toolName).toBe('test_tool');
      expect(result.args).toEqual({ param1: 'value1' });
    });

    it('应该在参数不是对象时抛出错误', () => {
      expect(() => handler.validateCallToolParams(null)).toThrow('请求参数无效：参数必须是对象');
      expect(() => handler.validateCallToolParams('string')).toThrow(
        '请求参数无效：参数必须是对象',
      );
    });

    it('应该在缺少工具名称时抛出错误', () => {
      const params = { arguments: {} };

      expect(() => handler.validateCallToolParams(params)).toThrow(
        '请求参数无效：缺少工具名称或工具名称不是字符串',
      );
    });

    it('应该在工具名称不是字符串时抛出错误', () => {
      const params = { name: 123, arguments: {} };

      expect(() => handler.validateCallToolParams(params)).toThrow(
        '请求参数无效：缺少工具名称或工具名称不是字符串',
      );
    });
  });

  describe('getStatus', () => {
    it('应该返回协议处理器状态', () => {
      const mockServiceStatus = {
        initialized: true,
        serverCount: 2,
        activeConnections: 2,
      };

      vi.mocked(mockCoreService.getServiceStatus).mockReturnValue(mockServiceStatus);

      const status = handler.getStatus();

      expect(status.coreServiceStatus).toEqual(mockServiceStatus);
      expect(status.supportedMethods).toEqual(['tools/list', 'tools/call']);
      expect(status.errorCodes).toContain(McpErrorCode.TOOL_NOT_FOUND);
    });

    it('errorCodes 应完整列出全部协议错误码', () => {
      vi.mocked(mockCoreService.getServiceStatus).mockReturnValue({});

      const status = handler.getStatus();

      // 注意：Object.values 作用于数字枚举时会同时包含反向映射的键名，
      // 这里按现状断言（见报告中的疑似问题）。
      expect(status.errorCodes).toEqual([
        McpErrorCode.INVALID_REQUEST,
        'INVALID_REQUEST',
        McpErrorCode.METHOD_NOT_FOUND,
        'METHOD_NOT_FOUND',
        McpErrorCode.INVALID_PARAMS,
        'INVALID_PARAMS',
        McpErrorCode.INTERNAL_ERROR,
        'INTERNAL_ERROR',
        McpErrorCode.TOOL_NOT_FOUND,
        'TOOL_NOT_FOUND',
        McpErrorCode.TOOL_EXECUTION_FAILED,
        'TOOL_EXECUTION_FAILED',
      ]);
    });
  });

  describe('handleCallTool 响应格式', () => {
    beforeEach(() => {
      vi.mocked(mockCoreService.isToolAvailable).mockResolvedValue(true);
    });

    it('对象数据应序列化为格式化 JSON 文本', async () => {
      vi.mocked(mockCoreService.executeToolCall).mockResolvedValue({
        success: true,
        data: { result: 'success' },
        executionTime: 100,
      });

      const result = await handler.handleCallTool('test_tool', {});

      expect(result).toEqual({
        content: [{ type: 'text', text: '{\n  "result": "success"\n}' }],
        isError: false,
      });
    });

    it('字符串数据应原样返回', async () => {
      vi.mocked(mockCoreService.executeToolCall).mockResolvedValue({
        success: true,
        data: 'hello',
        executionTime: 10,
      });

      const result = await handler.handleCallTool('test_tool', {});

      expect(result.content[0].text).toBe('hello');
      expect(result.isError).toBe(false);
    });

    it('null/undefined 数据应返回默认成功文案', async () => {
      vi.mocked(mockCoreService.executeToolCall).mockResolvedValue({
        success: true,
        data: null,
        executionTime: 10,
      });
      expect((await handler.handleCallTool('test_tool', {})).content[0].text).toBe('操作成功完成');

      vi.mocked(mockCoreService.executeToolCall).mockResolvedValue({
        success: true,
        data: undefined,
        executionTime: 10,
      });
      expect((await handler.handleCallTool('test_tool', {})).content[0].text).toBe('操作成功完成');
    });

    it('失败结果带 error 时应输出含工具名与错误的文本', async () => {
      vi.mocked(mockCoreService.executeToolCall).mockResolvedValue({
        success: false,
        error: '执行失败',
      });

      const result = await handler.handleCallTool('test_tool', {});

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toBe("工具 'test_tool' 执行失败: 执行失败");
    });

    it('失败结果不带 error 时应回退到默认失败文案', async () => {
      vi.mocked(mockCoreService.executeToolCall).mockResolvedValue({
        success: false,
      });

      const result = await handler.handleCallTool('test_tool', {});

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toBe("工具 'test_tool' 执行失败: 工具执行失败");
    });
  });

  describe('handleCallTool 错误分类', () => {
    it('工具不存在时应抛出 TOOL_NOT_FOUND 且不被二次包装', async () => {
      vi.mocked(mockCoreService.isToolAvailable).mockResolvedValue(false);

      const error = await handler
        .handleCallTool('missing_tool', {})
        .catch((e: Error & { code?: number; data?: unknown }) => e);

      expect(error.code).toBe(McpErrorCode.TOOL_NOT_FOUND);
      expect(error.message).toBe("工具 'missing_tool' 未找到");
      expect(error.data).toEqual({ toolName: 'missing_tool' });
    });

    it('普通执行异常应包装为 TOOL_EXECUTION_FAILED 并保留原始信息', async () => {
      vi.mocked(mockCoreService.isToolAvailable).mockResolvedValue(true);
      vi.mocked(mockCoreService.executeToolCall).mockRejectedValue(new Error('执行异常'));

      const error = await handler
        .handleCallTool('test_tool', {})
        .catch((e: Error & { code?: number; data?: unknown }) => e);

      expect(error.code).toBe(McpErrorCode.TOOL_EXECUTION_FAILED);
      expect(error.message).toBe('工具执行失败: 执行异常');
      expect(error.data).toEqual({ toolName: 'test_tool', originalError: '执行异常' });
    });

    it('非 Error 的抛出物也应被包装为 TOOL_EXECUTION_FAILED', async () => {
      vi.mocked(mockCoreService.isToolAvailable).mockResolvedValue(true);
      vi.mocked(mockCoreService.executeToolCall).mockRejectedValue('字符串错误');

      const error = await handler
        .handleCallTool('test_tool', {})
        .catch((e: Error & { code?: number }) => e);

      expect(error).toBeInstanceOf(Error);
      expect(error.code).toBe(McpErrorCode.TOOL_EXECUTION_FAILED);
    });

    it('带非数字 code 的 Error 不视为 MCP 错误，应重新包装', async () => {
      vi.mocked(mockCoreService.isToolAvailable).mockResolvedValue(true);
      const rawError = new Error('boom') as Error & { code: string };
      rawError.code = 'STRING_CODE';
      vi.mocked(mockCoreService.executeToolCall).mockRejectedValue(rawError);

      const error = await handler
        .handleCallTool('test_tool', {})
        .catch((e: Error & { code?: unknown }) => e);

      expect(error.code).toBe(McpErrorCode.TOOL_EXECUTION_FAILED);
      expect(error.message).toBe('工具执行失败: boom');
    });
  });

  describe('handleProtocolError 精确输出', () => {
    it('MCP 错误应输出原始错误码与消息', () => {
      const error = new Error("工具 'x' 未找到") as Error & { code: McpErrorCode };
      error.code = McpErrorCode.TOOL_NOT_FOUND;

      const result = handler.handleProtocolError(error);

      expect(result).toEqual({
        content: [{ type: 'text', text: "协议错误 (-32000): 工具 'x' 未找到" }],
        isError: true,
      });
    });

    it('普通 Error 应回退到 INTERNAL_ERROR 错误码', () => {
      const result = handler.handleProtocolError(new Error('普通错误'));

      expect(result.content[0].text).toBe('协议错误 (-32603): 普通错误');
      expect(result.isError).toBe(true);
    });

    it('非 Error 输入应输出未知错误文案', () => {
      const result = handler.handleProtocolError('string error');

      expect(result.content[0].text).toBe('协议错误 (-32603): 未知错误');
    });
  });

  describe('调试与错误日志', () => {
    it('handleListTools 应记录处理与返回日志', async () => {
      const debugSpy = vi.spyOn(UnifiedLogger.prototype, 'debug').mockImplementation(() => {});
      vi.mocked(mockCoreService.getAllTools).mockResolvedValue([
        { name: 't1', description: 'd1', serverId: 's1' },
        { name: 't2', description: 'd2', serverId: 's2' },
      ]);

      await handler.handleListTools();

      expect(debugSpy).toHaveBeenCalledWith('处理list_tools请求');
      expect(debugSpy).toHaveBeenCalledWith('返回 2 个工具');
    });

    it('handleListTools 失败应输出 console.error 并携带原始错误', async () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const failure = new Error('获取失败');
      vi.mocked(mockCoreService.getAllTools).mockRejectedValue(failure);

      const error = await handler
        .handleListTools()
        .catch((e: Error & { code?: number; data?: unknown }) => e);

      expect(consoleSpy).toHaveBeenCalledWith('处理list_tools请求失败:', failure);
      expect(error.code).toBe(McpErrorCode.INTERNAL_ERROR);
      expect(error.message).toBe('获取工具列表失败');
      expect(error.data).toEqual({ originalError: '获取失败' });
    });

    it('handleCallTool 应记录请求与完成日志', async () => {
      const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
      vi.mocked(mockCoreService.isToolAvailable).mockResolvedValue(true);
      vi.mocked(mockCoreService.executeToolCall).mockResolvedValue({
        success: true,
        data: 'ok',
        executionTime: 42,
      });

      await handler.handleCallTool('test_tool', { a: 1 });

      expect(debugSpy).toHaveBeenCalledWith('处理call_tool请求', {
        toolName: 'test_tool',
        args: { a: 1 },
      });
      expect(debugSpy).toHaveBeenCalledWith('工具调用完成', {
        toolName: 'test_tool',
        success: true,
        executionTime: 42,
      });
    });

    it('handleCallTool 失败应输出 console.error', async () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const failure = new Error('执行异常');
      vi.mocked(mockCoreService.isToolAvailable).mockResolvedValue(true);
      vi.mocked(mockCoreService.executeToolCall).mockRejectedValue(failure);

      await handler.handleCallTool('test_tool', {}).catch(() => {});

      expect(consoleSpy).toHaveBeenCalledWith('处理call_tool请求失败:', failure);
    });

    it('handleProtocolError 应输出 console.error', () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const failure = new Error('boom');

      handler.handleProtocolError(failure);

      expect(consoleSpy).toHaveBeenCalledWith('MCP协议错误:', failure);
    });
  });
});
