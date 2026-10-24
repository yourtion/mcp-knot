/**
 * API工具注册表测试
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { logger } from '../../utils/logger.js';
import { ApiToolRegistry } from './api-tool-registry.js';

import type { ApiToolConfig } from '../types/api-config.js';
import type { McpTool } from '../types/api-tool.js';

vi.mock('../../utils/logger.js', () => ({
  logger: {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

function createTestTool(overrides?: Partial<McpTool>): McpTool {
  return {
    name: 'test-tool',
    description: 'A test tool for unit testing',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query' },
      },
      required: ['query'],
    },
    ...overrides,
  };
}

function createTestConfig(overrides?: Partial<ApiToolConfig>): ApiToolConfig {
  return {
    id: 'test-tool',
    name: 'test-tool',
    description: 'A test tool config',
    api: {
      url: 'https://api.example.com/v1/search',
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
    },
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query' },
      },
    },
    response: {},
    ...overrides,
  };
}

describe('ApiToolRegistry', () => {
  let registry: ApiToolRegistry;
  let mockTool: McpTool;
  let mockConfig: ApiToolConfig;

  beforeEach(() => {
    registry = new ApiToolRegistry();

    mockTool = {
      name: 'test-tool',
      description: '测试工具',
      inputSchema: {
        type: 'object',
        properties: {
          param1: {
            type: 'string',
            description: '参数1',
          },
        },
        required: ['param1'],
      },
    };

    mockConfig = {
      id: 'test-tool',
      name: '测试工具',
      description: '这是一个测试工具',
      api: {
        url: 'https://api.example.com/test',
        method: 'GET',
      },
      parameters: {
        type: 'object',
        properties: {
          param1: {
            type: 'string',
            description: '参数1',
          },
        },
        required: ['param1'],
      },
      response: {},
    };
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // ---------------------------------------------------------------
  // registerTool
  // ---------------------------------------------------------------
  describe('registerTool', () => {
    it('应该成功注册有效的工具', () => {
      const result = registry.registerTool(mockTool, mockConfig);

      expect(result.valid).toBe(true);
      expect(result.errors).toEqual([]);
      expect(registry.hasTool('test-tool')).toBe(true);
      expect(registry.getToolCount()).toBe(1);
      expect(vi.mocked(logger.debug)).toHaveBeenCalledWith('注册API工具', {
        context: { toolId: 'test-tool' },
      });
      expect(vi.mocked(logger.info)).toHaveBeenCalledWith('工具注册成功', {
        context: { toolId: 'test-tool', description: '测试工具' },
      });
    });

    it('应该接受包含下划线和连字符的名称', () => {
      const tool = { ...mockTool, name: 'valid_tool-1' };
      const result = registry.registerTool(tool, mockConfig);

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('应该拒绝纯空白名称的工具', () => {
      const result = registry.registerTool({ ...mockTool, name: '   ' }, mockConfig);

      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.code === 'INVALID_TOOL_NAME')).toBe(true);
      expect(registry.getToolCount()).toBe(0);
    });

    it('应该拒绝非字符串名称的工具', () => {
      const result = registry.registerTool(
        { ...mockTool, name: 123 as unknown as string },
        mockConfig,
      );

      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.code === 'INVALID_TOOL_NAME')).toBe(true);
    });

    it('应该拒绝以特殊字符开头的名称', () => {
      const result = registry.registerTool({ ...mockTool, name: '!bad' }, mockConfig);

      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.code === 'INVALID_TOOL_NAME_FORMAT')).toBe(true);
    });

    it('应该拒绝非字符串描述的工具', () => {
      const result = registry.registerTool(
        { ...mockTool, description: 123 as unknown as string },
        mockConfig,
      );

      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.code === 'INVALID_TOOL_DESCRIPTION')).toBe(true);
    });

    it('应该拒绝非对象 inputSchema 的工具', () => {
      const result = registry.registerTool(
        { ...mockTool, inputSchema: 123 as unknown as McpTool['inputSchema'] },
        mockConfig,
      );

      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.code === 'INVALID_INPUT_SCHEMA')).toBe(true);
    });

    it('无效工具应同时报告所有验证错误', () => {
      const result = registry.registerTool(
        {
          name: '',
          description: '',
          inputSchema: undefined as unknown as McpTool['inputSchema'],
        },
        mockConfig,
      );

      expect(result.valid).toBe(false);
      expect(result.errors).toHaveLength(3);
      expect(result.errors.map((e) => e.code)).toEqual([
        'INVALID_TOOL_NAME',
        'INVALID_TOOL_DESCRIPTION',
        'INVALID_INPUT_SCHEMA',
      ]);
      expect(vi.mocked(logger.warn)).toHaveBeenCalledWith('工具注册失败：验证不通过', {
        context: { toolId: '', errors: result.errors },
      });
    });

    it('应该拒绝空名称的工具并返回 INVALID_TOOL_NAME 错误码', () => {
      const invalidTool = {
        name: '',
        description: '有描述',
        inputSchema: { type: 'object' as const, properties: {} },
      };

      const result = registry.registerTool(invalidTool, mockConfig);

      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors.some((e) => e.path === 'name')).toBe(true);
      expect(result.errors.some((e) => e.code === 'INVALID_TOOL_NAME')).toBe(true);
      expect(registry.getToolCount()).toBe(0);
    });

    it('应该拒绝包含特殊字符名称的工具并返回 INVALID_TOOL_NAME_FORMAT 错误码', () => {
      const invalidTool = {
        name: 'bad tool!@#',
        description: '有描述',
        inputSchema: { type: 'object' as const, properties: {} },
      };

      const result = registry.registerTool(invalidTool, mockConfig);

      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.code === 'INVALID_TOOL_NAME_FORMAT')).toBe(true);
    });

    it('应该拒绝缺少描述的工具并返回 INVALID_TOOL_DESCRIPTION 错误码', () => {
      const invalidTool = {
        name: 'valid-name',
        description: '',
        inputSchema: { type: 'object' as const, properties: {} },
      };

      const result = registry.registerTool(invalidTool, mockConfig);

      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.path === 'description')).toBe(true);
      expect(result.errors.some((e) => e.code === 'INVALID_TOOL_DESCRIPTION')).toBe(true);
    });

    it('应该拒绝缺少 inputSchema 的工具并返回 INVALID_INPUT_SCHEMA 错误码', () => {
      const invalidTool = {
        name: 'valid-name',
        description: '有描述',
        inputSchema: undefined as unknown as McpTool['inputSchema'],
      };

      const result = registry.registerTool(invalidTool, mockConfig);

      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.path === 'inputSchema')).toBe(true);
      expect(result.errors.some((e) => e.code === 'INVALID_INPUT_SCHEMA')).toBe(true);
    });

    it('应该拒绝 inputSchema 类型错误的工具并返回 INVALID_SCHEMA_TYPE 错误码', () => {
      const invalidTool = {
        name: 'valid-name',
        description: '有描述',
        inputSchema: { type: 'string' } as unknown as McpTool['inputSchema'],
      };

      const result = registry.registerTool(invalidTool, mockConfig);

      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.path === 'inputSchema.type')).toBe(true);
      expect(result.errors.some((e) => e.code === 'INVALID_SCHEMA_TYPE')).toBe(true);
    });

    it('应该更新已存在的工具', () => {
      registry.registerTool(mockTool, mockConfig);
      expect(registry.getToolCount()).toBe(1);

      const updatedTool = { ...mockTool, description: '更新后的测试工具' };
      const result = registry.registerTool(updatedTool, mockConfig);

      expect(result.valid).toBe(true);
      expect(registry.getToolCount()).toBe(1);
      expect(registry.getTool('test-tool')?.description).toBe('更新后的测试工具');
    });

    it('应该在达到 MAX_TOOLS 限制时拒绝新注册', () => {
      // Fill to max limit (1000)
      for (let i = 0; i < 1000; i++) {
        const t: McpTool = {
          name: `tool-${i}`,
          description: `Tool ${i}`,
          inputSchema: { type: 'object', properties: {} },
        };
        const c: ApiToolConfig = {
          ...mockConfig,
          id: `tool-${i}`,
          name: `tool-${i}`,
        };
        registry.registerTool(t, c);
      }
      expect(registry.getToolCount()).toBe(1000);

      const overflowTool: McpTool = {
        name: 'overflow-tool',
        description: 'Overflow',
        inputSchema: { type: 'object', properties: {} },
      };
      const overflowConfig: ApiToolConfig = {
        ...mockConfig,
        id: 'overflow-tool',
        name: 'overflow-tool',
      };

      const result = registry.registerTool(overflowTool, overflowConfig);

      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.code === 'MAX_TOOLS_EXCEEDED')).toBe(true);
      expect(result.errors[0].message).toBe('已达到最大工具数量限制 (1000)');
      expect(vi.mocked(logger.warn)).toHaveBeenCalledWith('工具注册失败：已达到最大工具数量限制', {
        context: { toolId: 'overflow-tool', currentSize: 1000, maxSize: 1000 },
      });
    });

    it('注册数量超过90%限制时应该输出接近上限警告', () => {
      for (let i = 0; i < 901; i++) {
        const t: McpTool = {
          name: `tool-${i}`,
          description: `Tool ${i}`,
          inputSchema: { type: 'object', properties: {} },
        };
        registry.registerTool(t, { ...mockConfig, id: `tool-${i}`, name: `tool-${i}` });
      }

      expect(vi.mocked(logger.warn)).toHaveBeenCalledWith('API工具注册表接近大小限制', {
        context: { currentSize: 901, maxSize: 1000, usagePercent: '90.1%' },
      });
    });

    it('应该在满载时允许更新已有工具', () => {
      for (let i = 0; i < 1000; i++) {
        const t: McpTool = {
          name: `tool-${i}`,
          description: `Tool ${i}`,
          inputSchema: { type: 'object', properties: {} },
        };
        const c: ApiToolConfig = {
          ...mockConfig,
          id: `tool-${i}`,
          name: `tool-${i}`,
        };
        registry.registerTool(t, c);
      }

      const updatedTool: McpTool = {
        name: 'tool-0',
        description: 'Updated tool 0',
        inputSchema: { type: 'object', properties: {} },
      };
      const result = registry.registerTool(updatedTool, mockConfig);

      expect(result.valid).toBe(true);
      expect(registry.getTool('tool-0')?.description).toBe('Updated tool 0');
    });

    it('应该在新注册时触发 added 事件', () => {
      const eventListener = vi.fn();
      registry.addEventListener(eventListener);

      registry.registerTool(mockTool, mockConfig);

      expect(eventListener).toHaveBeenCalledOnce();
      const event = eventListener.mock.calls[0][0];
      expect(event.type).toBe('added');
      expect(event.toolId).toBe('test-tool');
      expect(event.tool).toBe(mockTool);
      expect(event.timestamp).toBeInstanceOf(Date);
    });

    it('应该在更新时触发 updated 事件', () => {
      const eventListener = vi.fn();

      registry.registerTool(mockTool, mockConfig);
      registry.addEventListener(eventListener);

      const updatedTool = { ...mockTool, description: '更新后的工具' };
      registry.registerTool(updatedTool, mockConfig);

      expect(eventListener).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'updated',
          toolId: 'test-tool',
          tool: updatedTool,
        }),
      );
    });
  });

  // ---------------------------------------------------------------
  // registerTools (batch)
  // ---------------------------------------------------------------
  describe('registerTools', () => {
    it('应该全部成功批量注册', () => {
      const tool2: McpTool = {
        name: 'test-tool-2',
        description: '第二个测试工具',
        inputSchema: { type: 'object', properties: {} },
      };
      const config2: ApiToolConfig = { ...mockConfig, id: 'test-tool-2', name: '第二个测试工具' };

      const result = registry.registerTools([
        { tool: mockTool, config: mockConfig },
        { tool: tool2, config: config2 },
      ]);

      expect(result.successful).toBe(2);
      expect(result.failed).toBe(0);
      expect(result.errors).toEqual([]);
      expect(registry.getToolCount()).toBe(2);
      expect(vi.mocked(logger.info)).toHaveBeenCalledWith('批量注册API工具', {
        context: { count: 2 },
      });
      expect(vi.mocked(logger.info)).toHaveBeenCalledWith('批量注册完成', {
        context: { successful: 2, failed: 0, total: 2 },
      });
    });

    it('应该处理混合有效和无效工具的批量注册', () => {
      const invalidTool: McpTool = {
        name: '',
        description: '',
        inputSchema: { type: 'object', properties: {} },
      };
      const invalidConfig: ApiToolConfig = { ...mockConfig, id: '', name: '' };

      const result = registry.registerTools([
        { tool: mockTool, config: mockConfig },
        { tool: invalidTool, config: invalidConfig },
      ]);

      expect(result.successful).toBe(1);
      expect(result.failed).toBe(1);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].toolId).toBe('');
      expect(result.errors[0].error).toBeTruthy();
      expect(registry.getToolCount()).toBe(1);
    });

    it('应该处理全部失败的批量注册', () => {
      const invalidTool1: McpTool = {
        name: '',
        description: '有描述',
        inputSchema: { type: 'object', properties: {} },
      };
      const invalidTool2: McpTool = {
        name: 'bad!name',
        description: '',
        inputSchema: { type: 'object', properties: {} },
      };

      const result = registry.registerTools([
        { tool: invalidTool1, config: mockConfig },
        { tool: invalidTool2, config: mockConfig },
      ]);

      expect(result.successful).toBe(0);
      expect(result.failed).toBe(2);
      expect(result.errors).toHaveLength(2);
      expect(registry.getToolCount()).toBe(0);
    });
  });

  // ---------------------------------------------------------------
  // unregisterTool
  // ---------------------------------------------------------------
  describe('unregisterTool', () => {
    beforeEach(() => {
      registry.registerTool(mockTool, mockConfig);
    });

    it('应该成功注销存在的工具', () => {
      const result = registry.unregisterTool('test-tool');

      expect(result).toBe(true);
      expect(registry.hasTool('test-tool')).toBe(false);
      expect(registry.getToolCount()).toBe(0);
      expect(registry.getTool('test-tool')).toBeUndefined();
      expect(registry.getToolConfig('test-tool')).toBeUndefined();
    });

    it('应该对不存在的工具返回 false', () => {
      const result = registry.unregisterTool('non-existent-tool');

      expect(result).toBe(false);
      expect(registry.getToolCount()).toBe(1);
      expect(vi.mocked(logger.warn)).toHaveBeenCalledWith('工具注销失败：工具不存在', {
        context: { toolId: 'non-existent-tool' },
      });
    });

    it('注销成功应记录日志', () => {
      registry.unregisterTool('test-tool');

      expect(vi.mocked(logger.info)).toHaveBeenCalledWith('工具注销成功', {
        context: { toolId: 'test-tool' },
      });
    });

    it('应该触发 removed 事件', () => {
      const eventListener = vi.fn();
      registry.addEventListener(eventListener);

      registry.unregisterTool('test-tool');

      expect(eventListener).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'removed',
          toolId: 'test-tool',
          tool: mockTool,
        }),
      );
    });
  });

  // ---------------------------------------------------------------
  // getTool / getToolConfig / getAllTools / getAllToolIds / hasTool / getToolCount
  // ---------------------------------------------------------------
  describe('getTool', () => {
    beforeEach(() => {
      registry.registerTool(mockTool, mockConfig);
    });

    it('应该返回存在的工具', () => {
      const tool = registry.getTool('test-tool');
      expect(tool).toEqual(mockTool);
    });

    it('应该对不存在的工具返回 undefined', () => {
      const tool = registry.getTool('non-existent-tool');
      expect(tool).toBeUndefined();
    });
  });

  describe('getToolConfig', () => {
    beforeEach(() => {
      registry.registerTool(mockTool, mockConfig);
    });

    it('应该返回存在工具的配置', () => {
      const config = registry.getToolConfig('test-tool');
      expect(config).toEqual(mockConfig);
    });

    it('应该对不存在工具的配置返回 undefined', () => {
      const config = registry.getToolConfig('non-existent-tool');
      expect(config).toBeUndefined();
    });
  });

  describe('getAllTools', () => {
    it('应该在空注册表时返回空数组', () => {
      expect(registry.getAllTools()).toEqual([]);
    });

    it('应该返回所有注册的工具', () => {
      const tool2: McpTool = {
        name: 'test-tool-2',
        description: '第二个测试工具',
        inputSchema: { type: 'object', properties: {} },
      };

      registry.registerTool(mockTool, mockConfig);
      registry.registerTool(tool2, { ...mockConfig, id: 'test-tool-2' });

      const tools = registry.getAllTools();

      expect(tools).toHaveLength(2);
      expect(tools).toContainEqual(mockTool);
      expect(tools).toContainEqual(tool2);
    });
  });

  describe('getAllToolIds', () => {
    it('应该在空注册表时返回空数组', () => {
      expect(registry.getAllToolIds()).toEqual([]);
    });

    it('应该返回所有工具ID', () => {
      const tool2: McpTool = {
        name: 'test-tool-2',
        description: '第二个测试工具',
        inputSchema: { type: 'object', properties: {} },
      };

      registry.registerTool(mockTool, mockConfig);
      registry.registerTool(tool2, { ...mockConfig, id: 'test-tool-2' });

      const toolIds = registry.getAllToolIds();

      expect(toolIds).toHaveLength(2);
      expect(toolIds).toContain('test-tool');
      expect(toolIds).toContain('test-tool-2');
    });
  });

  describe('hasTool', () => {
    it('应该对已注册的工具返回 true', () => {
      registry.registerTool(mockTool, mockConfig);
      expect(registry.hasTool('test-tool')).toBe(true);
    });

    it('应该对未注册的工具返回 false', () => {
      expect(registry.hasTool('test-tool')).toBe(false);
    });
  });

  describe('getToolCount', () => {
    it('应该在空注册表时返回 0', () => {
      expect(registry.getToolCount()).toBe(0);
    });

    it('应该返回正确的工具数量', () => {
      registry.registerTool(mockTool, mockConfig);
      expect(registry.getToolCount()).toBe(1);

      const tool2: McpTool = {
        name: 'tool-2',
        description: 'Tool 2',
        inputSchema: { type: 'object', properties: {} },
      };
      registry.registerTool(tool2, { ...mockConfig, id: 'tool-2' });
      expect(registry.getToolCount()).toBe(2);
    });

    it('应该在注销后正确更新数量', () => {
      registry.registerTool(mockTool, mockConfig);
      registry.unregisterTool('test-tool');
      expect(registry.getToolCount()).toBe(0);
    });
  });

  // ---------------------------------------------------------------
  // filterTools
  // ---------------------------------------------------------------
  describe('filterTools', () => {
    beforeEach(() => {
      registry.registerTool(
        createTestTool({ name: 'search-users', description: 'Search for users in the system' }),
        createTestConfig({ id: 'search-users', name: 'search-users' }),
      );
      registry.registerTool(
        createTestTool({ name: 'get-user', description: 'Get a specific user by ID' }),
        createTestConfig({ id: 'get-user', name: 'get-user' }),
      );
      registry.registerTool(
        createTestTool({ name: 'delete-order', description: 'Delete an order from the system' }),
        createTestConfig({ id: 'delete-order', name: 'delete-order' }),
      );
    });

    it('应该按名称精确过滤工具', () => {
      const tools = registry.filterTools({ name: 'search-users' });

      expect(tools).toHaveLength(1);
      expect(tools[0].name).toBe('search-users');
    });

    it('应该在没有精确匹配时返回空数组', () => {
      const tools = registry.filterTools({ name: 'nonexistent' });
      expect(tools).toHaveLength(0);
    });

    it('应该按名称模糊过滤工具', () => {
      const tools = registry.filterTools({ name: 'user', fuzzy: true });

      expect(tools).toHaveLength(2);
      const names = tools.map((t) => t.name).toSorted();
      expect(names).toEqual(['get-user', 'search-users']);
    });

    it('应该按描述精确过滤工具', () => {
      const tools = registry.filterTools({ description: 'Search for users in the system' });

      expect(tools).toHaveLength(1);
      expect(tools[0].name).toBe('search-users');
    });

    it('应该按描述模糊过滤工具', () => {
      const tools = registry.filterTools({ description: 'system', fuzzy: true });

      expect(tools).toHaveLength(2);
      const names = tools.map((t) => t.name).toSorted();
      expect(names).toEqual(['delete-order', 'search-users']);
    });

    it('应该按 ID 精确过滤工具', () => {
      const tools = registry.filterTools({ id: 'get-user' });

      expect(tools).toHaveLength(1);
      expect(tools[0].name).toBe('get-user');
    });

    it('应该按 ID 模糊过滤工具', () => {
      const tools = registry.filterTools({ id: 'order', fuzzy: true });

      expect(tools).toHaveLength(1);
      expect(tools[0].name).toBe('delete-order');
    });

    it('应该应用组合过滤条件（所有条件必须满足）', () => {
      const tools = registry.filterTools({
        name: 'user',
        description: 'Search',
        fuzzy: true,
      });

      expect(tools).toHaveLength(1);
      expect(tools[0].name).toBe('search-users');
    });

    it('应该在组合过滤条件不匹配时返回空数组', () => {
      const tools = registry.filterTools({
        name: 'user',
        description: 'Delete',
        fuzzy: true,
      });

      expect(tools).toHaveLength(0);
    });

    it('应该在无过滤条件时返回所有工具', () => {
      const tools = registry.filterTools({});
      expect(tools).toHaveLength(3);
    });
  });

  // ---------------------------------------------------------------
  // searchTools
  // ---------------------------------------------------------------
  describe('searchTools', () => {
    beforeEach(() => {
      registry.registerTool(
        createTestTool({ name: 'create-user', description: 'Create a new user account' }),
        createTestConfig({ id: 'create-user', name: 'create-user' }),
      );
      registry.registerTool(
        createTestTool({ name: 'list-orders', description: 'List all orders in the system' }),
        createTestConfig({ id: 'list-orders', name: 'list-orders' }),
      );
    });

    it('应该在工具名称中搜索', () => {
      const tools = registry.searchTools('user');

      expect(tools).toHaveLength(1);
      expect(tools[0].name).toBe('create-user');
    });

    it('应该在工具描述中搜索', () => {
      const tools = registry.searchTools('orders');

      expect(tools).toHaveLength(1);
      expect(tools[0].name).toBe('list-orders');
    });

    it('应该执行大小写不敏感搜索', () => {
      const upperResults = registry.searchTools('USER');
      const lowerResults = registry.searchTools('user');
      const mixedResults = registry.searchTools('User');

      expect(upperResults).toHaveLength(1);
      expect(lowerResults).toHaveLength(1);
      expect(mixedResults).toHaveLength(1);

      expect(upperResults[0].name).toBe('create-user');
      expect(lowerResults[0].name).toBe('create-user');
      expect(mixedResults[0].name).toBe('create-user');
    });

    it('应该在没有匹配时返回空数组', () => {
      const tools = registry.searchTools('不存在的关键词');
      expect(tools).toHaveLength(0);
    });
  });

  // ---------------------------------------------------------------
  // clear
  // ---------------------------------------------------------------
  describe('clear', () => {
    it('应该清空所有工具', () => {
      registry.registerTool(mockTool, mockConfig);
      const tool2: McpTool = {
        name: 'tool-2',
        description: 'Tool 2',
        inputSchema: { type: 'object', properties: {} },
      };
      registry.registerTool(tool2, { ...mockConfig, id: 'tool-2' });

      expect(registry.getToolCount()).toBe(2);

      registry.clear();

      expect(registry.getToolCount()).toBe(0);
      expect(registry.getAllTools()).toEqual([]);
      expect(registry.getAllToolIds()).toEqual([]);
      expect(registry.getToolConfig('test-tool')).toBeUndefined();
      expect(vi.mocked(logger.info)).toHaveBeenCalledWith('清空工具注册表', {
        context: { toolCount: 2 },
      });
      expect(vi.mocked(logger.info)).toHaveBeenCalledWith('工具注册表已清空');
    });

    it('应该触发 cleared 事件', () => {
      const eventListener = vi.fn();
      registry.registerTool(mockTool, mockConfig);
      registry.addEventListener(eventListener);

      registry.clear();

      expect(eventListener).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'cleared',
          toolId: '*',
        }),
      );
    });
  });

  // ---------------------------------------------------------------
  // getStats
  // ---------------------------------------------------------------
  describe('getStats', () => {
    it('应该在空注册表时返回正确的统计', () => {
      const stats = registry.getStats();

      expect(stats.totalTools).toBe(0);
      expect(stats.toolsBySource).toEqual({});
      expect(stats.createdAt).toBeInstanceOf(Date);
      expect(stats.lastUpdated).toBeInstanceOf(Date);
    });

    it('应该返回正确的工具总数', () => {
      registry.registerTool(mockTool, mockConfig);
      const tool2: McpTool = {
        name: 'tool-2',
        description: 'Tool 2',
        inputSchema: { type: 'object', properties: {} },
      };
      registry.registerTool(tool2, { ...mockConfig, id: 'tool-2' });

      const stats = registry.getStats();
      expect(stats.totalTools).toBe(2);
    });

    it('应该按 URL 域名分组统计', () => {
      registry.registerTool(mockTool, mockConfig);

      const tool2: McpTool = {
        name: 'weather-api',
        description: '天气API',
        inputSchema: { type: 'object', properties: {} },
      };
      const config2: ApiToolConfig = {
        ...mockConfig,
        id: 'weather-api',
        api: {
          url: 'https://weather.example.com/api',
          method: 'GET',
        },
      };
      registry.registerTool(tool2, config2);

      const tool3: McpTool = {
        name: 'another-api-tool',
        description: 'Another tool on same domain',
        inputSchema: { type: 'object', properties: {} },
      };
      const config3: ApiToolConfig = {
        ...mockConfig,
        id: 'another-api-tool',
        api: {
          url: 'https://api.example.com/v2/data',
          method: 'POST',
        },
      };
      registry.registerTool(tool3, config3);

      const stats = registry.getStats();

      expect(stats.totalTools).toBe(3);
      expect(stats.toolsBySource['api.example.com']).toBe(2);
      expect(stats.toolsBySource['weather.example.com']).toBe(1);
    });

    it('应该将无效 URL 归类为 unknown', () => {
      const invalidConfig: ApiToolConfig = {
        ...mockConfig,
        api: {
          url: 'invalid-url',
          method: 'GET',
        },
      };

      registry.registerTool(mockTool, invalidConfig);

      const stats = registry.getStats();

      expect(stats.totalTools).toBe(1);
      expect(stats.toolsBySource['unknown']).toBe(1);
    });

    it('注册与注销操作应更新 lastUpdated 而 createdAt 保持不变', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
      const freshRegistry = new ApiToolRegistry();
      const createdAt = freshRegistry.getStats().createdAt;

      vi.setSystemTime(new Date('2026-01-01T01:00:00Z'));
      freshRegistry.registerTool(mockTool, mockConfig);
      expect(freshRegistry.getStats().lastUpdated).toEqual(new Date('2026-01-01T01:00:00Z'));

      vi.setSystemTime(new Date('2026-01-01T02:00:00Z'));
      freshRegistry.unregisterTool('test-tool');
      expect(freshRegistry.getStats().lastUpdated).toEqual(new Date('2026-01-01T02:00:00Z'));

      vi.setSystemTime(new Date('2026-01-01T03:00:00Z'));
      freshRegistry.clear();
      expect(freshRegistry.getStats().lastUpdated).toEqual(new Date('2026-01-01T03:00:00Z'));

      expect(freshRegistry.getStats().createdAt).toBe(createdAt);
      expect(freshRegistry.getStats().createdAt).toEqual(new Date('2026-01-01T00:00:00Z'));
      vi.useRealTimers();
    });
  });

  // ---------------------------------------------------------------
  // Events (addEventListener / removeEventListener / removeAllEventListeners)
  // ---------------------------------------------------------------
  describe('事件监听器', () => {
    it('应该添加和触发事件监听器', () => {
      const listener = vi.fn();
      registry.addEventListener(listener);

      registry.registerTool(mockTool, mockConfig);

      expect(listener).toHaveBeenCalledOnce();
      expect(listener).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'added',
          toolId: 'test-tool',
          tool: mockTool,
        }),
      );
    });

    it('应该移除特定的事件监听器', () => {
      const listener1 = vi.fn();
      const listener2 = vi.fn();

      registry.addEventListener(listener1);
      registry.addEventListener(listener2);

      registry.registerTool(mockTool, mockConfig);

      expect(listener1).toHaveBeenCalled();
      expect(listener2).toHaveBeenCalled();

      listener1.mockClear();
      listener2.mockClear();

      registry.removeEventListener(listener1);

      registry.unregisterTool('test-tool');

      expect(listener1).not.toHaveBeenCalled();
      expect(listener2).toHaveBeenCalled();
    });

    it('应该移除所有事件监听器', () => {
      const listener1 = vi.fn();
      const listener2 = vi.fn();

      registry.addEventListener(listener1);
      registry.addEventListener(listener2);

      registry.removeAllEventListeners();

      registry.registerTool(mockTool, mockConfig);

      expect(listener1).not.toHaveBeenCalled();
      expect(listener2).not.toHaveBeenCalled();
    });

    it('应该在监听器抛出错误时不影响其他监听器', () => {
      const errorListener = vi.fn(() => {
        throw new Error('监听器错误');
      });
      const normalListener = vi.fn();

      registry.addEventListener(errorListener);
      registry.addEventListener(normalListener);

      expect(() => {
        registry.registerTool(mockTool, mockConfig);
      }).not.toThrow();

      expect(errorListener).toHaveBeenCalled();
      expect(normalListener).toHaveBeenCalled();
      expect(vi.mocked(logger.error)).toHaveBeenCalledWith(
        '工具注册表事件监听器执行失败',
        expect.any(Error),
        { context: { eventType: 'added', toolId: 'test-tool' } },
      );
    });

    it('不应该添加重复的监听器', () => {
      const listener = vi.fn();
      registry.addEventListener(listener);
      registry.addEventListener(listener);

      registry.registerTool(mockTool, mockConfig);

      expect(listener).toHaveBeenCalledOnce();
    });

    it('移除未注册的监听器不应抛出异常', () => {
      const listener = vi.fn();
      expect(() => registry.removeEventListener(listener)).not.toThrow();
    });
  });
});
