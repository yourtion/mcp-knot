import { beforeEach, describe, expect, it, vi } from 'vitest';

import { logger } from '../utils/logger.js';
import {
  validateAllConfigs,
  validateConfigCrossReferences,
  validateGroupConfig,
  validateMcpConfig,
  validateSystemConfig,
} from './config.js';

import type { GroupConfig, McpConfig } from '@mcp-core/mcp-knot-share';

vi.mock('../utils/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

describe('配置验证工具', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('validateMcpConfig', () => {
    it('应该验证有效的stdio服务器配置', () => {
      const config = {
        servers: {
          'test-server': {
            type: 'stdio',
            command: 'node',
            args: ['server.js'],
            env: { NODE_ENV: 'test' },
            enabled: true,
          },
        },
      };

      const result = validateMcpConfig(config);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.servers['test-server'].type).toBe('stdio');
      }
    });

    it('应该验证有效的SSE服务器配置', () => {
      const config = {
        servers: {
          'sse-server': {
            type: 'sse',
            url: 'http://localhost:8181/sse',
            headers: { Authorization: 'Bearer token' },
            enabled: true,
          },
        },
      };

      const result = validateMcpConfig(config);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.servers['sse-server'].type).toBe('sse');
      }
    });

    it('应该拒绝空的服务器配置', () => {
      const config = {
        servers: {},
      };

      const result = validateMcpConfig(config);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.errors).toContain('servers: 至少需要配置一个MCP服务器');
      }
    });

    it('应该拒绝无效的命令配置', () => {
      const config = {
        servers: {
          'invalid-server': {
            type: 'stdio',
            command: '', // 空命令
          },
        },
      };

      const result = validateMcpConfig(config);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.errors.some((err) => err.includes('命令不能为空'))).toBe(true);
      }
    });

    it('应该拒绝无效的URL配置', () => {
      const config = {
        servers: {
          'invalid-sse': {
            type: 'sse',
            url: 'not-a-url',
          },
        },
      };

      const result = validateMcpConfig(config);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.errors.some((err) => err.includes('必须是有效的URL'))).toBe(true);
      }
    });
  });

  describe('validateGroupConfig', () => {
    it('应该验证有效的组配置', () => {
      const config = {
        default: {
          id: 'default-group',
          name: 'Default Group',
          description: 'Default group',
          servers: ['server1', 'server2'],
          tools: [],
        },
      };

      const result = validateGroupConfig(config, ['server1', 'server2']);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.default.name).toBe('Default Group');
      }
    });

    it('应该拒绝引用不存在服务器的组配置', () => {
      const config = {
        'test-group': {
          id: 'test-group',
          name: 'Test Group',
          servers: ['nonexistent-server'],
          tools: [],
        },
      };

      const result = validateGroupConfig(config, ['server1']);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.errors.some((err) => err.includes('引用了不存在的服务器'))).toBe(true);
      }
    });

    it('应该拒绝空服务器列表的组配置', () => {
      const config = {
        'empty-group': {
          id: 'empty-group',
          name: 'Empty Group',
          servers: [],
          tools: [],
        },
      };

      const result = validateGroupConfig(config);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.errors.some((err) => err.includes('每个组至少需要包含一个服务器'))).toBe(
          true,
        );
      }
    });

    it('应该拒绝空组名的配置', () => {
      const config = {
        'test-group': {
          id: 'test-group',
          name: '',
          servers: ['server1'],
          tools: [],
        },
      };

      const result = validateGroupConfig(config);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.errors.some((err) => err.includes('组名称不能为空'))).toBe(true);
      }
    });

    it('未提供可用服务器列表时不校验服务器引用（默认空列表）', () => {
      const config = {
        default: {
          id: 'default-group',
          name: 'Default',
          servers: ['server-any'],
          tools: [],
        },
      };

      // 不传 availableServers：跳过引用存在性校验，应校验通过
      const result = validateGroupConfig(config);
      expect(result.success).toBe(true);
    });

    it('提供空数组 availableServers 时也不校验服务器引用', () => {
      const config = {
        default: {
          id: 'default-group',
          name: 'Default',
          servers: ['server-any'],
          tools: [],
        },
      };

      const result = validateGroupConfig(config, []);
      expect(result.success).toBe(true);
    });

    it('组 ID 包含组名时不输出不匹配告警', () => {
      const config = {
        default: {
          id: 'default-group',
          name: 'Default',
          servers: ['server1'],
          tools: [],
        },
      };

      const result = validateGroupConfig(config, ['server1']);
      expect(result.success).toBe(true);
      expect(logger.warn).not.toHaveBeenCalled();
    });

    it('组 ID 不包含组名时输出告警日志但不影响校验结果', () => {
      const config = {
        mygroup: {
          id: 'totally-different-id',
          name: 'My Group',
          servers: ['server1'],
          tools: [],
        },
      };

      const result = validateGroupConfig(config, ['server1']);
      expect(result.success).toBe(true);
      expect(logger.warn).toHaveBeenCalledWith('组 ID 可能与组名不匹配', {
        groupName: 'mygroup',
        groupId: 'totally-different-id',
      });
    });
  });

  describe('validateSystemConfig', () => {
    it('应该验证有效的系统配置', () => {
      const config = {
        server: {
          port: 3000,
          host: 'localhost',
        },
        auth: {
          jwt: {
            secret: 'test-secret-key-with-sufficient-length-for-security',
            expiresIn: '15m',
            refreshExpiresIn: '7d',
            issuer: 'mcp-knot',
          },
          security: {
            maxLoginAttempts: 5,
            lockoutDuration: 900000,
            passwordMinLength: 6,
            requireStrongPassword: false,
          },
        },
        users: {
          admin: {
            id: 'admin',
            username: 'admin',
            password: 'admin123',
            role: 'admin',
            groups: ['default', 'admin'],
            createdAt: '2024-01-01T00:00:00.000Z',
          },
          user: {
            id: 'user',
            username: 'user',
            password: 'user123',
            role: 'user',
            groups: ['default'],
            createdAt: '2024-01-01T00:00:00.000Z',
          },
        },
        ui: {
          title: 'MCP Knot',
          theme: 'light',
          features: {
            apiToMcp: true,
            debugging: true,
            monitoring: true,
          },
        },
        monitoring: {
          metricsEnabled: true,
          logLevel: 'info',
          retentionDays: 30,
        },
      };

      const result = validateSystemConfig(config);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.users.admin.password).toBe('admin123');
      }
    });

    it('应该拒绝空密码的用户配置', () => {
      const config = {
        users: {
          user: {
            password: '',
            groups: ['default'],
          },
        },
      };

      const result = validateSystemConfig(config);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.errors.some((err) => err.includes('密码不能为空'))).toBe(true);
      }
    });
  });

  describe('validateConfigCrossReferences', () => {
    it('应该验证有效的交叉引用', () => {
      const mcpConfig: McpConfig = {
        servers: {
          server1: {
            type: 'stdio',
            command: 'node',
            args: ['server1.js'],
          },
          server2: {
            type: 'stdio',
            command: 'node',
            args: ['server2.js'],
          },
        },
      };

      const groupConfig: GroupConfig = {
        group1: {
          id: 'group1',
          name: 'Group 1',
          servers: ['server1'],
          tools: [],
        },
        group2: {
          id: 'group2',
          name: 'Group 2',
          servers: ['server2'],
          tools: [],
        },
      };

      const result = validateConfigCrossReferences(mcpConfig, groupConfig);
      expect(result.success).toBe(true);
    });

    it('应该拒绝引用不存在服务器的交叉引用', () => {
      const mcpConfig: McpConfig = {
        servers: {
          server1: {
            type: 'stdio',
            command: 'node',
            args: ['server1.js'],
          },
        },
      };

      const groupConfig: GroupConfig = {
        group1: {
          id: 'group1',
          name: 'Group 1',
          servers: ['server1', 'nonexistent-server'],
          tools: [],
        },
      };

      const result = validateConfigCrossReferences(mcpConfig, groupConfig);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.errors.some((err) => err.includes('引用了未在MCP配置中定义的服务器'))).toBe(
          true,
        );
      }
    });
  });

  describe('validateAllConfigs', () => {
    it('应该验证所有有效配置', () => {
      const mcpConfig = {
        servers: {
          server1: {
            type: 'stdio',
            command: 'node',
            args: ['server1.js'],
          },
        },
      };

      const groupConfig = {
        default: {
          id: 'default',
          name: 'Default',
          servers: ['server1'],
          tools: [],
        },
      };

      const systemConfig = {
        server: {
          port: 3000,
          host: 'localhost',
        },
        auth: {
          jwt: {
            secret: 'test-secret-key-with-sufficient-length-for-security',
            expiresIn: '15m',
            refreshExpiresIn: '7d',
            issuer: 'mcp-knot',
          },
          security: {
            maxLoginAttempts: 5,
            lockoutDuration: 900000,
            passwordMinLength: 6,
            requireStrongPassword: false,
          },
        },
        users: {
          admin: {
            id: 'admin',
            username: 'admin',
            password: 'admin123',
            role: 'admin',
            groups: ['default'],
            createdAt: '2024-01-01T00:00:00.000Z',
          },
        },
        ui: {
          title: 'MCP Knot',
          theme: 'light',
          features: {
            apiToMcp: true,
            debugging: true,
            monitoring: true,
          },
        },
        monitoring: {
          metricsEnabled: true,
          logLevel: 'info',
          retentionDays: 30,
        },
      };

      const result = validateAllConfigs(mcpConfig, groupConfig, systemConfig);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.mcpConfig).toBeDefined();
        expect(result.data.groupConfig).toBeDefined();
        expect(result.data.systemConfig).toBeDefined();
      }
    });

    it('应该在任何配置无效时返回错误', () => {
      const mcpConfig = {
        servers: {}, // 无效：空服务器配置
      };

      const groupConfig = {
        default: {
          id: 'default',
          name: 'Default',
          servers: ['server1'],
          tools: [],
        },
      };

      const result = validateAllConfigs(mcpConfig, groupConfig);
      expect(result.success).toBe(false);
      if (!result.success) {
        // 错误列表不夹带无关内容，且首条为 MCP 配置错误
        expect(result.errors).toHaveLength(
          result.errors.filter((err) => err.startsWith('MCP配置错误')).length,
        );
        expect(result.errors[0]).toMatch(/^MCP配置错误/);
        expect(result.errors.some((err) => err.includes('至少需要配置一个MCP服务器'))).toBe(true);
      }
    });

    it('组配置无效时返回组配置错误', () => {
      const mcpConfig = {
        servers: {
          server1: { type: 'stdio', command: 'node', args: ['server1.js'] },
        },
      };
      const invalidGroupConfig = {
        default: {
          id: 'default',
          name: 'Default',
          servers: ['nonexistent-server'],
          tools: [],
        },
      };

      const result = validateAllConfigs(mcpConfig, invalidGroupConfig);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.errors[0]).toMatch(/^组配置错误/);
        expect(result.errors.some((err) => err.includes('引用了不存在的服务器'))).toBe(true);
      }
    });

    it('系统配置无效时返回系统配置错误', () => {
      const mcpConfig = {
        servers: {
          server1: { type: 'stdio', command: 'node', args: ['server1.js'] },
        },
      };
      const groupConfig = {
        default: { id: 'default', name: 'Default', servers: ['server1'], tools: [] },
      };
      const invalidSystemConfig = { users: {} };

      const result = validateAllConfigs(mcpConfig, groupConfig, invalidSystemConfig);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.errors[0]).toMatch(/^系统配置错误/);
      }
    });

    it('未提供系统配置时校验通过且 systemConfig 为 undefined', () => {
      const mcpConfig = {
        servers: {
          server1: { type: 'stdio', command: 'node', args: ['server1.js'] },
        },
      };
      const groupConfig = {
        default: { id: 'default', name: 'Default', servers: ['server1'], tools: [] },
      };

      const result = validateAllConfigs(mcpConfig, groupConfig);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.mcpConfig.servers['server1']!.type).toBe('stdio');
        expect(result.data.groupConfig.default!.name).toBe('Default');
        expect(result.data.systemConfig).toBeUndefined();
      }
    });
  });
});
