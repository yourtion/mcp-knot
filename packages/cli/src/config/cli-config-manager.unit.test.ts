/**
 * CLI配置管理器单元测试
 */

import { UnifiedLogger } from '@mcp-core/mcp-knot-share';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CliConfigManager } from './cli-config-manager';

import type { CliConfig, CliError } from '../types/index';

describe('CliConfigManager', () => {
  let configManager: CliConfigManager;
  let tempDir: string;
  let tempConfigPath: string;

  beforeEach(async () => {
    configManager = new CliConfigManager();
    tempDir = await mkdtemp(join(tmpdir(), 'mcp-knot-cli-config-'));
    tempConfigPath = join(tempDir, 'test-config.json');
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });

    // 清除缓存
    configManager.clearCache();
  });

  describe('loadConfig', () => {
    it('应该成功加载有效的配置文件', async () => {
      const validConfig: CliConfig = {
        servers: {
          test_server: {
            command: 'node',
            args: ['test.js'],
            env: { NODE_ENV: 'test' },
          },
        },
        logging: {
          level: 'debug',
        },
        transport: {
          type: 'stdio',
        },
      };

      await writeFile(tempConfigPath, JSON.stringify(validConfig, null, 2));

      const loadedConfig = await configManager.loadConfig(tempConfigPath);

      expect(loadedConfig).toEqual(validConfig);
    });

    it('应该使用默认值填充缺失的配置项', async () => {
      const minimalConfig = {
        servers: {
          test_server: {
            command: 'node',
          },
        },
      };

      await writeFile(tempConfigPath, JSON.stringify(minimalConfig, null, 2));

      const loadedConfig = await configManager.loadConfig(tempConfigPath);

      expect(loadedConfig.logging.level).toBe('info');
      expect(loadedConfig.transport.type).toBe('stdio');
    });

    it('应该在配置文件不存在时抛出错误', async () => {
      const nonExistentPath = join(tempDir, 'nonexistent.json');

      await expect(configManager.loadConfig(nonExistentPath)).rejects.toThrow('配置文件不存在');
    });

    it('应该在JSON格式无效时抛出错误', async () => {
      await writeFile(tempConfigPath, '{ invalid json }');

      await expect(configManager.loadConfig(tempConfigPath)).rejects.toThrow(
        '配置文件JSON格式无效',
      );
    });

    it('应该在配置格式无效时抛出错误', async () => {
      const invalidConfig = {
        servers: {}, // 空的服务器配置
      };

      await writeFile(tempConfigPath, JSON.stringify(invalidConfig));

      await expect(configManager.loadConfig(tempConfigPath)).rejects.toThrow(
        '至少需要配置一个服务器',
      );
    });

    it('应该缓存已加载的配置', async () => {
      const validConfig = {
        servers: {
          test_server: {
            command: 'node',
          },
        },
      };

      await writeFile(tempConfigPath, JSON.stringify(validConfig));

      // 第一次加载
      const config1 = await configManager.loadConfig(tempConfigPath);

      // 第二次加载应该使用缓存
      const config2 = await configManager.loadConfig(tempConfigPath);

      expect(config1).toBe(config2); // 应该是同一个对象引用
    });
  });

  describe('validateConfig', () => {
    it('应该验证有效配置', () => {
      const validConfig: CliConfig = {
        servers: {
          test_server: {
            command: 'node',
            args: ['test.js'],
          },
        },
        logging: {
          level: 'info',
        },
        transport: {
          type: 'stdio',
        },
      };

      expect(configManager.validateConfig(validConfig)).toBe(true);
    });

    it('应该拒绝无效配置', () => {
      const invalidConfig = {
        servers: {
          test_server: {
            command: '', // 空命令
          },
        },
      } as CliConfig;

      expect(configManager.validateConfig(invalidConfig)).toBe(false);
    });
  });

  describe('generateDefaultConfig', () => {
    it('应该生成有效的默认配置', () => {
      const defaultConfig = configManager.generateDefaultConfig();

      expect(configManager.validateConfig(defaultConfig)).toBe(true);
      expect(defaultConfig.servers).toBeDefined();
      expect(Object.keys(defaultConfig.servers).length).toBeGreaterThan(0);
      expect(defaultConfig.logging.level).toBe('info');
      expect(defaultConfig.transport.type).toBe('stdio');
    });
  });

  describe('getConfigTemplate', () => {
    it('应该返回格式化的JSON字符串', () => {
      const template = configManager.getConfigTemplate();

      expect(typeof template).toBe('string');
      expect(() => JSON.parse(template)).not.toThrow();

      const parsedTemplate = JSON.parse(template);
      expect(configManager.validateConfig(parsedTemplate)).toBe(true);
    });
  });

  describe('clearCache', () => {
    it('应该清除配置缓存', async () => {
      const validConfig = {
        servers: {
          test_server: {
            command: 'node',
          },
        },
      };

      await writeFile(tempConfigPath, JSON.stringify(validConfig));

      // 加载配置到缓存
      await configManager.loadConfig(tempConfigPath);

      const statusBefore = configManager.getCacheStatus();
      expect(statusBefore.cacheSize).toBe(1);

      // 清除缓存
      configManager.clearCache();

      const statusAfter = configManager.getCacheStatus();
      expect(statusAfter.cacheSize).toBe(0);
    });
  });

  describe('getCacheStatus', () => {
    it('应该返回正确的缓存状态', async () => {
      const initialStatus = configManager.getCacheStatus();
      expect(initialStatus.cacheSize).toBe(0);
      expect(initialStatus.cachedPaths).toEqual([]);

      // 加载配置
      const validConfig = {
        servers: {
          test_server: {
            command: 'node',
          },
        },
      };

      await writeFile(tempConfigPath, JSON.stringify(validConfig));
      await configManager.loadConfig(tempConfigPath);

      const statusAfterLoad = configManager.getCacheStatus();
      expect(statusAfterLoad.cacheSize).toBe(1);
      expect(statusAfterLoad.cachedPaths).toHaveLength(1);
    });
  });

  describe('validateServerConfig', () => {
    it('应该验证有效的服务器配置', () => {
      const validServerConfig = {
        command: 'node',
        args: ['server.js'],
        env: { NODE_ENV: 'production' },
        disabled: false,
      };

      expect(configManager.validateServerConfig(validServerConfig)).toBe(true);
    });

    it('应该拒绝无效的服务器配置', () => {
      const invalidServerConfig = {
        command: '', // 空命令
        args: ['server.js'],
      };

      expect(configManager.validateServerConfig(invalidServerConfig)).toBe(false);
    });
  });

  describe('mergeConfigs', () => {
    it('应该正确合并配置', () => {
      const baseConfig: CliConfig = {
        servers: {
          server1: {
            command: 'node',
            args: ['server1.js'],
          },
        },
        logging: {
          level: 'info',
        },
        transport: {
          type: 'stdio',
        },
      };

      const overrideConfig: Partial<CliConfig> = {
        servers: {
          server2: {
            command: 'python',
            args: ['server2.py'],
          },
        },
        logging: {
          level: 'debug',
        },
      };

      const mergedConfig = configManager.mergeConfigs(baseConfig, overrideConfig);

      expect(mergedConfig.servers.server1).toEqual(baseConfig.servers.server1);
      expect(mergedConfig.servers.server2).toEqual(overrideConfig.servers?.server2);
      expect(mergedConfig.logging.level).toBe('debug');
      expect(mergedConfig.transport.type).toBe('stdio');
    });
  });

  describe('loadConfig 错误结构', () => {
    it('文件不存在时应抛出带绝对路径详情的 CONFIG_FILE_NOT_FOUND', async () => {
      const missingPath = join(tempDir, 'missing.json');

      const error = await configManager.loadConfig(missingPath).catch((e: CliError) => e);

      expect(error).toBeInstanceOf(Error);
      expect(error.code).toBe('CONFIG_FILE_NOT_FOUND');
      expect(error.message).toBe(`配置文件不存在: ${resolve(missingPath)}`);
      expect(error.details).toEqual({ filePath: resolve(missingPath) });
    });

    it('JSON 解析失败时应抛出 INVALID_CONFIG_FORMAT 并带解析错误详情', async () => {
      await writeFile(tempConfigPath, '{ invalid');

      const error = await configManager.loadConfig(tempConfigPath).catch((e: CliError) => e);

      expect(error.code).toBe('INVALID_CONFIG_FORMAT');
      expect(error.message).toContain('配置文件JSON格式无效');
      expect(error.details).toMatchObject({
        configPath: resolve(tempConfigPath),
        parseError: expect.any(String),
      });
    });

    it('结构校验失败时应抛出带字段路径与错误列表的 INVALID_CONFIG_FORMAT', async () => {
      // 两个非法字段：command 为空 + timeout 为负数，错误消息应以 "; " 连接
      const invalidConfig = {
        servers: {
          bad_a: { command: '' },
          bad_b: { command: 'node', timeout: -1 },
        },
      };
      await writeFile(tempConfigPath, JSON.stringify(invalidConfig));

      const error = await configManager.loadConfig(tempConfigPath).catch((e: CliError) => e);

      expect(error.code).toBe('INVALID_CONFIG_FORMAT');
      expect(error.message).toContain('配置文件格式无效: ');
      expect(error.message).toContain('servers.bad_a.command');
      expect(error.message).toContain('servers.bad_b.timeout');
      expect(error.message).toContain('; ');
      expect(error.details).toMatchObject({
        configPath: resolve(tempConfigPath),
        validationErrors: expect.anything(),
        errorMessages: expect.stringContaining('; '),
      });
    });
  });

  describe('日志输出', () => {
    function spyOnLogger() {
      return {
        debug: vi.spyOn(UnifiedLogger.prototype, 'debug').mockImplementation(() => {}),
        error: vi.spyOn(UnifiedLogger.prototype, 'error').mockImplementation(() => {}),
      };
    }

    it('加载配置应记录加载、成功日志及上下文', async () => {
      const spies = spyOnLogger();
      await writeFile(
        tempConfigPath,
        JSON.stringify({ servers: { test_server: { command: 'node' } } }),
      );

      await configManager.loadConfig(tempConfigPath);

      expect(spies.debug).toHaveBeenCalledWith('加载配置文件', {
        context: { configPath: tempConfigPath },
      });
      expect(spies.debug).toHaveBeenCalledWith('配置文件加载成功', {
        context: {
          configPath: resolve(tempConfigPath),
          serverCount: 1,
          loggingLevel: 'info',
        },
      });
    });

    it('命中缓存时应记录缓存日志', async () => {
      const spies = spyOnLogger();
      await writeFile(
        tempConfigPath,
        JSON.stringify({ servers: { test_server: { command: 'node' } } }),
      );

      await configManager.loadConfig(tempConfigPath);
      spies.debug.mockClear();
      await configManager.loadConfig(tempConfigPath);

      expect(spies.debug).toHaveBeenCalledWith('使用缓存的配置');
      expect(spies.debug).not.toHaveBeenCalledWith('配置文件加载成功', expect.anything());
    });

    it('加载失败时应记录错误日志', async () => {
      const spies = spyOnLogger();

      await configManager.loadConfig(join(tempDir, 'missing.json')).catch(() => {});

      expect(spies.error).toHaveBeenCalledWith('加载配置文件失败:', expect.any(Error), {
        context: { configPath: join(tempDir, 'missing.json') },
      });
    });

    it('clearCache 应记录清缓存日志', () => {
      const spies = spyOnLogger();

      configManager.clearCache();

      expect(spies.debug).toHaveBeenCalledWith('配置缓存已清除');
    });

    it('validateConfig 校验失败时应记录错误日志', () => {
      const spies = spyOnLogger();

      configManager.validateConfig({ servers: { s: { command: '' } } } as CliConfig);

      expect(spies.error).toHaveBeenCalledWith('配置验证失败:', expect.any(Error));
    });

    it('validateServerConfig 校验失败时应记录错误日志', () => {
      const spies = spyOnLogger();

      configManager.validateServerConfig({ command: '' });

      expect(spies.error).toHaveBeenCalledWith('服务器配置验证失败:', expect.any(Error));
    });
  });

  describe('模板与验证委托', () => {
    it('getConfigTemplate 默认返回 basic 模板', () => {
      const template = configManager.getConfigTemplate();

      expect(template).toContain('example_server');
      expect(template).not.toContain('file_server');
    });

    it('getConfigTemplateWithComments 默认返回 basic 注释模板', () => {
      const template = configManager.getConfigTemplateWithComments();

      expect(template).toContain('// MCP Knot CLI 配置文件');
      expect(template).toContain('// 基础配置模板');
    });

    it('generateConfigTemplate 应按类型生成模板', () => {
      const advanced = configManager.generateConfigTemplate('advanced');

      expect(Object.keys(advanced.servers)).toContain('file_server');
    });

    it('validateConfigDetailed 应委托详细验证', () => {
      const result = configManager.validateConfigDetailed(null);

      expect(result.valid).toBe(false);
      expect(result.errors[0].code).toBe('CONFIG_NULL');
    });

    it('formatValidationResult 应委托格式化输出', () => {
      const formatted = configManager.formatValidationResult({
        valid: true,
        errors: [],
        warnings: [],
      });

      expect(formatted).toBe('✅ 配置验证通过');
    });

    it('getAvailableTemplates 应返回全部模板类型', () => {
      const templates = configManager.getAvailableTemplates();

      expect(templates.map((t) => t.type)).toEqual([
        'basic',
        'advanced',
        'development',
        'production',
      ]);
    });
  });

  describe('getCacheStatus 路径解析', () => {
    it('缓存键应为解析后的绝对路径', async () => {
      await writeFile(
        tempConfigPath,
        JSON.stringify({ servers: { test_server: { command: 'node' } } }),
      );

      await configManager.loadConfig(tempConfigPath);

      const status = configManager.getCacheStatus();
      expect(status.cachedPaths).toEqual([resolve(tempConfigPath)]);
    });
  });
});
