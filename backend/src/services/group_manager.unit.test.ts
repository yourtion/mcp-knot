import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ServerStatus } from '../types/mcp-knot.js';
import { GroupManager } from './group_manager.js';

import type { ServerConnection, ServerManager } from '../types/mcp-knot.js';
import type { GroupConfig } from '@mcp-core/mcp-knot-share';

// Mock the logger
vi.mock('../utils/logger.js');

describe('GroupManager', () => {
  let groupManager: GroupManager;
  let mockServerManager: ServerManager;
  let mockGroupConfig: GroupConfig;

  beforeEach(() => {
    vi.clearAllMocks();

    // Setup mock server manager
    const mockServers = new Map<string, ServerConnection>([
      [
        'server1',
        {
          id: 'server1',
          config: { type: 'stdio', command: 'node', args: ['server1.js'] },
          client: {} as Record<string, unknown>,
          status: ServerStatus.CONNECTED,
          tools: [
            {
              name: 'tool1',
              description: 'Tool 1',
              inputSchema: {},
              serverId: 'server1',
            },
            {
              name: 'tool2',
              description: 'Tool 2',
              inputSchema: {},
              serverId: 'server1',
            },
          ],
          reconnectAttempts: 0,
        },
      ],
      [
        'server2',
        {
          id: 'server2',
          config: { type: 'stdio', command: 'node', args: ['server2.js'] },
          client: {} as Record<string, unknown>,
          status: ServerStatus.CONNECTED,
          tools: [
            {
              name: 'tool3',
              description: 'Tool 3',
              inputSchema: {},
              serverId: 'server2',
            },
            {
              name: 'tool4',
              description: 'Tool 4',
              inputSchema: {},
              serverId: 'server2',
            },
          ],
          reconnectAttempts: 0,
        },
      ],
      [
        'server3',
        {
          id: 'server3',
          config: { type: 'stdio', command: 'node', args: ['server3.js'] },
          client: {} as Record<string, unknown>,
          status: ServerStatus.DISCONNECTED,
          tools: [],
          reconnectAttempts: 0,
        },
      ],
    ]);

    mockServerManager = {
      getAllServers: vi.fn().mockReturnValue(mockServers),
      getServerTools: vi.fn().mockImplementation((serverId: string) => {
        const server = mockServers.get(serverId);
        return Promise.resolve(server?.tools || []);
      }),
      initialize: vi.fn(),
      getServerStatus: vi.fn(),
      executeToolOnServer: vi.fn(),
      shutdown: vi.fn(),
    };

    // Setup test group configurations
    mockGroupConfig = {
      default: {
        id: 'default',
        name: 'Default Group',
        description: 'Default group with all servers',
        servers: ['server1', 'server2'],
        tools: [], // Empty means all tools
      },
      'server1-only': {
        id: 'server1-only',
        name: 'Server 1 Only',
        description: 'Group with only server1',
        servers: ['server1'],
        tools: [], // All tools from server1
      },
      'filtered-tools': {
        id: 'filtered-tools',
        name: 'Filtered Tools',
        description: 'Group with specific tools only',
        servers: ['server1', 'server2'],
        tools: ['tool1', 'tool3'], // Only specific tools
      },
      'invalid-server': {
        id: 'invalid-server',
        name: 'Invalid Server Group',
        description: 'Group referencing non-existent server',
        servers: ['server1', 'non-existent-server'],
        tools: [],
      },
      'disconnected-server': {
        id: 'disconnected-server',
        name: 'Disconnected Server Group',
        description: 'Group with disconnected server',
        servers: ['server3'],
        tools: [],
      },
    };

    groupManager = new GroupManager(mockGroupConfig, mockServerManager);
  });

  describe('constructor', () => {
    it('should store group configuration and server manager', () => {
      expect(groupManager).toBeInstanceOf(GroupManager);
    });
  });

  describe('initialize', () => {
    it('should load valid group configurations', async () => {
      await groupManager.initialize();

      const groups = groupManager.getAllGroups();
      expect(groups.size).toBeGreaterThan(0);
      expect(groups.has('default')).toBe(true);
      expect(groups.has('server1-only')).toBe(true);
      expect(groups.has('filtered-tools')).toBe(true);
    });

    it('should create fallback groups for invalid configuration structure', async () => {
      const invalidConfig = {
        'invalid-group': {
          // Missing required fields
          servers: ['server1'],
          tools: [],
        } as Record<string, unknown>,
      };

      const invalidManager = new GroupManager(
        invalidConfig as unknown as GroupConfig,
        mockServerManager,
      );
      await invalidManager.initialize();

      const groups = invalidManager.getAllGroups();
      // Should create a fallback group
      expect(groups.has('invalid-group')).toBe(true);
      const group = groups.get('invalid-group');
      expect(group?.description).toContain('Fallback group created due to configuration errors');
    });

    it('should handle groups with invalid server references', async () => {
      await groupManager.initialize();

      const groups = groupManager.getAllGroups();
      const invalidGroup = groups.get('invalid-server');

      // Group should be loaded but with only valid servers
      expect(invalidGroup).toBeDefined();
      expect(invalidGroup?.servers).toEqual(['server1']); // Only valid server
    });

    it('should create fallback groups for recoverable errors', async () => {
      const partiallyInvalidConfig = {
        'recoverable-group': {
          id: 'recoverable-group',
          name: 'Recoverable Group',
          description: 'Group with some invalid servers',
          servers: ['server1', 'non-existent'],
          tools: [],
        },
      };

      const recoverableManager = new GroupManager(partiallyInvalidConfig, mockServerManager);
      await recoverableManager.initialize();

      const groups = recoverableManager.getAllGroups();
      expect(groups.has('recoverable-group')).toBe(true);
    });

    it('should handle groups with no valid servers', async () => {
      const noValidServersConfig = {
        'no-servers': {
          id: 'no-servers',
          name: 'No Valid Servers',
          description: 'Group with no valid servers',
          servers: ['non-existent1', 'non-existent2'],
          tools: [],
        },
      };

      const noServersManager = new GroupManager(noValidServersConfig, mockServerManager);
      await noServersManager.initialize();

      const groups = noServersManager.getAllGroups();
      // Should create a fallback group even with no valid servers
      expect(groups.has('no-servers')).toBe(true);
      const group = groups.get('no-servers');
      expect(group?.description).toContain('Fallback group created due to configuration errors');
    });

    it('超过最大组数量（100）时第 101 个组走 fallback', async () => {
      const oversizedConfig: Record<string, unknown> = {};
      for (let i = 1; i <= 100; i++) {
        oversizedConfig[`g${i}`] = {
          id: `g${i}`,
          name: `Group ${i}`,
          servers: ['server1'],
          tools: [],
        };
      }
      oversizedConfig['g101'] = {
        id: 'g101',
        name: 'Group 101',
        servers: ['server1'],
        tools: [],
      };

      const manager = new GroupManager(
        oversizedConfig as unknown as GroupConfig,
        mockServerManager,
      );
      await manager.initialize();

      const groups = manager.getAllGroups();
      // 前 100 个正常加载（未配置 description，无 fallback 痕迹）
      expect(groups.size).toBe(101);
      const group100 = groups.get('g100');
      expect(group100?.description).toBeUndefined();
      // 第 101 个触发数量限制 → fallback（仍有 server 可用）
      const group101 = groups.get('g101');
      expect(group101?.description).toContain('Fallback group created due to configuration errors');
    });

    it('无可用的任何 server 时 fallback 创建失败（组不加载）', async () => {
      const emptyServerManager = {
        ...mockServerManager,
        getAllServers: vi.fn().mockReturnValue(new Map()),
      };
      const cfg = {
        'invalid-only': {
          // 缺 id/name → 校验失败 → 尝试 fallback，但无可用 server → 放弃
          servers: ['server1'],
          tools: [],
        } as Record<string, unknown>,
      };
      const manager = new GroupManager(cfg as unknown as GroupConfig, emptyServerManager);
      await manager.initialize();

      expect(manager.getAllGroups().has('invalid-only')).toBe(false);
      expect(emptyServerManager.getAllServers).toHaveBeenCalled();
    });

    it('createFallbackGroup 内部异常被吞掉（不阻断 initialize）', async () => {
      // 第一次 getAllServers（validateGroupServers 用）成功返回；
      // 第二次（createFallbackGroup 内）抛错 → fallback catch → 组不加载但 initialize 不崩
      let callCount = 0;
      const failingManager = {
        ...mockServerManager,
        getAllServers: vi.fn().mockImplementation(() => {
          callCount++;
          if (callCount >= 2) throw new Error('server manager exploded');
          return new Map();
        }),
      };
      const cfg = {
        broken: {
          servers: ['non-existent'], // 无有效 server → 抛错进 fallback → fallback 内 getAllServers 再抛
          tools: [],
        } as Record<string, unknown>,
      };
      const manager = new GroupManager(cfg as unknown as GroupConfig, failingManager);
      await expect(manager.initialize()).resolves.toBeUndefined();
      expect(manager.getAllGroups().has('broken')).toBe(false);
    });
  });

  describe('getGroup', () => {
    beforeEach(async () => {
      await groupManager.initialize();
    });

    it('should return existing group', () => {
      const group = groupManager.getGroup('default');
      expect(group).toBeDefined();
      expect(group?.id).toBe('default');
      expect(group?.name).toBe('Default Group');
    });

    it('should return undefined for non-existent group', () => {
      const group = groupManager.getGroup('non-existent');
      expect(group).toBeUndefined();
    });
  });

  describe('getAllGroups', () => {
    beforeEach(async () => {
      await groupManager.initialize();
    });

    it('should return all loaded groups', () => {
      const groups = groupManager.getAllGroups();
      expect(groups.size).toBeGreaterThan(0);
      expect(groups.has('default')).toBe(true);
      expect(groups.has('server1-only')).toBe(true);
    });

    it('should return a copy of the groups map', () => {
      const groups1 = groupManager.getAllGroups();
      const groups2 = groupManager.getAllGroups();
      expect(groups1).not.toBe(groups2); // Different instances
      expect(groups1.size).toBe(groups2.size); // Same content
    });
  });

  describe('getGroupTools', () => {
    beforeEach(async () => {
      await groupManager.initialize();
    });

    it('should return all tools for group with no tool restrictions', async () => {
      const tools = await groupManager.getGroupTools('default');
      expect(tools).toHaveLength(4); // 2 tools from server1 + 2 tools from server2
      expect(tools.map((t) => t.name)).toContain('tool1');
      expect(tools.map((t) => t.name)).toContain('tool2');
      expect(tools.map((t) => t.name)).toContain('tool3');
      expect(tools.map((t) => t.name)).toContain('tool4');
    });

    it('should return filtered tools for group with tool restrictions', async () => {
      const tools = await groupManager.getGroupTools('filtered-tools');
      expect(tools).toHaveLength(2); // Only tool1 and tool3
      expect(tools.map((t) => t.name)).toContain('tool1');
      expect(tools.map((t) => t.name)).toContain('tool3');
      expect(tools.map((t) => t.name)).not.toContain('tool2');
      expect(tools.map((t) => t.name)).not.toContain('tool4');
    });

    it('should return tools only from specified servers', async () => {
      const tools = await groupManager.getGroupTools('server1-only');
      expect(tools).toHaveLength(2); // Only tools from server1
      expect(tools.map((t) => t.name)).toContain('tool1');
      expect(tools.map((t) => t.name)).toContain('tool2');
      expect(tools.map((t) => t.name)).not.toContain('tool3');
      expect(tools.map((t) => t.name)).not.toContain('tool4');
    });

    it('should throw error for non-existent group', async () => {
      await expect(groupManager.getGroupTools('non-existent')).rejects.toThrow(
        'Group non-existent not found',
      );
    });

    it('should return empty array for group with disconnected servers', async () => {
      const tools = await groupManager.getGroupTools('disconnected-server');
      expect(tools).toHaveLength(0);
    });

    it('should handle server tool retrieval failures gracefully', async () => {
      // Mock server tool retrieval to fail for one server
      vi.mocked(mockServerManager.getServerTools)
        .mockImplementationOnce(() => Promise.reject(new Error('Server error')))
        .mockImplementationOnce(() =>
          Promise.resolve([
            {
              name: 'tool3',
              description: 'Tool 3',
              inputSchema: {},
              serverId: 'server2',
            },
          ]),
        );

      const tools = await groupManager.getGroupTools('default');
      // Should still return tools from working server
      expect(tools.length).toBeGreaterThan(0);
    });
  });

  describe('validateToolAccess', () => {
    beforeEach(async () => {
      await groupManager.initialize();
    });

    it('should allow access to tools in unrestricted group', () => {
      expect(groupManager.validateToolAccess('default', 'tool1')).toBe(true);
      expect(groupManager.validateToolAccess('default', 'tool2')).toBe(true);
      expect(groupManager.validateToolAccess('default', 'tool3')).toBe(true);
      expect(groupManager.validateToolAccess('default', 'tool4')).toBe(true);
    });

    it('should restrict access to tools not in group allowlist', () => {
      expect(groupManager.validateToolAccess('filtered-tools', 'tool1')).toBe(true);
      expect(groupManager.validateToolAccess('filtered-tools', 'tool3')).toBe(true);
      expect(groupManager.validateToolAccess('filtered-tools', 'tool2')).toBe(false);
      expect(groupManager.validateToolAccess('filtered-tools', 'tool4')).toBe(false);
    });

    it('should deny access for non-existent group', () => {
      expect(groupManager.validateToolAccess('non-existent', 'tool1')).toBe(false);
    });

    it('should deny access for group with no available servers', () => {
      expect(groupManager.validateToolAccess('disconnected-server', 'tool1')).toBe(false);
    });
  });

  describe('findToolInGroup', () => {
    beforeEach(async () => {
      await groupManager.initialize();
    });

    it('should find tool in group', async () => {
      const result = await groupManager.findToolInGroup('default', 'tool1');
      expect(result).toBeDefined();
      expect(result?.tool.name).toBe('tool1');
      expect(result?.serverId).toBe('server1');
    });

    it('should return null for tool not in group allowlist', async () => {
      const result = await groupManager.findToolInGroup('filtered-tools', 'tool2');
      expect(result).toBeNull();
    });

    it('should return null for non-existent group', async () => {
      const result = await groupManager.findToolInGroup('non-existent', 'tool1');
      expect(result).toBeNull();
    });

    it('should return null for non-existent tool', async () => {
      const result = await groupManager.findToolInGroup('default', 'non-existent-tool');
      expect(result).toBeNull();
    });

    it('server 工具检索抛错时跳过该 server 继续搜索', async () => {
      // server1 抛错，server2 正常返回 tool3 → 仍能在 server2 上找到 tool3
      vi.mocked(mockServerManager.getServerTools)
        .mockImplementationOnce(() => Promise.reject(new Error('server1 down')))
        .mockImplementationOnce(() =>
          Promise.resolve([{ name: 'tool3', serverId: 'server2' } as never]),
        );

      const result = await groupManager.findToolInGroup('default', 'tool3');
      expect(result).not.toBeNull();
      expect(result?.serverId).toBe('server2');
    });
  });

  describe('getGroupToolsByServer', () => {
    beforeEach(async () => {
      await groupManager.initialize();
    });

    it('按 server 分组返回各自工具', async () => {
      const byServer = await groupManager.getGroupToolsByServer('default');
      expect(byServer.get('server1')?.map((t) => t.name)).toEqual(['tool1', 'tool2']);
      expect(byServer.get('server2')?.map((t) => t.name)).toEqual(['tool3', 'tool4']);
    });

    it('应用组的工具白名单过滤', async () => {
      const byServer = await groupManager.getGroupToolsByServer('filtered-tools');
      expect(byServer.get('server1')?.map((t) => t.name)).toEqual(['tool1']);
      expect(byServer.get('server2')?.map((t) => t.name)).toEqual(['tool3']);
    });

    it('组不存在时抛错', async () => {
      await expect(groupManager.getGroupToolsByServer('non-existent')).rejects.toThrow(
        'Group non-existent not found',
      );
    });

    it('无可用 server 时返回空 Map', async () => {
      const byServer = await groupManager.getGroupToolsByServer('disconnected-server');
      expect(byServer.size).toBe(0);
    });

    it('单个 server 检索失败时该 server 记空数组，其余正常', async () => {
      vi.mocked(mockServerManager.getServerTools)
        .mockImplementationOnce(() => Promise.reject(new Error('server1 down')))
        .mockImplementationOnce(() =>
          Promise.resolve([
            { name: 'tool3', description: 'Tool 3', inputSchema: {}, serverId: 'server2' },
          ]),
        );

      const byServer = await groupManager.getGroupToolsByServer('default');
      expect(byServer.get('server1')).toEqual([]);
      expect(byServer.get('server2')?.map((t) => t.name)).toEqual(['tool3']);
    });
  });

  describe('getGroupServers', () => {
    beforeEach(async () => {
      await groupManager.initialize();
    });

    it('should return servers for existing group', () => {
      const servers = groupManager.getGroupServers('default');
      expect(servers).toEqual(['server1', 'server2']);
    });

    it('should return only valid servers', () => {
      const servers = groupManager.getGroupServers('invalid-server');
      expect(servers).toEqual(['server1']); // Only valid server
    });

    it('should return empty array for non-existent group', () => {
      const servers = groupManager.getGroupServers('non-existent');
      expect(servers).toEqual([]);
    });
  });

  describe('getAvailableGroupServers', () => {
    beforeEach(async () => {
      await groupManager.initialize();
    });

    it('should return only connected servers', () => {
      const servers = groupManager.getAvailableGroupServers('default');
      expect(servers).toEqual(['server1', 'server2']); // Both connected
    });

    it('should exclude disconnected servers', () => {
      const servers = groupManager.getAvailableGroupServers('disconnected-server');
      expect(servers).toEqual([]); // server3 is disconnected
    });
  });

  describe('getGroupStats', () => {
    beforeEach(async () => {
      await groupManager.initialize();
    });

    it('should return correct stats for group', () => {
      const stats = groupManager.getGroupStats('default');
      expect(stats.totalServers).toBe(2);
      expect(stats.availableServers).toBe(2);
      expect(stats.configuredTools).toBe(0); // No tool restrictions
    });

    it('should return correct stats for filtered group', () => {
      const stats = groupManager.getGroupStats('filtered-tools');
      expect(stats.totalServers).toBe(2);
      expect(stats.availableServers).toBe(2);
      expect(stats.configuredTools).toBe(2); // 2 specific tools
    });

    it('should return zero stats for non-existent group', () => {
      const stats = groupManager.getGroupStats('non-existent');
      expect(stats.totalServers).toBe(0);
      expect(stats.availableServers).toBe(0);
      expect(stats.configuredTools).toBe(0);
    });
  });

  describe('validateGroupHealth', () => {
    beforeEach(async () => {
      await groupManager.initialize();
    });

    it('should report healthy group', async () => {
      const health = await groupManager.validateGroupHealth('default');
      expect(health.isHealthy).toBe(true);
      expect(health.issues).toHaveLength(0);
      expect(health.stats.availableServers).toBe(2);
    });

    it('should report unhealthy group with no available servers', async () => {
      const health = await groupManager.validateGroupHealth('disconnected-server');
      expect(health.isHealthy).toBe(false);
      expect(health.issues).toContain('No servers are currently available');
    });

    it('should report warnings for partially available servers', async () => {
      // Create a group with mixed server states
      const mixedConfig = {
        'mixed-servers': {
          id: 'mixed-servers',
          name: 'Mixed Servers',
          servers: ['server1', 'server3'], // One connected, one disconnected
          tools: [],
        },
      };

      const mixedManager = new GroupManager(mixedConfig, mockServerManager);
      await mixedManager.initialize();

      const health = await mixedManager.validateGroupHealth('mixed-servers');
      expect(health.isHealthy).toBe(true); // Still healthy with some servers
      expect(health.warnings.length).toBeGreaterThan(0);
    });

    it('should handle non-existent group', async () => {
      const health = await groupManager.validateGroupHealth('non-existent');
      expect(health.isHealthy).toBe(false);
      expect(health.issues).toContain('Group non-existent not found');
    });
  });

  describe('configuration validation', () => {
    it('should validate required group fields', async () => {
      const invalidConfigs = [
        {
          'no-id': {
            name: 'No ID Group',
            servers: ['server1'],
            tools: [],
          },
        },
        {
          'no-name': {
            id: 'no-name',
            servers: ['server1'],
            tools: [],
          },
        },
        {
          'invalid-servers': {
            id: 'invalid-servers',
            name: 'Invalid Servers',
            servers: 'not-an-array' as unknown as string[],
            tools: [],
          },
        },
        {
          'invalid-tools': {
            id: 'invalid-tools',
            name: 'Invalid Tools',
            servers: ['server1'],
            tools: 'not-an-array' as unknown as string[],
          },
        },
        {
          'invalid-description': {
            id: 'invalid-description',
            name: 'Invalid Description',
            description: 123 as unknown as string,
            servers: ['server1'],
            tools: [],
          },
        },
        {
          'invalid-server-entry': {
            id: 'invalid-server-entry',
            name: 'Invalid Server Entry',
            servers: ['server1', 42 as unknown as string],
            tools: [],
          },
        },
        {
          'invalid-tool-entry': {
            id: 'invalid-tool-entry',
            name: 'Invalid Tool Entry',
            servers: ['server1'],
            tools: ['tool1', null as unknown as string],
          },
        },
      ];

      for (const config of invalidConfigs) {
        const invalidManager = new GroupManager(
          config as unknown as GroupConfig,
          mockServerManager,
        );
        await invalidManager.initialize();

        const groups = invalidManager.getAllGroups();
        const groupId = Object.keys(config)[0];
        // Should create fallback groups for invalid configurations
        expect(groups.has(groupId)).toBe(true);
        const group = groups.get(groupId);
        expect(group?.description).toContain('Fallback group created due to configuration errors');
      }
    });

    it('should handle duplicate server IDs in group', async () => {
      const duplicateConfig = {
        'duplicate-servers': {
          id: 'duplicate-servers',
          name: 'Duplicate Servers',
          servers: ['server1', 'server1', 'server2'],
          tools: [],
        },
      };

      const duplicateManager = new GroupManager(duplicateConfig, mockServerManager);
      await duplicateManager.initialize();

      const groups = duplicateManager.getAllGroups();
      // Should create fallback group for duplicate servers
      expect(groups.has('duplicate-servers')).toBe(true);
      const group = groups.get('duplicate-servers');
      expect(group?.description).toContain('Fallback group created due to configuration errors');
    });

    it('should handle duplicate tool names in group', async () => {
      const duplicateConfig = {
        'duplicate-tools': {
          id: 'duplicate-tools',
          name: 'Duplicate Tools',
          servers: ['server1'],
          tools: ['tool1', 'tool1', 'tool2'],
        },
      };

      const duplicateManager = new GroupManager(duplicateConfig, mockServerManager);
      await duplicateManager.initialize();

      const groups = duplicateManager.getAllGroups();
      // Should create fallback group for duplicate tools
      expect(groups.has('duplicate-tools')).toBe(true);
      const group = groups.get('duplicate-tools');
      expect(group?.description).toContain('Fallback group created due to configuration errors');
    });
  });

  describe('error handling and resilience', () => {
    beforeEach(async () => {
      await groupManager.initialize();
    });

    it('should continue loading other groups when one fails', async () => {
      const mixedConfig = {
        'valid-group': {
          id: 'valid-group',
          name: 'Valid Group',
          servers: ['server1'],
          tools: [],
        },
        'invalid-group': {
          // Missing required fields
          servers: ['server1'],
          tools: [],
        } as Record<string, unknown>,
      };

      const mixedManager = new GroupManager(
        mixedConfig as unknown as GroupConfig,
        mockServerManager,
      );
      await mixedManager.initialize();

      const groups = mixedManager.getAllGroups();
      expect(groups.has('valid-group')).toBe(true);
      // Should create fallback group for invalid configuration
      expect(groups.has('invalid-group')).toBe(true);
      const invalidGroup = groups.get('invalid-group');
      expect(invalidGroup?.description).toContain(
        'Fallback group created due to configuration errors',
      );
    });

    it('should handle server manager errors gracefully', async () => {
      // Mock server manager to throw errors
      vi.mocked(mockServerManager.getServerTools).mockRejectedValue(
        new Error('Server manager error'),
      );

      const tools = await groupManager.getGroupTools('default');
      expect(tools).toEqual([]); // Should return empty array as fallback
    });

    it('should handle getAllGroupsHealth errors', async () => {
      const healthMap = await groupManager.getAllGroupsHealth();
      expect(healthMap).toBeInstanceOf(Map);
      expect(healthMap.size).toBeGreaterThan(0);

      // All groups should have health status
      for (const [_groupId, health] of healthMap) {
        expect(health).toHaveProperty('isHealthy');
        expect(health).toHaveProperty('issues');
        expect(health).toHaveProperty('warnings');
      }
    });
  });
});
