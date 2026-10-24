import { ServiceError } from '@mcp-core/mcp-knot-core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ServerStatus } from '../types/mcp-knot.js';
import { logger } from '../utils/logger.js';
import { ToolManager } from './tool_manager.js';

import type { GroupManager, ServerManager, Tool } from '../types/mcp-knot.js';
import type { ApiToolIntegrationService } from './api_tool_integration_service.js';

// Mock the logger
vi.mock('../utils/logger.js');

describe('ToolManager', () => {
  let toolManager: ToolManager;
  let mockServerManager: ServerManager;
  let mockGroupManager: GroupManager;

  const mockTools: Tool[] = [
    {
      name: 'tool1',
      description: 'Test tool 1',
      inputSchema: {
        type: 'object',
        properties: {
          arg1: { type: 'string' },
          arg2: { type: 'number' },
        },
        required: ['arg1'],
      },
      serverId: 'server1',
    },
    {
      name: 'tool2',
      description: 'Test tool 2',
      inputSchema: {
        type: 'object',
        properties: {
          message: { type: 'string' },
        },
        required: ['message'],
      },
      serverId: 'server2',
    },
    {
      name: 'tool3',
      description: 'Test tool 3 with no schema',
      inputSchema: {},
      serverId: 'server1',
    },
  ];

  beforeEach(() => {
    vi.clearAllMocks();

    // Setup mock server manager
    mockServerManager = {
      getAllServers: vi.fn().mockReturnValue(
        new Map([
          [
            'server1',
            {
              id: 'server1',
              status: ServerStatus.CONNECTED,
              tools: [mockTools[0], mockTools[2]],
            },
          ],
          [
            'server2',
            {
              id: 'server2',
              status: ServerStatus.CONNECTED,
              tools: [mockTools[1]],
            },
          ],
          [
            'server3',
            {
              id: 'server3',
              status: ServerStatus.DISCONNECTED,
              tools: [],
            },
          ],
        ]),
      ),
      executeToolOnServer: vi.fn(),
      getServerTools: vi.fn(),
      initialize: vi.fn(),
      getServerStatus: vi.fn(),
      shutdown: vi.fn(),
    };

    // Setup mock group manager
    mockGroupManager = {
      getGroup: vi.fn().mockImplementation((groupId: string) => {
        const groups = {
          default: {
            id: 'default',
            name: 'Default Group',
            servers: ['server1', 'server2'],
            tools: [], // No restrictions
          },
          filtered: {
            id: 'filtered',
            name: 'Filtered Group',
            servers: ['server1'],
            tools: ['tool1'], // Only tool1 allowed
          },
          empty: {
            id: 'empty',
            name: 'Empty Group',
            servers: ['server3'], // Disconnected server
            tools: [],
          },
        };
        return groups[groupId as keyof typeof groups];
      }),
      getAllGroups: vi.fn().mockReturnValue(
        new Map([
          ['default', { id: 'default', servers: ['server1', 'server2'], tools: [] }],
          ['filtered', { id: 'filtered', servers: ['server1'], tools: ['tool1'] }],
        ]),
      ),
      getGroupTools: vi.fn().mockImplementation((groupId: string) => {
        if (groupId === 'default') return Promise.resolve(mockTools);
        if (groupId === 'filtered') return Promise.resolve([mockTools[0]]);
        if (groupId === 'empty') return Promise.resolve([]);
        throw new Error(`Group ${groupId} not found`);
      }),
      validateToolAccess: vi.fn().mockImplementation((groupId: string, toolName: string) => {
        if (groupId === 'filtered') return toolName === 'tool1';
        if (groupId === 'default') return true;
        return false;
      }),
      getGroupServers: vi.fn().mockImplementation((groupId: string) => {
        if (groupId === 'default') return ['server1', 'server2'];
        if (groupId === 'filtered') return ['server1'];
        if (groupId === 'empty') return ['server3'];
        return [];
      }),
      initialize: vi.fn(),
      findToolInGroup: vi.fn(),
      getAvailableGroupServers: vi.fn(),
      getGroupStats: vi.fn(),
      validateGroupHealth: vi.fn(),
      getAllGroupsHealth: vi.fn(),
      getGroupToolsByServer: vi.fn(),
    };

    toolManager = new ToolManager(mockServerManager, mockGroupManager);
  });

  describe('getToolsForGroup', () => {
    it('should return tools for valid group', async () => {
      const tools = await toolManager.getToolsForGroup('default');
      expect(tools).toEqual(mockTools);
      expect(mockGroupManager.getGroupTools).toHaveBeenCalledWith('default');
      expect(vi.mocked(logger.debug)).toHaveBeenCalledWith('Getting tools for group', {
        groupId: 'default',
      });
      expect(vi.mocked(logger.debug)).toHaveBeenCalledWith('Retrieved and cached tools for group', {
        groupId: 'default',
        mcpToolCount: 3,
        apiToolCount: 0,
        totalToolCount: 3,
      });
      expect(vi.mocked(logger.debug)).toHaveBeenCalledWith('Cached tools for group', {
        groupId: 'default',
        toolCount: 3,
      });
    });

    it('should cache tools for subsequent requests', async () => {
      // First call
      await toolManager.getToolsForGroup('default');
      // Second call should use cache
      await toolManager.getToolsForGroup('default');

      // Should only call group manager once
      expect(mockGroupManager.getGroupTools).toHaveBeenCalledTimes(1);
      expect(vi.mocked(logger.debug)).toHaveBeenCalledWith('Returning cached tools for group', {
        groupId: 'default',
        toolCount: 3,
      });
    });

    it('should refresh cache after TTL expires', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(1000));

      // First call
      await toolManager.getToolsForGroup('default');

      // Advance time beyond cache TTL (30 seconds)
      vi.setSystemTime(new Date(32000));

      // Second call should refresh cache
      await toolManager.getToolsForGroup('default');

      expect(mockGroupManager.getGroupTools).toHaveBeenCalledTimes(2);
      expect(vi.mocked(logger.debug)).toHaveBeenCalledWith('Tool cache expired for group', {
        groupId: 'default',
        age: 31000,
      });
    });

    it('should throw error for non-existent group', async () => {
      await expect(toolManager.getToolsForGroup('non-existent')).rejects.toThrow(
        'Group non-existent not found',
      );
    });

    it('should handle group manager errors', async () => {
      vi.mocked(mockGroupManager.getGroupTools).mockRejectedValueOnce(
        new Error('Group manager error'),
      );

      await expect(toolManager.getToolsForGroup('default')).rejects.toThrow('Group manager error');
      expect(vi.mocked(logger.error)).toHaveBeenCalledWith(
        'Failed to get tools for group',
        expect.any(Error),
        { groupId: 'default' },
      );
    });

    it('cache 未命中且无 apiToolService 时不请求 API 工具', async () => {
      const tools = await toolManager.getToolsForGroup('default');
      expect(tools).toEqual(mockTools);
      expect(logger.debug).not.toHaveBeenCalledWith('Retrieved API tools', expect.anything());
      // 无 apiToolService 时不应误入 API 工具降级分支
      expect(logger.warn).not.toHaveBeenCalledWith('Failed to get API tools', expect.anything());
    });
  });

  describe('API tool integration', () => {
    let apiToolManager: ToolManager;
    let mockApiToolService: {
      getApiTools: ReturnType<typeof vi.fn>;
      executeApiTool: ReturnType<typeof vi.fn>;
      isApiTool: ReturnType<typeof vi.fn>;
      getApiToolDefinition: ReturnType<typeof vi.fn>;
    };

    const apiTool: Tool = {
      name: 'api-tool',
      description: 'External API tool',
      inputSchema: { type: 'object' },
      serverId: 'api-tools',
    };

    beforeEach(() => {
      mockApiToolService = {
        getApiTools: vi.fn().mockResolvedValue([]),
        executeApiTool: vi.fn(),
        isApiTool: vi.fn().mockReturnValue(false),
        getApiToolDefinition: vi.fn().mockReturnValue(undefined),
      };
      apiToolManager = new ToolManager(
        mockServerManager,
        mockGroupManager,
        mockApiToolService as unknown as ApiToolIntegrationService,
      );
    });

    it('getToolsForGroup 合并 MCP 工具与 API 工具并缓存', async () => {
      mockApiToolService.getApiTools.mockResolvedValue([apiTool]);

      const tools = await apiToolManager.getToolsForGroup('default');

      expect(tools).toEqual([...mockTools, apiTool]);
      expect(logger.debug).toHaveBeenCalledWith('Retrieved API tools', { count: 1 });

      // 第二次调用命中缓存，getApiTools 不再请求
      await apiToolManager.getToolsForGroup('default');
      expect(mockApiToolService.getApiTools).toHaveBeenCalledTimes(1);
      expect(mockGroupManager.getGroupTools).toHaveBeenCalledTimes(1);
    });

    it('API 工具获取失败时仅返回 MCP 工具并记录警告', async () => {
      mockApiToolService.getApiTools.mockRejectedValue(new Error('api tools unavailable'));

      const tools = await apiToolManager.getToolsForGroup('default');

      expect(tools).toEqual(mockTools);
      expect(logger.warn).toHaveBeenCalledWith('Failed to get API tools', {
        error: 'api tools unavailable',
      });
    });

    it('executeTool 将 API 工具路由到 apiToolService 而非 MCP 服务器', async () => {
      mockApiToolService.isApiTool.mockImplementation((name: string) => name === 'api-tool');
      mockApiToolService.getApiToolDefinition.mockReturnValue(apiTool);
      mockApiToolService.executeApiTool.mockResolvedValue({
        content: [{ type: 'text', text: 'api ok' }],
      });

      const result = await apiToolManager.executeTool('default', 'api-tool', { q: 1 });

      expect(result).toStrictEqual({ content: [{ type: 'text', text: 'api ok' }] });
      expect(mockApiToolService.executeApiTool).toHaveBeenCalledWith('api-tool', { q: 1 });
      expect(mockServerManager.executeToolOnServer).not.toHaveBeenCalled();
      expect(logger.debug).toHaveBeenCalledWith(
        'Tool routing successful (API tool)',
        expect.objectContaining({ serverId: 'api-tools', toolName: 'api-tool' }),
      );
    });

    it('API 工具执行抛错时返回 Unexpected error 结果', async () => {
      mockApiToolService.isApiTool.mockImplementation((name: string) => name === 'api-tool');
      mockApiToolService.getApiToolDefinition.mockReturnValue(apiTool);
      mockApiToolService.executeApiTool.mockRejectedValue(new Error('api boom'));

      const result = await apiToolManager.executeTool('default', 'api-tool', { q: 1 });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toBe('Unexpected error: api boom');
    });

    it('isApiTool 命中但定义缺失时回退到 MCP 路由', async () => {
      mockApiToolService.isApiTool.mockReturnValue(true);
      mockApiToolService.getApiToolDefinition.mockReturnValue(undefined);
      vi.mocked(mockServerManager.executeToolOnServer).mockResolvedValue({
        content: [{ type: 'text', text: 'Success' }],
      });

      const result = await apiToolManager.executeTool('default', 'tool1', { arg1: 'x' });

      expect(result.isError).toBe(false);
      expect(mockServerManager.executeToolOnServer).toHaveBeenCalledWith('server1', 'tool1', {
        arg1: 'x',
      });
    });
  });

  describe('executeTool', () => {
    beforeEach(() => {
      // Setup successful tool execution by default
      vi.mocked(mockServerManager.executeToolOnServer).mockResolvedValue({
        content: [{ type: 'text', text: 'Success' }],
      });
    });

    it('should execute tool successfully', async () => {
      const result = await toolManager.executeTool('default', 'tool1', {
        arg1: 'test',
      });

      expect(result.isError).toBe(false);
      expect(result.content).toEqual([{ type: 'text', text: 'Success' }]);
      expect(mockServerManager.executeToolOnServer).toHaveBeenCalledWith('server1', 'tool1', {
        arg1: 'test',
      });
      expect(vi.mocked(logger.debug)).toHaveBeenCalledWith('Routing tool execution', {
        executionId: expect.any(String),
        groupId: 'default',
        toolName: 'tool1',
      });
      expect(vi.mocked(logger.debug)).toHaveBeenCalledWith('Tool routing successful (MCP tool)', {
        executionId: expect.any(String),
        toolName: 'tool1',
        serverId: 'server1',
        groupId: 'default',
      });
      expect(vi.mocked(logger.info)).toHaveBeenCalledWith('Tool execution completed successfully', {
        executionId: expect.any(String),
        groupId: 'default',
        toolName: 'tool1',
        serverId: 'server1',
      });
    });

    it('should validate group access before execution', async () => {
      const result = await toolManager.executeTool('non-existent', 'tool1', {});

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('not found');
      expect(mockServerManager.executeToolOnServer).not.toHaveBeenCalled();
      expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
        'Group validation failed',
        expect.objectContaining({ groupId: 'non-existent', error: expect.any(String) }),
      );
    });

    it('should validate tool access in group', async () => {
      const result = await toolManager.executeTool('filtered', 'tool2', {});

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('not accessible in group');
      expect(mockServerManager.executeToolOnServer).not.toHaveBeenCalled();
      expect(vi.mocked(logger.warn)).toHaveBeenCalledWith('Tool access denied', {
        executionId: expect.any(String),
        groupId: 'filtered',
        toolName: 'tool2',
      });
    });

    it('should validate tool arguments against schema', async () => {
      const result = await toolManager.executeTool('default', 'tool1', {}); // Missing required arg1

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Missing required argument: arg1');
      expect(mockServerManager.executeToolOnServer).not.toHaveBeenCalled();
      expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
        'Tool argument validation failed',
        expect.objectContaining({
          groupId: 'default',
          toolName: 'tool1',
          error: expect.stringContaining('Missing required argument: arg1'),
        }),
      );
    });

    it('should handle tool execution failures', async () => {
      vi.mocked(mockServerManager.executeToolOnServer).mockRejectedValueOnce(
        new Error('Tool execution failed'),
      );

      const result = await toolManager.executeTool('default', 'tool1', {
        arg1: 'test',
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Tool execution failed after 2 attempts');
      // 首次尝试失败与最终失败日志
      expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
        'Tool execution attempt failed',
        expect.objectContaining({ attempt: 1, maxRetries: 2, error: 'Tool execution failed' }),
      );
    });

    it('should retry on retryable errors', async () => {
      // 使用 mockRejectedValueOnce 和 mockResolvedValueOnce 设置行为
      // 第一次调用失败（retryable error），第二次调用成功
      vi.mocked(mockServerManager.executeToolOnServer)
        .mockRejectedValueOnce(new Error('Connection timeout'))
        .mockResolvedValueOnce({
          content: [{ type: 'text', text: 'Success on retry' }],
        });

      // executeToolWithRetry 中有指数退避延迟，使用 vi.useFakeTimers 加速
      vi.useFakeTimers({ shouldAdvanceTime: true });

      const resultPromise = toolManager.executeTool('default', 'tool1', {
        arg1: 'test',
      });

      // 快速推进所有定时器
      await vi.advanceTimersByTimeAsync(2000);

      const result = await resultPromise;

      expect(result.isError).toBe(false);
      expect(result.content).toEqual([{ type: 'text', text: 'Success on retry' }]);
      expect(mockServerManager.executeToolOnServer).toHaveBeenCalledTimes(2);

      vi.useRealTimers();
    });

    it('should not retry on non-retryable errors', async () => {
      vi.mocked(mockServerManager.executeToolOnServer).mockRejectedValueOnce(
        new Error('Invalid arguments'),
      );

      const result = await toolManager.executeTool('default', 'tool1', {
        arg1: 'test',
      });

      expect(result.isError).toBe(true);
      expect(mockServerManager.executeToolOnServer).toHaveBeenCalledTimes(1);
    });

    it('should handle tools with no schema validation', async () => {
      const result = await toolManager.executeTool('default', 'tool3', {
        anyArg: 'value',
      });

      expect(result.isError).toBe(false);
      expect(mockServerManager.executeToolOnServer).toHaveBeenCalledWith('server1', 'tool3', {
        anyArg: 'value',
      });
    });

    it('executionId 由 groupId、toolName 与时间戳拼成并写入日志', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(1000));

      await toolManager.executeTool('default', 'tool1', { arg1: 'x' });

      expect(vi.mocked(logger.info)).toHaveBeenCalledWith('Starting tool execution', {
        executionId: 'default-tool1-1000',
        groupId: 'default',
        toolName: 'tool1',
        args: { arg1: 'x' },
      });

      vi.useRealTimers();
    });

    it('group 校验失败且未返回错误消息时使用默认 Invalid group 消息', async () => {
      vi.spyOn(toolManager, 'validateGroupAccess').mockResolvedValue({
        isValid: false,
        serverCount: 0,
        toolCount: 0,
      });

      const result = await toolManager.executeTool('default', 'tool1', {});

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toBe("Invalid group 'default'");
      expect(mockServerManager.executeToolOnServer).not.toHaveBeenCalled();
    });

    it('tool 不在 group 的任何 server 上时返回 not found 错误', async () => {
      const result = await toolManager.executeTool('default', 'unknown-tool', {});

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toBe("Tool 'unknown-tool' not found in group 'default'");
      expect(mockServerManager.executeToolOnServer).not.toHaveBeenCalled();
      expect(vi.mocked(logger.warn)).toHaveBeenCalledWith('Tool routing failed', {
        executionId: expect.any(String),
        groupId: 'default',
        toolName: 'unknown-tool',
        error: "Tool 'unknown-tool' not found in group 'default'",
      });
    });

    it('server 不在连接表中时返回 not available (status: not found)', async () => {
      // 第 1 次 getAllServers 供 findToolServer 命中 server1，第 2 次（路由复查）返回空表
      let callCount = 0;
      vi.mocked(mockServerManager.getAllServers).mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          return new Map([
            [
              'server1',
              {
                id: 'server1',
                status: ServerStatus.CONNECTED,
                tools: [mockTools[0]],
              },
            ],
          ]);
        }
        return new Map();
      });

      const result = await toolManager.executeTool('default', 'tool1', { arg1: 'x' });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toBe("Server 'server1' is not available (status: not found)");
      expect(mockServerManager.executeToolOnServer).not.toHaveBeenCalled();
    });

    it('server 在路由复查时已断开时返回 not available (status: disconnected)', async () => {
      let callCount = 0;
      vi.mocked(mockServerManager.getAllServers).mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          return new Map([
            ['server1', { id: 'server1', status: ServerStatus.CONNECTED, tools: [mockTools[0]] }],
          ]);
        }
        return new Map([
          ['server1', { id: 'server1', status: ServerStatus.DISCONNECTED, tools: [mockTools[0]] }],
        ]);
      });

      const result = await toolManager.executeTool('default', 'tool1', { arg1: 'x' });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toBe(
        "Server 'server1' is not available (status: disconnected)",
      );
    });

    it('server 已连接但工具定义缺失时返回 definition not found', async () => {
      let callCount = 0;
      vi.mocked(mockServerManager.getAllServers).mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          return new Map([
            ['server1', { id: 'server1', status: ServerStatus.CONNECTED, tools: [mockTools[0]] }],
          ]);
        }
        return new Map([['server1', { id: 'server1', status: ServerStatus.CONNECTED, tools: [] }]]);
      });

      const result = await toolManager.executeTool('default', 'tool1', { arg1: 'x' });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toBe("Tool 'tool1' definition not found on server 'server1'");
    });

    it('路由过程抛错时返回 Routing failed 结果', async () => {
      let callCount = 0;
      vi.mocked(mockServerManager.getAllServers).mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          return new Map([
            ['server1', { id: 'server1', status: ServerStatus.CONNECTED, tools: [mockTools[0]] }],
          ]);
        }
        throw new Error('servers unavailable');
      });

      const result = await toolManager.executeTool('default', 'tool1', { arg1: 'x' });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toBe('Routing failed: servers unavailable');
      expect(vi.mocked(logger.error)).toHaveBeenCalledWith(
        'Error during tool routing',
        expect.any(Error),
        expect.objectContaining({ groupId: 'default', toolName: 'tool1' }),
      );
    });

    it('validateToolAccess 抛错时返回 Unexpected error 结果', async () => {
      vi.mocked(mockGroupManager.validateToolAccess).mockImplementationOnce(() => {
        throw new Error('access check exploded');
      });

      const result = await toolManager.executeTool('default', 'tool1', { arg1: 'x' });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toBe('Unexpected error: access check exploded');
      expect(vi.mocked(logger.error)).toHaveBeenCalledWith(
        'Unexpected error during tool execution',
        expect.any(Error),
        expect.objectContaining({ groupId: 'default', toolName: 'tool1', args: { arg1: 'x' } }),
      );
    });

    it('retryable 错误连续失败时重试满 2 次并返回精确错误与日志', async () => {
      vi.mocked(mockServerManager.executeToolOnServer).mockRejectedValue(
        new Error('connection refused'),
      );

      const result = await toolManager.executeTool('default', 'tool1', { arg1: 'x' });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toBe(
        'Tool execution failed after 2 attempts: connection refused',
      );
      expect(mockServerManager.executeToolOnServer).toHaveBeenCalledTimes(2);
      expect(vi.mocked(logger.error)).toHaveBeenCalledWith(
        'Tool execution failed after all retries',
        expect.any(Error),
        expect.objectContaining({
          serverId: 'server1',
          toolName: 'tool1',
          maxRetries: 2,
          finalError: 'connection refused',
        }),
      );
    });

    it('首次重试前的退避精确为 1000ms（指数退避第 1 档）', async () => {
      vi.useFakeTimers();
      vi.mocked(mockServerManager.executeToolOnServer)
        .mockRejectedValueOnce(new Error('network unreachable'))
        .mockResolvedValueOnce({ content: [{ type: 'text', text: 'Success on retry' }] });

      const resultPromise = toolManager.executeTool('default', 'tool1', { arg1: 'x' });
      // 触发第一次执行并进入退避等待
      await vi.advanceTimersByTimeAsync(0);
      expect(vi.mocked(logger.debug)).toHaveBeenCalledWith('Waiting before retry', {
        executionId: expect.any(String),
        attempt: 1,
        delay: 1000,
      });

      await vi.advanceTimersByTimeAsync(999);
      expect(mockServerManager.executeToolOnServer).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(1);
      const result = await resultPromise;

      expect(result.isError).toBe(false);
      expect(mockServerManager.executeToolOnServer).toHaveBeenCalledTimes(2);
      expect(vi.mocked(logger.debug)).toHaveBeenCalledWith('Tool execution attempt successful', {
        executionId: expect.any(String),
        serverId: 'server1',
        toolName: 'tool1',
        attempt: 2,
      });

      vi.useRealTimers();
    });

    it('第二次退避精确为 2000ms（指数退避第 2 档，maxRetries=3）', async () => {
      vi.useFakeTimers();
      const retrying = toolManager as unknown as {
        executeToolWithRetry: (
          serverId: string,
          toolName: string,
          args: Record<string, unknown>,
          executionId: string,
          maxRetries: number,
        ) => Promise<{ isError: boolean; content: Array<{ text: string }> }>;
      };
      vi.mocked(mockServerManager.executeToolOnServer)
        .mockRejectedValueOnce(new Error('connection reset'))
        .mockRejectedValueOnce(new Error('connection reset'))
        .mockResolvedValueOnce({ content: [{ type: 'text', text: 'ok' }] });

      const promise = retrying.executeToolWithRetry('server1', 'tool1', { arg1: 'x' }, 'exec-x', 3);
      await vi.advanceTimersByTimeAsync(0); // 第 1 次尝试失败，进入第 1 档退避
      await vi.advanceTimersByTimeAsync(1000); // 第 2 次尝试失败，进入第 2 档退避
      expect(vi.mocked(logger.debug)).toHaveBeenCalledWith('Waiting before retry', {
        executionId: 'exec-x',
        attempt: 2,
        delay: 2000,
      });

      await vi.advanceTimersByTimeAsync(2000);
      const result = await promise;
      expect(result.isError).toBe(false);
      expect(mockServerManager.executeToolOnServer).toHaveBeenCalledTimes(3);

      vi.useRealTimers();
    });

    it('maxRetries=0 时直接返回 Unknown error 结果（lastError 为空）', async () => {
      const retrying = toolManager as unknown as {
        executeToolWithRetry: (
          serverId: string,
          toolName: string,
          args: Record<string, unknown>,
          executionId: string,
          maxRetries: number,
        ) => Promise<{ isError: boolean; content: Array<{ text: string }> }>;
      };

      const result = await retrying.executeToolWithRetry('server1', 'tool1', {}, 'exec-0', 0);

      expect(mockServerManager.executeToolOnServer).not.toHaveBeenCalled();
      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toBe('Tool execution failed after 0 attempts: Unknown error');
      expect(vi.mocked(logger.error)).toHaveBeenCalledWith(
        'Tool execution failed after all retries',
        expect.any(Error),
        expect.objectContaining({
          executionId: 'exec-0',
          serverId: 'server1',
          toolName: 'tool1',
          maxRetries: 0,
          finalError: undefined,
        }),
      );
    });
  });

  describe('findToolServer', () => {
    it('should find server for existing tool', () => {
      const serverId = toolManager.findToolServer('tool1', 'default');
      expect(serverId).toBe('server1');
      expect(vi.mocked(logger.debug)).toHaveBeenCalledWith('Finding server for tool', {
        toolName: 'tool1',
        groupId: 'default',
      });
      expect(vi.mocked(logger.debug)).toHaveBeenCalledWith('Found tool on server', {
        toolName: 'tool1',
        serverId: 'server1',
        groupId: 'default',
      });
    });

    it('should return undefined for non-existent tool', () => {
      const serverId = toolManager.findToolServer('non-existent-tool', 'default');
      expect(serverId).toBeUndefined();
      expect(vi.mocked(logger.debug)).toHaveBeenCalledWith(
        'Tool not found on any server in group',
        {
          toolName: 'non-existent-tool',
          groupId: 'default',
          searchedServers: ['server1', 'server2'],
        },
      );
    });

    it('should return undefined for non-existent group', () => {
      const serverId = toolManager.findToolServer('tool1', 'non-existent');
      expect(serverId).toBeUndefined();
      expect(vi.mocked(logger.debug)).toHaveBeenCalledWith('Group not found', {
        groupId: 'non-existent',
      });
    });

    it('should only search in group servers', () => {
      // tool2 is on server2, but filtered group only has server1
      const serverId = toolManager.findToolServer('tool2', 'filtered');
      expect(serverId).toBeUndefined();
    });

    it('should skip disconnected servers', () => {
      // Mock server3 as having the tool but disconnected
      vi.mocked(mockServerManager.getAllServers).mockReturnValue(
        new Map([
          [
            'server3',
            {
              id: 'server3',
              config: {} as Record<string, unknown>,
              client: {} as Record<string, unknown>,
              status: ServerStatus.DISCONNECTED,
              tools: [{ name: 'tool4', serverId: 'server3', inputSchema: {} }],
              reconnectAttempts: 0,
            },
          ],
        ]),
      );

      vi.mocked(mockGroupManager.getGroupServers).mockReturnValue(['server3']);

      const serverId = toolManager.findToolServer('tool4', 'empty');
      expect(serverId).toBeUndefined();
    });

    it('group 存在但无可用 server 时返回 undefined', () => {
      vi.mocked(mockGroupManager.getGroupServers).mockReturnValue([]);

      const serverId = toolManager.findToolServer('tool1', 'default');
      expect(serverId).toBeUndefined();
      expect(vi.mocked(logger.debug)).toHaveBeenCalledWith('No available servers in group', {
        groupId: 'default',
      });
    });

    it('getAllServers 抛错时跳过该 server 并返回 undefined', () => {
      vi.mocked(mockServerManager.getAllServers).mockImplementation(() => {
        throw new Error('servers map unavailable');
      });

      const serverId = toolManager.findToolServer('tool1', 'default');
      expect(serverId).toBeUndefined();
      expect(logger.warn).toHaveBeenCalledWith(
        'Error checking server for tool',
        expect.objectContaining({ serverId: 'server1', toolName: 'tool1' }),
      );
    });

    it('getGroup 抛错时返回 undefined 并记录错误日志', () => {
      vi.mocked(mockGroupManager.getGroup).mockImplementation(() => {
        throw new Error('group store corrupted');
      });

      const serverId = toolManager.findToolServer('tool1', 'default');
      expect(serverId).toBeUndefined();
      expect(vi.mocked(logger.error)).toHaveBeenCalledWith(
        'Error finding tool server',
        expect.any(Error),
        expect.objectContaining({ toolName: 'tool1', groupId: 'default' }),
      );
    });
  });

  describe('validateToolArgs', () => {
    it('should validate required arguments', () => {
      const isValid = toolManager.validateToolArgs('tool1', {
        arg1: 'test',
        arg2: 123,
      });
      expect(isValid).toBe(true);
    });

    it('should reject missing required arguments', () => {
      const isValid = toolManager.validateToolArgs('tool1', { arg2: 123 }); // Missing arg1
      expect(isValid).toBe(false);
    });

    it('should validate argument types', () => {
      const isValid = toolManager.validateToolArgs('tool1', {
        arg1: 'test',
        arg2: 'not-a-number',
      });
      expect(isValid).toBe(false);
    });

    it('should allow tools with no schema', () => {
      const isValid = toolManager.validateToolArgs('tool3', {
        anyArg: 'value',
      });
      expect(isValid).toBe(true);
    });

    it('should handle non-existent tools gracefully', () => {
      const isValid = toolManager.validateToolArgs('non-existent', {
        arg: 'value',
      });
      expect(isValid).toBe(true); // Should allow and let server handle validation
      expect(vi.mocked(logger.debug)).toHaveBeenCalledWith(
        'Tool definition not found for validation',
        { toolName: 'non-existent' },
      );
    });

    it('schema 校验过程抛错时放行并返回 true', () => {
      // args 为 null 时 schema 校验器内部捕获并放行（不传播到 ToolManager）
      const isValid = toolManager.validateToolArgs(
        'tool1',
        null as unknown as Record<string, unknown>,
      );
      expect(isValid).toBe(true);
    });

    it('工具定义检索抛错时放行并记录 Error validating tool arguments', () => {
      // getAllServers 抛错 → findToolDefinition 抛出 → validateToolArgs 捕获放行
      vi.mocked(mockServerManager.getAllServers).mockImplementation(() => {
        throw new Error('definition lookup exploded');
      });

      const isValid = toolManager.validateToolArgs('tool1', { arg1: 'x' });
      expect(isValid).toBe(true);
      expect(vi.mocked(logger.error)).toHaveBeenCalledWith(
        'Error validating tool arguments',
        expect.any(Error),
        expect.objectContaining({ toolName: 'tool1' }),
      );
    });

    it('优先使用缓存中的工具定义进行校验', async () => {
      // 缓存中的 cached-tool 带必填字段，server 上不存在该工具
      vi.mocked(mockGroupManager.getGroupTools).mockResolvedValueOnce([
        {
          name: 'cached-tool',
          description: 'Only in cache',
          inputSchema: { type: 'object', required: ['must'] },
          serverId: 'server1',
        },
      ]);
      await toolManager.getToolsForGroup('default');

      expect(toolManager.validateToolArgs('cached-tool', {})).toBe(false);
      expect(toolManager.validateToolArgs('cached-tool', { must: 'x' })).toBe(true);
    });
  });

  describe('cache management', () => {
    it('should clear cache for specific group', async () => {
      // Populate cache
      await toolManager.getToolsForGroup('default');
      expect(mockGroupManager.getGroupTools).toHaveBeenCalledTimes(1);

      // Clear cache for group
      toolManager.clearCacheForGroup('default');
      expect(vi.mocked(logger.debug)).toHaveBeenCalledWith('Tool cache cleared for group', {
        groupId: 'default',
      });

      // Next call should hit group manager again
      await toolManager.getToolsForGroup('default');
      expect(mockGroupManager.getGroupTools).toHaveBeenCalledTimes(2);
    });

    it('should clear all cache', async () => {
      // Populate cache for multiple groups
      await toolManager.getToolsForGroup('default');
      await toolManager.getToolsForGroup('filtered');

      // Clear all cache
      toolManager.clearCache();
      expect(vi.mocked(logger.info)).toHaveBeenCalledWith('Tool cache cleared');

      // Next calls should hit group manager again
      await toolManager.getToolsForGroup('default');
      await toolManager.getToolsForGroup('filtered');

      expect(mockGroupManager.getGroupTools).toHaveBeenCalledTimes(4);
    });

    it('should refresh cache for specific group', async () => {
      await toolManager.refreshToolCache('default');
      expect(mockGroupManager.getGroupTools).toHaveBeenCalledWith('default');
      expect(vi.mocked(logger.info)).toHaveBeenCalledWith('Refreshing tool cache for group', {
        groupId: 'default',
      });
      expect(vi.mocked(logger.info)).toHaveBeenCalledWith('Tool cache refreshed for group', {
        groupId: 'default',
      });
    });

    it('should refresh cache for all groups', async () => {
      await toolManager.refreshToolCache();
      // Should refresh cache for all known groups
      expect(mockGroupManager.getGroupTools).toHaveBeenCalledWith('default');
      expect(mockGroupManager.getGroupTools).toHaveBeenCalledWith('filtered');
      expect(vi.mocked(logger.info)).toHaveBeenCalledWith('Refreshing all tool caches');
      expect(vi.mocked(logger.info)).toHaveBeenCalledWith('All tool caches refreshed');
    });

    it('cache 年龄恰好等于 TTL 时仍命中缓存（不含边界刷新）', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(1000));

      await toolManager.getToolsForGroup('default');
      // age = 31000 - 1000 = 30000，恰好等于 CACHE_TTL_MS，不刷新
      vi.setSystemTime(new Date(31000));
      await toolManager.getToolsForGroup('default');

      expect(mockGroupManager.getGroupTools).toHaveBeenCalledTimes(1);
      vi.useRealTimers();
    });

    it('refreshToolCache 指定组刷新失败时向上抛出', async () => {
      vi.mocked(mockGroupManager.getGroupTools).mockRejectedValueOnce(new Error('refresh boom'));

      await expect(toolManager.refreshToolCache('default')).rejects.toThrow('refresh boom');
      expect(vi.mocked(logger.error)).toHaveBeenCalledWith(
        'Failed to refresh cache for group',
        expect.any(Error),
        { groupId: 'default' },
      );
    });

    it('refreshToolCache 全组刷新时单组失败不影响整体', async () => {
      vi.mocked(mockGroupManager.getGroupTools).mockImplementation((groupId: string) => {
        if (groupId === 'default') return Promise.reject(new Error('bulk boom'));
        return Promise.resolve([mockTools[0]]);
      });

      await expect(toolManager.refreshToolCache()).resolves.not.toThrow();
      expect(mockGroupManager.getGroupTools).toHaveBeenCalledTimes(2);
      expect(logger.warn).toHaveBeenCalledWith(
        'Failed to refresh cache for group during bulk refresh',
        expect.objectContaining({ groupId: 'default', error: 'bulk boom' }),
      );
    });

    it('getCacheStats 精确统计多组缓存的 oldest/newest（时间递增写入）', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(1000));
      await toolManager.getToolsForGroup('default'); // 3 tools @ t=1000
      vi.setSystemTime(new Date(6000));
      await toolManager.getToolsForGroup('filtered'); // 1 tool @ t=6000

      const stats = toolManager.getCacheStats();
      expect(stats.totalGroups).toBe(2);
      expect(stats.totalTools).toBe(4);
      expect(stats.oldestCache?.getTime()).toBe(1000);
      expect(stats.newestCache?.getTime()).toBe(6000);

      vi.useRealTimers();
    });

    it('getCacheStats 精确统计多组缓存的 oldest/newest（时间递减写入）', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(6000));
      await toolManager.getToolsForGroup('default'); // 3 tools @ t=6000
      vi.setSystemTime(new Date(1000));
      await toolManager.getToolsForGroup('filtered'); // 1 tool @ t=1000

      const stats = toolManager.getCacheStats();
      expect(stats.oldestCache?.getTime()).toBe(1000);
      expect(stats.newestCache?.getTime()).toBe(6000);

      vi.useRealTimers();
    });

    it('空缓存时 getCacheStats 返回空统计', () => {
      const stats = toolManager.getCacheStats();
      expect(stats).toStrictEqual({
        totalGroups: 0,
        totalTools: 0,
        oldestCache: null,
        newestCache: null,
      });
    });
  });

  describe('tool discovery and aggregation', () => {
    beforeEach(() => {
      vi.mocked(mockServerManager.getServerTools).mockImplementation((serverId: string) => {
        if (serverId === 'server1') return Promise.resolve([mockTools[0], mockTools[2]]);
        if (serverId === 'server2') return Promise.resolve([mockTools[1]]);
        return Promise.resolve([]);
      });
    });

    it('should get tools by server for group', async () => {
      const toolsByServer = await toolManager.getToolsByServer('default');

      expect(toolsByServer).toEqual(
        new Map([
          ['server1', [mockTools[0], mockTools[2]]],
          ['server2', [mockTools[1]]],
        ]),
      );
    });

    it('filtered group 的 getToolsByServer 只保留 group.tools 中列出的工具', async () => {
      const toolsByServer = await toolManager.getToolsByServer('filtered');

      expect(toolsByServer).toEqual(new Map([['server1', [mockTools[0]]]]));
    });

    it('getToolsByServer 对不存在的 group 抛 ServiceError', async () => {
      await expect(toolManager.getToolsByServer('non-existent')).rejects.toThrow(ServiceError);
      await expect(toolManager.getToolsByServer('non-existent')).rejects.toThrow(
        'Group non-existent not found',
      );
      expect(vi.mocked(logger.error)).toHaveBeenCalledWith(
        'Failed to get tools by server for group',
        expect.any(Error),
        { groupId: 'non-existent' },
      );
    });

    it('getToolsByServer 单个 server 获取失败时该 server 记为空数组', async () => {
      vi.mocked(mockServerManager.getServerTools).mockRejectedValueOnce(
        new Error('server tools unavailable'),
      );

      const toolsByServer = await toolManager.getToolsByServer('default');

      expect(toolsByServer.get('server1')).toEqual([]);
      expect(toolsByServer.get('server2')).toEqual([mockTools[1]]);
      expect(logger.warn).toHaveBeenCalledWith(
        'Failed to get tools from server',
        expect.objectContaining({ serverId: 'server1', groupId: 'default' }),
      );
    });

    it('should get available tool names for group', async () => {
      const toolNames = await toolManager.getAvailableToolNames('default');
      expect(toolNames).toEqual(['tool1', 'tool2', 'tool3']);
      expect(vi.mocked(logger.debug)).toHaveBeenCalledWith('Retrieved tool names for group', {
        groupId: 'default',
        toolCount: 3,
        toolNames: ['tool1', 'tool2', 'tool3'],
      });
    });

    it('getAvailableToolNames 获取工具失败时向上抛出', async () => {
      vi.mocked(mockGroupManager.getGroupTools).mockRejectedValueOnce(new Error('names boom'));

      await expect(toolManager.getAvailableToolNames('default')).rejects.toThrow('names boom');
      expect(vi.mocked(logger.error)).toHaveBeenCalledWith(
        'Failed to get tool names for group',
        expect.any(Error),
        { groupId: 'default' },
      );
    });

    it('should check tool availability in group', async () => {
      const isAvailable = await toolManager.isToolAvailableInGroup('default', 'tool1');
      expect(isAvailable).toBe(true);
      expect(vi.mocked(logger.debug)).toHaveBeenCalledWith('Tool availability check result', {
        groupId: 'default',
        toolName: 'tool1',
        isAvailable: true,
        serverId: 'server1',
      });

      const isNotAvailable = await toolManager.isToolAvailableInGroup('filtered', 'tool2');
      expect(isNotAvailable).toBe(false);
      expect(vi.mocked(logger.debug)).toHaveBeenCalledWith(
        'Tool access denied by group policy',
        expect.objectContaining({ groupId: 'filtered', toolName: 'tool2' }),
      );
    });

    it('isToolAvailableInGroup 校验抛错时返回 false', async () => {
      vi.mocked(mockGroupManager.validateToolAccess).mockImplementationOnce(() => {
        throw new Error('availability exploded');
      });

      const isAvailable = await toolManager.isToolAvailableInGroup('default', 'tool1');
      expect(isAvailable).toBe(false);
      expect(vi.mocked(logger.error)).toHaveBeenCalledWith(
        'Error checking tool availability',
        expect.any(Error),
        expect.objectContaining({ groupId: 'default', toolName: 'tool1' }),
      );
    });

    it('should get tool details', async () => {
      const toolDetails = await toolManager.getToolDetails('default', 'tool1');
      expect(toolDetails).toEqual(mockTools[0]);
      expect(vi.mocked(logger.debug)).toHaveBeenCalledWith('Found tool details', {
        groupId: 'default',
        toolName: 'tool1',
        serverId: 'server1',
      });

      const noDetails = await toolManager.getToolDetails('filtered', 'tool2');
      expect(noDetails).toBeNull();
      expect(vi.mocked(logger.debug)).toHaveBeenCalledWith('Tool not available in group', {
        groupId: 'filtered',
        toolName: 'tool2',
      });
    });

    it('getToolDetails 获取工具列表失败时返回 null', async () => {
      vi.mocked(mockGroupManager.getGroupTools).mockRejectedValueOnce(new Error('details boom'));

      const details = await toolManager.getToolDetails('default', 'tool1');
      expect(details).toBeNull();
      expect(vi.mocked(logger.error)).toHaveBeenCalledWith(
        'Error getting tool details',
        expect.any(Error),
        expect.objectContaining({ groupId: 'default', toolName: 'tool1' }),
      );
    });
  });

  describe('group access validation', () => {
    it('should validate group access successfully', async () => {
      const validation = await toolManager.validateGroupAccess('default');
      expect(validation).toStrictEqual({
        isValid: true,
        serverCount: 2,
        toolCount: 3,
      });
    });

    it('should handle non-existent group validation', async () => {
      const validation = await toolManager.validateGroupAccess('non-existent');
      expect(validation).toStrictEqual({
        isValid: false,
        error: "Group 'non-existent' not found",
        serverCount: 0,
        toolCount: 0,
      });
    });

    it('group 存在但无可用 server 时返回 No servers available', async () => {
      vi.mocked(mockGroupManager.getGroupServers).mockReturnValue([]);

      const validation = await toolManager.validateGroupAccess('default');
      expect(validation).toStrictEqual({
        isValid: false,
        error: "No servers available in group 'default'",
        serverCount: 0,
        toolCount: 0,
      });
    });

    it('获取工具失败时返回 Validation failed 错误', async () => {
      vi.mocked(mockGroupManager.getGroupTools).mockRejectedValueOnce(new Error('validation boom'));

      const validation = await toolManager.validateGroupAccess('default');
      expect(validation).toStrictEqual({
        isValid: false,
        error: 'Validation failed: validation boom',
        serverCount: 0,
        toolCount: 0,
      });
      expect(vi.mocked(logger.error)).toHaveBeenCalledWith(
        'Error validating group access',
        expect.any(Error),
        { groupId: 'default' },
      );
    });
  });

  describe('execution health monitoring', () => {
    it('should get execution health status', async () => {
      await toolManager.getToolsForGroup('default');
      await toolManager.getToolsForGroup('filtered');

      const health = await toolManager.getExecutionHealth();

      expect(health.serverHealth).toEqual(
        new Map([
          ['server1', ServerStatus.CONNECTED],
          ['server2', ServerStatus.CONNECTED],
          ['server3', ServerStatus.DISCONNECTED],
        ]),
      );
      expect(health.groupHealth).toEqual(
        new Map([
          ['default', true],
          ['filtered', true],
        ]),
      );
      expect(health.cacheHealth.totalGroups).toBe(2);
      expect(health.cacheHealth.totalTools).toBe(4);
    });

    it('组校验抛错时 groupHealth 对应组记为 false', async () => {
      vi.mocked(mockGroupManager.getGroupTools).mockImplementation((groupId: string) => {
        if (groupId === 'filtered') return Promise.reject(new Error('health boom'));
        return Promise.resolve(mockTools);
      });

      const health = await toolManager.getExecutionHealth();

      expect(health.groupHealth).toEqual(
        new Map([
          ['default', true],
          ['filtered', false],
        ]),
      );
    });

    it('getAllGroups 抛错时 getExecutionHealth 记录错误并向上抛出', async () => {
      vi.mocked(mockGroupManager.getAllGroups).mockImplementation(() => {
        throw new Error('groups exploded');
      });

      await expect(toolManager.getExecutionHealth()).rejects.toThrow('groups exploded');
      expect(vi.mocked(logger.error)).toHaveBeenCalledWith(
        'Error getting execution health',
        expect.any(Error),
      );
    });
  });

  describe('error handling and resilience', () => {
    it('should handle server manager failures gracefully', async () => {
      vi.mocked(mockServerManager.executeToolOnServer).mockRejectedValue(
        new Error('Server manager failure'),
      );

      const result = await toolManager.executeTool('default', 'tool1', {
        arg1: 'test',
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Tool execution failed after 2 attempts');
    });

    it('should handle group manager failures gracefully', async () => {
      vi.mocked(mockGroupManager.getGroupTools).mockRejectedValue(
        new Error('Group manager failure'),
      );

      await expect(toolManager.getToolsForGroup('default')).rejects.toThrow(
        'Group manager failure',
      );
    });

    it('should transform different result formats correctly', async () => {
      // Test string result
      vi.mocked(mockServerManager.executeToolOnServer).mockResolvedValueOnce(
        'Simple string result',
      );
      let result = await toolManager.executeTool('default', 'tool1', {
        arg1: 'test',
      });
      expect(result.content[0].text).toBe('Simple string result');

      // Test number result
      vi.mocked(mockServerManager.executeToolOnServer).mockResolvedValueOnce(42);
      result = await toolManager.executeTool('default', 'tool1', {
        arg1: 'test',
      });
      expect(result.content[0].text).toBe('42');

      // Test object result
      vi.mocked(mockServerManager.executeToolOnServer).mockResolvedValueOnce({
        key: 'value',
      });
      result = await toolManager.executeTool('default', 'tool1', {
        arg1: 'test',
      });
      expect(result.content[0].text).toContain('key');
      expect(result.content[0].text).toContain('value');

      // Test null result
      vi.mocked(mockServerManager.executeToolOnServer).mockResolvedValueOnce(null);
      result = await toolManager.executeTool('default', 'tool1', {
        arg1: 'test',
      });
      expect(result.content[0].text).toBe('null');
    });

    it('should handle argument validation edge cases', () => {
      // Test with null values in required fields
      const isValid1 = toolManager.validateToolArgs('tool1', { arg1: null });
      expect(isValid1).toBe(false);

      // Test with undefined values in required fields
      const isValid2 = toolManager.validateToolArgs('tool1', {
        arg1: undefined,
      });
      expect(isValid2).toBe(false);

      // Test with additional properties when not allowed
      const toolWithStrictSchema = {
        name: 'strict-tool',
        inputSchema: {
          type: 'object',
          properties: { arg1: { type: 'string' } },
          additionalProperties: false,
        },
      };

      // Mock finding this tool by replacing the private method temporarily
      const originalFindTool = (
        toolManager as { findToolDefinition: (...args: unknown[]) => unknown }
      ).findToolDefinition.bind(toolManager);
      Object.defineProperty(toolManager, 'findToolDefinition', {
        value: vi.fn().mockReturnValue(toolWithStrictSchema),
        writable: true,
        configurable: true,
      });

      const isValid3 = toolManager.validateToolArgs('strict-tool', {
        arg1: 'test',
        extraArg: 'not allowed',
      });
      expect(isValid3).toBe(false);

      // Restore original method
      Object.defineProperty(toolManager, 'findToolDefinition', {
        value: originalFindTool,
        writable: true,
        configurable: true,
      });
    });
  });
});
