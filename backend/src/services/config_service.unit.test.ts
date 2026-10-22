import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ConfigService } from './config_service.js';

import type { GroupConfig, McpConfig, SystemConfig } from '@mcp-core/mcp-knot-share';

// Mock dependencies
vi.mock('node:fs/promises');
vi.mock('../utils/config.js');
vi.mock('./skills-service.js', () => ({
  getSkillRepository: vi.fn().mockReturnValue({
    catalog: vi.fn().mockResolvedValue([]),
  }),
}));

const { mockNetState, mockSpawnState, factoryMock } = vi.hoisted(() => ({
  mockNetState: { error: null as Error | null },
  mockSpawnState: { closeCode: null as number | null, error: null as Error | null },
  factoryMock: { invalidateAllGroupMcpServices: vi.fn() },
}));

vi.mock('../api/mcp/mcp-handler-factory.js', () => ({
  invalidateAllGroupMcpServices: factoryMock.invalidateAllGroupMcpServices,
}));

vi.mock('node:net', () => ({
  createServer: vi.fn(() => ({
    listen: vi.fn((_port: unknown, _host: unknown, cb: () => void) => {
      if (!mockNetState.error) queueMicrotask(cb);
    }),
    close: vi.fn(),
    on: vi.fn((event: string, cb: (err: NodeJS.ErrnoException) => void) => {
      if (event === 'error' && mockNetState.error) {
        const err = mockNetState.error;
        queueMicrotask(() => cb(err as NodeJS.ErrnoException));
      }
    }),
    removeAllListeners: vi.fn(),
  })),
}));

vi.mock('node:child_process', () => ({
  spawn: vi.fn(() => ({
    kill: vi.fn(),
    on: vi.fn((event: string, cb: (arg?: unknown) => void) => {
      queueMicrotask(() => {
        if (event === 'close' && mockSpawnState.closeCode !== null) {
          cb(mockSpawnState.closeCode);
        } else if (event === 'error' && mockSpawnState.error) {
          cb(mockSpawnState.error);
        }
      });
    }),
    removeAllListeners: vi.fn(),
  })),
}));

interface MockFs {
  readJson: ReturnType<typeof vi.fn>;
  writeJson: ReturnType<typeof vi.fn>;
  pathExists: ReturnType<typeof vi.fn>;
  ensureDir: ReturnType<typeof vi.fn>;
  mkdir: ReturnType<typeof vi.fn>;
  writeFile: ReturnType<typeof vi.fn>;
  stat: ReturnType<typeof vi.fn>;
  readdir: ReturnType<typeof vi.fn>;
  readFile: ReturnType<typeof vi.fn>;
}

/** 组一套完整的默认 system 配置（可覆盖字段） */
function buildSystemConfig(overrides: Record<string, unknown> = {}) {
  return {
    server: { port: 3000, host: 'localhost' },
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
    users: {},
    ui: {
      title: 'MCP Knot',
      theme: 'light',
      features: { apiToMcp: true, debugging: true, monitoring: true },
    },
    monitoring: { metricsEnabled: true, logLevel: 'info', retentionDays: 30 },
    ...overrides,
  };
}

describe('ConfigService', () => {
  let configService: ConfigService;
  let mockFs: MockFs;

  beforeEach(() => {
    vi.clearAllMocks();
    configService = new ConfigService();
    mockFs = vi.mocked(fs);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('getCurrentConfig', () => {
    it('应该成功获取当前配置', async () => {
      const mockConfig = {
        system: {
          server: { port: 3000, host: 'localhost' },
          auth: {
            jwt: {
              secret: 'test-secret-key-with-sufficient-length',
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
          users: {},
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
        } as SystemConfig,
        mcps: { servers: {} } as McpConfig,
        groups: {} as GroupConfig,
      };

      // Mock getAllConfig
      const { getAllConfig } = await import('../utils/config.js');
      vi.mocked(getAllConfig).mockResolvedValue(mockConfig);

      const result = await configService.getCurrentConfig();

      expect(result).toEqual(mockConfig);
    });
  });

  describe('validateConfig', () => {
    it('应该成功验证有效的系统配置', async () => {
      const validSystemConfig = {
        server: { port: 3000, host: 'localhost' },
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
        users: {},
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

      const result = await configService.validateConfig('system', validSystemConfig);

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('应该检测到无效的系统配置', async () => {
      const invalidSystemConfig = {
        server: { port: -1, host: '' },
        auth: {
          jwt: {
            secret: 'short', // 太短的密钥
            expiresIn: '15m',
            refreshExpiresIn: '7d',
            issuer: 'mcp-knot',
          },
          security: {
            maxLoginAttempts: 0, // 无效值
            lockoutDuration: -1, // 无效值
            passwordMinLength: 1, // 太短
            requireStrongPassword: false,
          },
        },
        users: {},
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
          retentionDays: 0, // 无效值
        },
      };

      const result = await configService.validateConfig('system', invalidSystemConfig);

      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);

      // 检查是否包含JWT密钥长度错误
      const jwtSecretError = result.errors.find(
        (error) => error.path === 'auth.jwt.secret' && error.code === 'JWT_SECRET_TOO_SHORT',
      );
      expect(jwtSecretError).toBeDefined();
    });

    it('应该成功验证有效的MCP配置', async () => {
      const validMcpConfig = {
        servers: {
          'test-server': {
            command: 'node',
            args: ['server.js'],
            env: { NODE_ENV: 'production' },
            transport: {
              type: 'stdio' as const,
            },
          },
        },
      };

      const result = await configService.validateConfig('mcp', validMcpConfig);

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('应该检测到无效的MCP配置', async () => {
      const invalidMcpConfig = {
        servers: {
          'invalid-server': {
            command: '', // 空命令
            transport: {
              type: 'sse' as const,
              // 缺少必需的URL
            },
          },
        },
      };

      const result = await configService.validateConfig('mcp', invalidMcpConfig);

      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);

      // 检查是否包含命令为空的错误
      const commandError = result.errors.find(
        (error) => error.path.includes('command') && error.code === 'MISSING_COMMAND',
      );
      expect(commandError).toBeDefined();

      // 检查是否包含SSE URL缺失的错误
      const sseUrlError = result.errors.find(
        (error) => error.path.includes('url') && error.code === 'MISSING_SSE_URL',
      );
      expect(sseUrlError).toBeDefined();
    });

    it('应该成功验证有效的组配置', async () => {
      // Mock getCurrentConfig for group validation
      const mockCurrentConfig = {
        system: {} as SystemConfig,
        mcps: {
          servers: {
            server1: { command: 'test' },
            server2: { command: 'test' },
          },
        } as McpConfig,
        groups: {} as GroupConfig,
      };

      const { getAllConfig } = await import('../utils/config.js');
      vi.mocked(getAllConfig).mockResolvedValue(mockCurrentConfig);

      const validGroupConfig = {
        'test-group': {
          id: 'test-group',
          name: '测试组',
          description: '测试组描述',
          servers: ['server1', 'server2'],
          tools: ['tool1', 'tool2'],
          validation: {
            enabled: true,
            validationKey: 'test-key-123',
          },
        },
      };

      const result = await configService.validateConfig('groups', validGroupConfig);

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('应该检测到无效的组配置', async () => {
      // Mock getCurrentConfig for group validation
      const mockCurrentConfig = {
        system: {} as SystemConfig,
        mcps: {
          servers: {
            server1: { command: 'test' },
          },
        } as McpConfig,
        groups: {} as GroupConfig,
      };

      const { getAllConfig } = await import('../utils/config.js');
      vi.mocked(getAllConfig).mockResolvedValue(mockCurrentConfig);

      const invalidGroupConfig = {
        'invalid-group': {
          id: 'invalid-group',
          name: '无效组',
          servers: ['nonexistent-server'], // 不存在的服务器
          tools: [],
          validation: {
            enabled: true,
            // 缺少验证密钥
          },
        },
      };

      const result = await configService.validateConfig('groups', invalidGroupConfig);

      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);

      // 检查是否包含验证密钥缺失的错误
      const validationKeyError = result.errors.find(
        (error) => error.path.includes('validationKey') && error.code === 'MISSING_VALIDATION_KEY',
      );
      expect(validationKeyError).toBeDefined();

      // 检查是否包含服务器不存在的警告
      expect(result.warnings.length).toBeGreaterThan(0);
      const serverNotFoundWarning = result.warnings.find(
        (warning) => warning.code === 'SERVER_NOT_FOUND',
      );
      expect(serverNotFoundWarning).toBeDefined();
    });
  });

  describe('analyzeConfigImpact', () => {
    it('应该正确分析系统配置的影响', async () => {
      const systemConfig = {
        server: { port: 3001, host: 'localhost' },
      };

      const result = await configService.analyzeConfigImpact('system', systemConfig);

      expect(result.affectedServices).toContain('认证服务');
      expect(result.affectedServices).toContain('Web服务器');
      expect(result.requiresRestart).toBe(true);
      expect(result.recommendations).toContain('建议在维护窗口期间进行系统配置更新');
    });

    it('应该正确分析MCP配置的影响', async () => {
      const mcpConfig = {
        servers: {
          'new-server': {
            command: 'node',
            args: ['server.js'],
          },
        },
      };

      const result = await configService.analyzeConfigImpact('mcp', mcpConfig);

      expect(result.affectedServices).toContain('MCP服务管理器');
      expect(result.requiresRestart).toBe(false);
      expect(result.recommendations).toContain('MCP服务器配置更改将在下次连接时生效');
    });

    it('应该正确分析组配置的影响', async () => {
      const groupConfig = {
        'test-group': {
          id: 'test-group',
          name: '测试组',
          servers: ['server1'],
          tools: ['tool1'],
        },
      };

      const result = await configService.analyzeConfigImpact('groups', groupConfig);

      expect(result.affectedServices).toContain('组管理器');
      expect(result.requiresRestart).toBe(false);
      expect(result.recommendations).toContain('组配置更改将立即生效');
    });
  });

  describe('createBackup', () => {
    it('应该成功创建配置备份', async () => {
      // Mock getCurrentConfig
      const mockConfig = {
        system: { server: { port: 3000, host: 'localhost' } } as SystemConfig,
        mcps: { servers: {} } as McpConfig,
        groups: {} as GroupConfig,
      };

      const { getAllConfig } = await import('../utils/config.js');
      vi.mocked(getAllConfig).mockResolvedValue(mockConfig);

      // Mock fs operations
      mockFs.mkdir.mockResolvedValue(undefined);
      mockFs.writeFile.mockResolvedValue(undefined);

      const backupId = await configService.createBackup('测试备份', ['system', 'mcp']);

      expect(backupId).toBeDefined();
      expect(typeof backupId).toBe('string');
      expect(mockFs.writeFile).toHaveBeenCalled();
    });
  });

  describe('getLastUpdatedTime', () => {
    it('应该返回最新的配置文件修改时间', async () => {
      const mockStats = {
        mtime: new Date('2024-01-01T12:00:00.000Z'),
      };

      mockFs.stat.mockResolvedValue(mockStats);

      const result = await configService.getLastUpdatedTime();

      expect(result).toBe('2024-01-01T12:00:00.000Z');
    });

    it('应该处理文件不存在的情况', async () => {
      mockFs.stat.mockRejectedValue(new Error('文件不存在'));

      const result = await configService.getLastUpdatedTime();

      // 应该返回当前时间的ISO字符串
      expect(result).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    });
  });

  describe('getConfigVersion', () => {
    it('应该基于最后更新时间生成版本号', async () => {
      const mockStats = {
        mtime: new Date('2024-01-01T12:00:00.000Z'),
      };

      mockFs.stat.mockResolvedValue(mockStats);

      const version = await configService.getConfigVersion();

      expect(version).toBeDefined();
      expect(typeof version).toBe('string');
      expect(version).toHaveLength(8); // MD5 hash的前8位
    });
  });

  describe('testConfig', () => {
    it('应该成功测试有效的系统配置', async () => {
      const validSystemConfig = {
        server: { port: 3000, host: 'localhost' },
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
            password: 'admin',
            role: 'admin',
            groups: [],
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

      const result = await configService.testConfig('system', validSystemConfig);

      expect(result.success).toBe(true);
      expect(result.tests.length).toBeGreaterThan(0);
      expect(result.summary.total).toBeGreaterThan(0);

      // 检查是否包含模式验证测试
      const schemaTest = result.tests.find(
        (test: { name: string }) => test.name === 'schema_validation',
      );
      expect(schemaTest).toBeDefined();
      expect(schemaTest?.status).toBe('passed');
    });

    it('应该检测到系统配置中的问题', async () => {
      const invalidSystemConfig = {
        server: { port: -1, host: '' },
        auth: {
          jwt: {
            secret: 'short',
            expiresIn: '15m',
            refreshExpiresIn: '7d',
            issuer: 'mcp-knot',
          },
          security: {
            maxLoginAttempts: 0,
            lockoutDuration: -1,
            passwordMinLength: 1,
            requireStrongPassword: false,
          },
        },
        users: {},
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
          retentionDays: 0,
        },
      };

      const result = await configService.testConfig('system', invalidSystemConfig);

      expect(result.success).toBe(false);
      expect(result.summary.failed).toBeGreaterThan(0);

      // 检查是否包含模式验证失败
      const schemaTest = result.tests.find(
        (test: { name: string }) => test.name === 'schema_validation',
      );
      expect(schemaTest).toBeDefined();
      expect(schemaTest?.status).toBe('failed');
    });

    it('应该测试MCP配置', async () => {
      const mcpConfig = {
        servers: {
          'test-server': {
            command: 'node',
            args: ['server.js'],
            env: { NODE_ENV: 'test' },
            transport: {
              type: 'stdio' as const,
            },
          },
        },
      };

      const result = await configService.testConfig('mcp', mcpConfig);

      expect(result.tests.length).toBeGreaterThan(0);
      expect(result.summary.total).toBeGreaterThan(0);

      // 检查是否包含服务器配置测试
      const serverTests = result.tests.filter((test: { name: string }) =>
        test.name.includes('server_test-server'),
      );
      expect(serverTests.length).toBeGreaterThan(0);
    });
  });

  describe('previewConfigChanges', () => {
    it('应该成功预览配置更改', async () => {
      const mockCurrentConfig = {
        system: {
          server: { port: 3000, host: 'localhost' },
        } as SystemConfig,
        mcps: { servers: {} } as McpConfig,
        groups: {} as GroupConfig,
      };

      const { getAllConfig } = await import('../utils/config.js');
      vi.mocked(getAllConfig).mockResolvedValue(mockCurrentConfig);

      const newConfig = {
        server: { port: 3001, host: 'localhost' },
      };

      const result = await configService.previewConfigChanges('system', newConfig);

      expect(result).toBeDefined();
      expect(result.changes).toBeDefined();
      expect(result.affectedServices).toBeDefined();
      expect(result.rollbackPlan).toBeDefined();
      expect(result.rollbackPlan.length).toBeGreaterThan(0);
    });
  });

  describe('previewConfigChanges（详细断言）', () => {
    beforeEach(async () => {
      const { getAllConfig } = await import('../utils/config.js');
      vi.mocked(getAllConfig).mockResolvedValue({
        system: buildSystemConfig() as SystemConfig,
        mcps: { servers: {} } as McpConfig,
        groups: {} as GroupConfig,
      });
    });

    it('配置无变化时 changes 为空数组', async () => {
      const result = await configService.previewConfigChanges('system', buildSystemConfig());
      expect(result.changes).toEqual([]);
      expect(result.rollbackPlan).toHaveLength(5);
    });

    it('配置变化时生成 root update 变更与回滚计划', async () => {
      const oldConfig = buildSystemConfig();
      const newConfig = buildSystemConfig({ server: { port: 3001, host: '0.0.0.0' } });
      const result = await configService.previewConfigChanges('system', newConfig);

      expect(result.changes).toHaveLength(1);
      expect(result.changes[0]).toMatchObject({
        path: 'root',
        operation: 'update',
        oldValue: oldConfig,
        newValue: newConfig,
      });
      expect(result.rollbackPlan).toEqual([
        '1. 停止相关服务 (如果需要)',
        '2. 恢复 system 配置到之前的版本',
        '3. 验证配置恢复成功',
        '4. 重启相关服务 (如果需要)',
        '5. 验证系统功能正常',
      ]);
      expect(result.recommendations).toContain('建议在维护窗口期间进行系统配置更新');
    });

    it('不支持的配置类型抛 ConfigError', async () => {
      await expect(configService.previewConfigChanges('unknown' as never, {})).rejects.toThrow(
        /不支持的配置类型/,
      );
    });
  });

  describe('updateConfig', () => {
    beforeEach(async () => {
      const { getAllConfig, saveConfig } = await import('../utils/config.js');
      vi.mocked(getAllConfig).mockResolvedValue({
        system: buildSystemConfig() as SystemConfig,
        mcps: { servers: {} } as McpConfig,
        groups: {} as GroupConfig,
      });
      vi.mocked(saveConfig).mockResolvedValue(undefined);
      mockFs.writeFile.mockResolvedValue(undefined);
      mockFs.stat.mockResolvedValue({ mtime: new Date('2024-01-01T00:00:00Z') } as never);
    });

    it('更新 system 配置：写入 system.json 并记录历史', async () => {
      const newConfig = buildSystemConfig({ server: { port: 3001, host: 'localhost' } });
      await configService.updateConfig('system', newConfig, '更新端口', 'alice');

      const { saveConfig } = await import('../utils/config.js');
      expect(vi.mocked(saveConfig)).toHaveBeenCalledWith('system.json', newConfig);
      // groups 才触发失效，system 不触发
      expect(factoryMock.invalidateAllGroupMcpServices).not.toHaveBeenCalled();

      // 历史记录内容
      expect(mockFs.writeFile).toHaveBeenCalledTimes(1);
      const history = JSON.parse(mockFs.writeFile.mock.calls[0][1] as string);
      expect(history.configType).toBe('system');
      expect(history.description).toBe('更新端口');
      expect(history.user).toBe('alice');
      expect(history.changes).toEqual([
        {
          path: 'root',
          operation: 'update',
          oldValue: expect.any(Object),
          newValue: newConfig,
        },
      ]);
      expect(history.version).toHaveLength(8);
    });

    it('更新 mcp 配置：写入 mcp_server.json', async () => {
      const newMcp = { servers: { s1: { command: 'node' } } };
      await configService.updateConfig('mcp', newMcp);
      const { saveConfig } = await import('../utils/config.js');
      expect(vi.mocked(saveConfig)).toHaveBeenCalledWith('mcp_server.json', newMcp);
      // 未提供 user 时历史记录 user 默认 system
      const history = JSON.parse(mockFs.writeFile.mock.calls[0][1] as string);
      expect(history.user).toBe('system');
      expect(history.description).toBeUndefined();
    });

    it('更新 groups 配置：校验通过后写入 group.json 并失效组服务', async () => {
      const { getAllConfig } = await import('../utils/config.js');
      vi.mocked(getAllConfig).mockResolvedValue({
        system: buildSystemConfig() as SystemConfig,
        mcps: {
          servers: {
            server1: { command: 'node', args: [], enabled: true },
          },
        } as unknown as McpConfig,
        groups: {} as GroupConfig,
      });
      const newGroups = {
        default: {
          id: 'default',
          name: 'Default',
          description: '',
          servers: ['server1'],
          tools: [],
        },
      };

      await configService.updateConfig('groups', newGroups);
      const { saveConfig } = await import('../utils/config.js');
      expect(vi.mocked(saveConfig)).toHaveBeenCalledWith('group.json', newGroups);
      expect(factoryMock.invalidateAllGroupMcpServices).toHaveBeenCalledTimes(1);
    });

    it('更新 groups 配置校验失败时不写入', async () => {
      const { getAllConfig } = await import('../utils/config.js');
      vi.mocked(getAllConfig).mockResolvedValue({
        system: buildSystemConfig() as SystemConfig,
        mcps: { servers: { server1: { command: 'node' } } } as unknown as McpConfig,
        groups: {} as GroupConfig,
      });
      const invalidGroups = {
        default: {
          id: 'default',
          name: 'Default',
          description: '',
          servers: ['server1'],
          tools: [],
          validation: { enabled: true }, // 缺 validationKey
        },
      };
      await expect(configService.updateConfig('groups', invalidGroups)).rejects.toThrow(
        /启用验证时必须提供验证密钥/,
      );
      const { saveConfig } = await import('../utils/config.js');
      expect(vi.mocked(saveConfig)).not.toHaveBeenCalled();
    });

    it('不支持的配置类型抛 ConfigError', async () => {
      await expect(configService.updateConfig('unknown' as never, {})).rejects.toThrow(
        /不支持的配置类型/,
      );
    });
  });

  describe('validateConfig（补充场景）', () => {
    it('端口小于 1024 时产生权限警告但不影响 valid', async () => {
      const lowPortConfig = buildSystemConfig({ server: { port: 80, host: 'localhost' } });
      const result = await configService.validateConfig('system', lowPortConfig);
      expect(result.valid).toBe(true);
      expect(result.warnings).toEqual([
        {
          path: 'server.port',
          message: '使用小于1024的端口可能需要管理员权限',
          code: 'PORT_PRIVILEGE_WARNING',
          severity: 'warning',
        },
      ]);
    });

    it('不支持的配置类型进入 catch 产生 root 错误', async () => {
      const result = await configService.validateConfig('unknown' as never, {});
      expect(result.valid).toBe(false);
      expect(result.errors).toEqual([
        {
          path: 'root',
          message: expect.stringContaining('不支持的配置类型'),
          code: 'VALIDATION_ERROR',
          severity: 'error',
        },
      ]);
    });

    it('组引用不存在的 server 只产生 warning', async () => {
      const { getAllConfig } = await import('../utils/config.js');
      vi.mocked(getAllConfig).mockResolvedValue({
        system: {} as SystemConfig,
        mcps: { servers: { server1: { command: 'node' } } } as unknown as McpConfig,
        groups: {} as GroupConfig,
      });
      const result = await configService.validateConfig('groups', {
        default: {
          id: 'default',
          name: 'Default',
          description: '',
          servers: ['server1', 'ghost'],
          tools: [],
        },
      });
      expect(result.valid).toBe(true);
      expect(result.warnings).toEqual([
        {
          path: 'default.servers',
          message: '服务器 "ghost" 不存在于MCP配置中',
          code: 'SERVER_NOT_FOUND',
          severity: 'warning',
        },
      ]);
    });

    it('组 skills 引用无效时产生错误', async () => {
      const { getSkillRepository } = await import('./skills-service.js');
      vi.mocked(getSkillRepository().catalog).mockRejectedValue(new Error('技能不存在'));
      const { getAllConfig } = await import('../utils/config.js');
      vi.mocked(getAllConfig).mockResolvedValue({
        system: {} as SystemConfig,
        mcps: { servers: { server1: { command: 'node' } } } as unknown as McpConfig,
        groups: {} as GroupConfig,
      });
      const result = await configService.validateConfig('groups', {
        default: {
          id: 'default',
          name: 'Default',
          description: '',
          servers: ['server1'],
          tools: [],
          skills: ['bad-skill'],
        },
      });
      expect(result.valid).toBe(false);
      const skillError = result.errors.find((e) => e.code === 'INVALID_SKILL_SELECTION');
      expect(skillError).toMatchObject({
        path: 'default.skills',
        message: '技能不存在',
      });
    });
  });

  describe('getConfigHistory / getConfigHistoryCount', () => {
    const makeHistoryFile = (id: string) => `${id}.json`;

    it('按时间戳倒序分页返回历史条目', async () => {
      // 注：排序键取文件名 split('-')[0]（年份），故用不同年份验证倒序
      mockFs.readdir.mockResolvedValue([
        makeHistoryFile('2024-03-01T00:00:00.000Z-system-aaa'),
        makeHistoryFile('2023-01-01T00:00:00.000Z-mcp-bbb'),
        makeHistoryFile('2025-02-01T00:00:00.000Z-groups-ccc'),
      ] as never);
      mockFs.readFile.mockImplementation(async (p: unknown) =>
        JSON.stringify({ id: String(p).split('/').pop(), configType: 'x' }),
      );

      const history = await configService.getConfigHistory(2, 0);
      expect(history).toHaveLength(2);
      expect(history[0]?.id).toBe('2025-02-01T00:00:00.000Z-groups-ccc.json');
      expect(history[1]?.id).toBe('2024-03-01T00:00:00.000Z-system-aaa.json');

      const page2 = await configService.getConfigHistory(2, 2);
      expect(page2).toHaveLength(1);
      expect(page2[0]?.id).toBe('2023-01-01T00:00:00.000Z-mcp-bbb.json');
    });

    it('按 configType 过滤（文件名含 -system-）', async () => {
      mockFs.readdir.mockResolvedValue([
        makeHistoryFile('2024-03-01T00:00:00.000Z-system-aaa'),
        makeHistoryFile('2023-01-01T00:00:00.000Z-mcp-bbb'),
      ] as never);
      const history = await configService.getConfigHistory(10, 0, 'system');
      expect(history).toHaveLength(1);
      expect(history[0]?.id).toBe('2024-03-01T00:00:00.000Z-system-aaa.json');
      expect(await configService.getConfigHistoryCount('system')).toBe(1);
      expect(await configService.getConfigHistoryCount()).toBe(2);
    });

    it('单个文件读取失败时跳过该文件', async () => {
      mockFs.readdir.mockResolvedValue([
        makeHistoryFile('2024-03-01T00:00:00.000Z-system-aaa'),
        makeHistoryFile('2024-02-01T00:00:00.000Z-system-bad'),
      ] as never);
      mockFs.readFile.mockImplementation(async (p: unknown) => {
        if (String(p).includes('bad')) throw new Error('corrupted');
        return JSON.stringify({ id: 'ok' });
      });
      const history = await configService.getConfigHistory(10, 0);
      expect(history).toEqual([{ id: 'ok' }]);
    });

    it('目录读取失败返回空数组 / 计数 0', async () => {
      mockFs.readdir.mockRejectedValue(new Error('ENOENT') as never);
      expect(await configService.getConfigHistory(10, 0)).toEqual([]);
      expect(await configService.getConfigHistoryCount()).toBe(0);
    });
  });

  describe('createBackup（详细断言）', () => {
    it('备份包含指定类型、记录大小与默认用户', async () => {
      const { getAllConfig } = await import('../utils/config.js');
      vi.mocked(getAllConfig).mockResolvedValue({
        system: buildSystemConfig() as SystemConfig,
        mcps: { servers: { s1: { command: 'node' } } } as unknown as McpConfig,
        groups: { default: { id: 'default', name: 'd', servers: [], tools: [] } } as GroupConfig,
      });
      mockFs.writeFile.mockResolvedValue(undefined);

      const backupId = await configService.createBackup('全量备份');

      expect(backupId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
      const content = mockFs.writeFile.mock.calls[0][1] as string;
      const backup = JSON.parse(content);
      expect(backup.id).toBe(backupId);
      expect(backup.description).toBe('全量备份');
      expect(backup.user).toBe('system');
      expect(backup.configTypes).toEqual(['system', 'mcp', 'groups']);
      expect(backup.configs.system).toEqual(buildSystemConfig());
      expect(backup.configs.mcp).toEqual({ servers: { s1: { command: 'node' } } });
      expect(backup.configs.groups.default).toBeDefined();
      // 注：生产代码先 stringify 再设置 size，落盘的 size 恒为 0（疑似 bug，见批次报告）
      expect(backup.size).toBe(0);
      // 备份文件路径包含时间戳与 id
      expect(String(mockFs.writeFile.mock.calls[0][0])).toContain(backupId);
    });
  });

  describe('restoreFromBackup', () => {
    const backupId = '11111111-2222-3333-4444-555555555555';
    const backupContent = {
      id: backupId,
      timestamp: '2024-01-01T00:00:00.000Z',
      configTypes: ['system', 'mcp', 'groups'],
      size: 100,
      user: 'admin',
      configs: {
        system: buildSystemConfig(),
        mcp: { servers: { s1: { command: 'node' } } },
        groups: {
          default: {
            id: 'default',
            name: 'Default',
            description: '',
            servers: ['s1'],
            tools: [],
          },
        },
      },
    };

    beforeEach(() => {
      mockFs.readdir.mockResolvedValue([`2024-01-01T00:00:00.000Z-${backupId}.json`] as never);
      mockFs.readFile.mockResolvedValue(JSON.stringify(backupContent));
      mockFs.writeFile.mockResolvedValue(undefined);
      mockFs.stat.mockResolvedValue({ mtime: new Date() } as never);
    });

    it('恢复备份内全部配置类型并记录恢复历史', async () => {
      const { getAllConfig, saveConfig } = await import('../utils/config.js');
      vi.mocked(getAllConfig).mockResolvedValue({
        system: buildSystemConfig() as SystemConfig,
        mcps: { servers: { s1: { command: 'node' } } } as unknown as McpConfig,
        groups: {} as GroupConfig,
      });
      vi.mocked(saveConfig).mockResolvedValue(undefined);

      await configService.restoreFromBackup(backupId);

      expect(vi.mocked(saveConfig)).toHaveBeenCalledTimes(3);
      expect(vi.mocked(saveConfig)).toHaveBeenNthCalledWith(
        1,
        'system.json',
        backupContent.configs.system,
      );
      expect(vi.mocked(saveConfig)).toHaveBeenNthCalledWith(
        2,
        'mcp_server.json',
        backupContent.configs.mcp,
      );
      expect(vi.mocked(saveConfig)).toHaveBeenNthCalledWith(
        3,
        'group.json',
        backupContent.configs.groups,
      );
      expect(factoryMock.invalidateAllGroupMcpServices).toHaveBeenCalledTimes(1);
      // 恢复操作的历史记录
      const history = JSON.parse(mockFs.writeFile.mock.calls[0][1] as string);
      expect(history.configType).toBe('system');
      expect(history.changes[0]).toMatchObject({
        path: 'root',
        operation: 'update',
        newValue: { restored: true, backupId, configTypes: ['system', 'mcp', 'groups'] },
      });
    });

    it('仅恢复指定类型；备份缺失的类型跳过', async () => {
      const { getAllConfig, saveConfig } = await import('../utils/config.js');
      vi.mocked(getAllConfig).mockResolvedValue({
        system: buildSystemConfig() as SystemConfig,
        mcps: { servers: {} } as McpConfig,
        groups: {} as GroupConfig,
      });
      vi.mocked(saveConfig).mockResolvedValue(undefined);
      // 备份只有 system
      mockFs.readFile.mockResolvedValue(
        JSON.stringify({
          ...backupContent,
          configTypes: ['system'],
          configs: { system: backupContent.configs.system },
        }),
      );

      await configService.restoreFromBackup(backupId, ['system', 'mcp']);
      expect(vi.mocked(saveConfig)).toHaveBeenCalledTimes(1);
      expect(vi.mocked(saveConfig)).toHaveBeenCalledWith(
        'system.json',
        backupContent.configs.system,
      );
      expect(factoryMock.invalidateAllGroupMcpServices).not.toHaveBeenCalled();
    });

    it('备份文件不存在时抛 ConfigError', async () => {
      mockFs.readdir.mockResolvedValue([] as never);
      await expect(configService.restoreFromBackup('missing-id')).rejects.toThrow(/备份文件不存在/);
    });

    it('恢复的 groups 校验失败时中断（不写任何配置）', async () => {
      const { getAllConfig, saveConfig } = await import('../utils/config.js');
      vi.mocked(getAllConfig).mockResolvedValue({
        system: buildSystemConfig() as SystemConfig,
        mcps: { servers: {} } as McpConfig,
        groups: {} as GroupConfig,
      });
      mockFs.readFile.mockResolvedValue(
        JSON.stringify({
          ...backupContent,
          configs: {
            ...backupContent.configs,
            groups: {
              default: {
                id: 'default',
                name: 'Default',
                description: '',
                servers: ['s1'],
                tools: [],
                validation: { enabled: true }, // 缺 key
              },
            },
          },
        }),
      );

      await expect(configService.restoreFromBackup(backupId)).rejects.toThrow(
        /启用验证时必须提供验证密钥/,
      );
      expect(vi.mocked(saveConfig)).not.toHaveBeenCalled();
    });
  });

  describe('getBackupList / getBackupCount', () => {
    it('按时间倒序分页返回备份元数据（不含 configs）', async () => {
      // 排序键为文件名 split('-')[0]（年份），用不同年份验证倒序
      mockFs.readdir.mockResolvedValue([
        '2023-01-01T00:00:00.000Z-a.json',
        '2025-03-01T00:00:00.000Z-b.json',
        '2024-02-01T00:00:00.000Z-c.json',
      ] as never);
      mockFs.readFile.mockImplementation(async (p: unknown) =>
        JSON.stringify({
          id: String(p).split('/').pop(),
          timestamp: '2024-01-01T00:00:00.000Z',
          description: 'd',
          configTypes: ['system'],
          size: 10,
          user: 'admin',
          configs: { system: { secret: 'should-not-leak' } },
        }),
      );

      const backups = await configService.getBackupList(2, 0);
      expect(backups).toHaveLength(2);
      expect(backups[0]?.id).toBe('2025-03-01T00:00:00.000Z-b.json');
      expect(backups[1]?.id).toBe('2024-02-01T00:00:00.000Z-c.json');
      expect(backups[0]).toEqual({
        id: backups[0]?.id,
        timestamp: '2024-01-01T00:00:00.000Z',
        description: 'd',
        configTypes: ['system'],
        size: 10,
        user: 'admin',
      });
      expect(await configService.getBackupCount()).toBe(3);
    });

    it('单个备份读取损坏时跳过', async () => {
      mockFs.readdir.mockResolvedValue(['a.json', 'bad.json'] as never);
      mockFs.readFile.mockImplementation(async (p: unknown) => {
        if (String(p).includes('bad')) throw new Error('corrupted');
        return JSON.stringify({ id: 'a', timestamp: 't', configTypes: [], size: 0, user: 'u' });
      });
      expect(await configService.getBackupList(10, 0)).toHaveLength(1);
      expect(await configService.getBackupCount()).toBe(2);
    });

    it('目录读取失败返回空列表 / 0', async () => {
      mockFs.readdir.mockRejectedValue(new Error('ENOENT') as never);
      expect(await configService.getBackupList(10, 0)).toEqual([]);
      expect(await configService.getBackupCount()).toBe(0);
    });
  });

  describe('getLastUpdatedTime / getConfigVersion（补充）', () => {
    it('返回三个配置文件中最新的修改时间', async () => {
      mockFs.stat.mockImplementation(async (p: unknown) => {
        const file = String(p).split('/').pop();
        if (file === 'system.json') return { mtime: new Date('2024-01-01T00:00:00Z') } as never;
        if (file === 'mcp_server.json') return { mtime: new Date('2024-06-01T00:00:00Z') } as never;
        return { mtime: new Date('2024-03-01T00:00:00Z') } as never;
      });

      expect(await configService.getLastUpdatedTime()).toBe('2024-06-01T00:00:00.000Z');
      // 版本号基于该时间的 md5 前 8 位，稳定可复现
      const version = await configService.getConfigVersion();
      expect(version).toBe(
        crypto.createHash('md5').update('2024-06-01T00:00:00.000Z').digest('hex').slice(0, 8),
      );
    });
  });

  describe('testConfig（详细场景）', () => {
    describe('system 配置', () => {
      it('端口可用、JWT 正常、有用户：全部通过', async () => {
        mockNetState.error = null;
        const config = buildSystemConfig({
          users: {
            admin: {
              id: 'admin',
              username: 'admin',
              password: 'x',
              role: 'admin',
              groups: [],
              createdAt: '2024-01-01T00:00:00.000Z',
            },
          },
        });
        const result = await configService.testConfig('system', config);

        expect(result.success).toBe(true);
        expect(result.summary).toEqual({ total: 4, passed: 4, failed: 0, warnings: 0 });
        const portTest = result.tests.find((t) => t.name === 'port_availability');
        expect(portTest?.status).toBe('passed');
        expect(portTest?.message).toBe('端口 3000 可用');
        const jwtTest = result.tests.find((t) => t.name === 'jwt_functionality');
        expect(jwtTest?.status).toBe('passed');
        const userTest = result.tests.find((t) => t.name === 'user_configuration');
        expect(userTest?.status).toBe('passed');
        expect(userTest?.message).toBe('配置了 1 个用户');
      });

      it('端口被占用（EADDRINUSE）：port_availability 失败', async () => {
        mockNetState.error = Object.assign(new Error('listen EADDRINUSE'), { code: 'EADDRINUSE' });
        try {
          const result = await configService.testConfig('system', buildSystemConfig());
          expect(result.success).toBe(false);
          const portTest = result.tests.find((t) => t.name === 'port_availability');
          expect(portTest?.status).toBe('failed');
          expect(portTest?.message).toContain('已被占用');
        } finally {
          mockNetState.error = null;
        }
      });

      it('未配置用户：user_configuration 警告（不视为失败）', async () => {
        mockNetState.error = null;
        const result = await configService.testConfig('system', buildSystemConfig());
        const userTest = result.tests.find((t) => t.name === 'user_configuration');
        expect(userTest?.status).toBe('warning');
        expect(userTest?.message).toBe('没有配置任何用户，系统将无法登录');
        expect(result.success).toBe(true);
        expect(result.summary.warnings).toBe(1);
      });

      it('JWT 配置异常：jwt_functionality 失败', async () => {
        mockNetState.error = null;
        const badJwtConfig = buildSystemConfig();
        (badJwtConfig.auth.jwt as { secret: string }).secret = '';
        const result = await configService.testConfig('system', badJwtConfig);

        const jwtTest = result.tests.find((t) => t.name === 'jwt_functionality');
        expect(jwtTest?.status).toBe('failed');
        expect(jwtTest?.message).toBe('JWT功能测试失败');
        expect(result.success).toBe(false);
      });
    });

    describe('mcp 配置', () => {
      afterEach(() => {
        mockSpawnState.closeCode = null;
        mockSpawnState.error = null;
      });

      it('命令可执行、含环境变量与 SSE 传输：全部通过', async () => {
        mockSpawnState.closeCode = 0;
        const result = await configService.testConfig('mcp', {
          servers: {
            s1: {
              command: 'node',
              args: [],
              enabled: true,
              env: { A: '1', B: '2' },
              transport: { type: 'sse', url: 'http://upstream/sse' },
            },
          },
        });

        expect(result.success).toBe(true);
        const cmdTest = result.tests.find((t) => t.name === 'server_s1_command');
        expect(cmdTest?.status).toBe('passed');
        expect(cmdTest?.message).toBe('命令 "node" 可执行');
        const envTest = result.tests.find((t) => t.name === 'server_s1_env');
        expect(envTest?.status).toBe('passed');
        expect(envTest?.message).toBe('配置了 2 个环境变量');
        const transportTest = result.tests.find((t) => t.name === 'server_s1_transport');
        expect(transportTest?.status).toBe('passed');
        expect(transportTest?.message).toBe('SSE传输配置正确: http://upstream/sse');
      });

      it('命令退出码非 0：警告（不视为失败）', async () => {
        mockSpawnState.closeCode = 1;
        const result = await configService.testConfig('mcp', {
          servers: { s1: { command: 'node', args: [], enabled: true } },
        });
        const cmdTest = result.tests.find((t) => t.name === 'server_s1_command');
        expect(cmdTest?.status).toBe('warning');
        expect(cmdTest?.message).toBe('命令 "node" 测试失败');
        expect(cmdTest?.details).toBe('命令退出码: 1');
        expect(result.success).toBe(true);
      });

      it('spawn 报错：命令测试警告', async () => {
        mockSpawnState.error = new Error('ENOENT');
        const result = await configService.testConfig('mcp', {
          servers: { s1: { command: 'ghost-cmd', args: [], enabled: true } },
        });
        const cmdTest = result.tests.find((t) => t.name === 'server_s1_command');
        expect(cmdTest?.status).toBe('warning');
        expect(cmdTest?.details).toBe('ENOENT');
      });

      it('非 SSE 传输：直接报告传输类型', async () => {
        const result = await configService.testConfig('mcp', {
          servers: {
            s1: {
              command: 'node',
              args: [],
              enabled: true,
              transport: { type: 'http', url: 'http://upstream' },
            },
          },
        });
        const transportTest = result.tests.find((t) => t.name === 'server_s1_transport');
        expect(transportTest?.status).toBe('passed');
        expect(transportTest?.message).toBe('http 传输配置正确');
      });
    });

    describe('groups 配置', () => {
      beforeEach(async () => {
        const { getAllConfig } = await import('../utils/config.js');
        vi.mocked(getAllConfig).mockResolvedValue({
          system: {} as SystemConfig,
          mcps: {
            servers: {
              server1: { command: 'node', args: [], enabled: true },
            },
          } as unknown as McpConfig,
          groups: {} as GroupConfig,
        });
      });

      it('服务器引用全部有效：通过', async () => {
        const result = await configService.testConfig('groups', {
          default: {
            id: 'default',
            name: 'Default',
            description: '',
            servers: ['server1'],
            tools: [],
          },
        });
        const serversTest = result.tests.find((t) => t.name === 'group_default_servers');
        expect(serversTest?.status).toBe('passed');
        expect(serversTest?.message).toBe('所有服务器引用有效 (1 个)');
        expect(result.success).toBe(true);
      });

      it('引用不存在的服务器：警告并列出无效名称', async () => {
        const result = await configService.testConfig('groups', {
          default: {
            id: 'default',
            name: 'Default',
            description: '',
            servers: ['server1', 'ghost'],
            tools: [],
          },
        });
        const serversTest = result.tests.find((t) => t.name === 'group_default_servers');
        expect(serversTest?.status).toBe('warning');
        expect(serversTest?.message).toBe('引用了不存在的服务器: ghost');
      });

      it('启用验证但缺少密钥：失败', async () => {
        const result = await configService.testConfig('groups', {
          default: {
            id: 'default',
            name: 'Default',
            description: '',
            servers: [],
            tools: [],
            validation: { enabled: true },
          },
        });
        const validationTest = result.tests.find((t) => t.name === 'group_default_validation');
        expect(validationTest?.status).toBe('failed');
        expect(validationTest?.message).toBe('启用了验证但未设置验证密钥');
        expect(result.success).toBe(false);
      });

      it('验证配置齐全：通过', async () => {
        const result = await configService.testConfig('groups', {
          default: {
            id: 'default',
            name: 'Default',
            description: '',
            servers: [],
            tools: [],
            validation: { enabled: true, validationKey: 'k' },
          },
        });
        const validationTest = result.tests.find((t) => t.name === 'group_default_validation');
        expect(validationTest?.status).toBe('passed');
      });
    });
  });
});
