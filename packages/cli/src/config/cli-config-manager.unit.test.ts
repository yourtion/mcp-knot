/**
 * CLI配置管理器单元测试
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CliConfigManager } from './cli-config-manager';

import type { CliConfig } from '../types/index';

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
});
