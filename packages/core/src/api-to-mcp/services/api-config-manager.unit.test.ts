/**
 * API配置管理器测试
 */

import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiConfigManagerImpl, ConfigLoadError } from './api-config-manager.js';

import type { ApiToolsConfig } from '../types/api-config.js';

// Mock日志（可引用）
const loggerMocks = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));

vi.mock('../../utils/logger.js', () => ({
  createLogger: () => loggerMocks,
}));

// 保留 node:fs 原实现，仅 watch 可控（默认委托真实实现）
const watchMock = vi.hoisted(() => vi.fn());

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  watchMock.mockImplementation(
    (...args: Parameters<typeof actual.watch>) =>
      actual.watch(...args) as ReturnType<typeof actual.watch>,
  );
  return {
    ...actual,
    watch: (...args: Parameters<typeof actual.watch>) =>
      watchMock(...args) as ReturnType<typeof actual.watch>,
  };
});

// Mock环境变量
const originalEnv = process.env;

describe('ApiConfigManagerImpl', () => {
  let configManager: ApiConfigManagerImpl;
  let tempDir: string;
  let configPath: string;

  beforeEach(async () => {
    configManager = new ApiConfigManagerImpl();

    // 创建临时目录和配置文件
    tempDir = await fs.mkdtemp(join(tmpdir(), 'api-config-test-'));
    configPath = join(tempDir, 'api-tools.json');

    // 重置环境变量
    process.env = { ...originalEnv };
  });

  afterEach(async () => {
    // 停止监听
    configManager.stopWatching();

    // 清理临时文件
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch (_error) {
      // 忽略清理错误
    }

    // 恢复环境变量
    process.env = originalEnv;

    vi.clearAllMocks();
  });

  /** 写入临时配置文件并加载，返回 tools */
  async function writeAndLoad(config: ApiToolsConfig, path = configPath) {
    await fs.writeFile(path, JSON.stringify(config, null, 2));
    return configManager.loadConfig(path);
  }

  function minimalTool(id: string) {
    return {
      id,
      name: `工具${id}`,
      description: '描述',
      api: { url: 'https://api.example.com', method: 'GET' as const },
      parameters: { type: 'object' as const, properties: {} },
      response: {},
    };
  }

  describe('loadConfig', () => {
    it('应该成功加载有效的配置文件', async () => {
      const validConfig: ApiToolsConfig = {
        version: '1.0',
        tools: [
          {
            id: 'test-api',
            name: '测试API',
            description: '用于测试的API工具',
            api: {
              url: 'https://api.example.com/test',
              method: 'GET',
              timeout: 5000,
            },
            parameters: {
              type: 'object',
              properties: {
                query: {
                  type: 'string',
                  description: '查询参数',
                },
              },
              required: ['query'],
            },
            response: {
              jsonata: '$.data',
            },
          },
        ],
      };

      await fs.writeFile(configPath, JSON.stringify(validConfig, null, 2));

      const tools = await configManager.loadConfig(configPath);

      expect(tools).toHaveLength(1);
      expect(tools[0].id).toBe('test-api');
      expect(tools[0].name).toBe('测试API');
    });

    it('应该解析环境变量引用', async () => {
      process.env.TEST_API_KEY = 'secret-key';
      process.env.TEST_URL = 'https://api.example.com';

      const configWithEnv: ApiToolsConfig = {
        version: '1.0',
        tools: [
          {
            id: 'env-test',
            name: '环境变量测试',
            description: '测试环境变量解析',
            api: {
              url: '{{env.TEST_URL}}/data',
              method: 'GET',
              headers: {
                Authorization: 'Bearer {{env.TEST_API_KEY}}',
              },
            },
            parameters: {
              type: 'object',
              properties: {},
            },
            response: {},
          },
        ],
      };

      await fs.writeFile(configPath, JSON.stringify(configWithEnv, null, 2));

      const tools = await configManager.loadConfig(configPath);

      expect(tools[0].api.url).toBe('https://api.example.com/data');
      expect(tools[0].api.headers?.Authorization).toBe('Bearer secret-key');
    });

    it('应该在文件不存在时抛出ConfigLoadError', async () => {
      const nonExistentPath = join(tempDir, 'non-existent.json');

      await expect(configManager.loadConfig(nonExistentPath)).rejects.toThrow(ConfigLoadError);
    });

    it('应该在JSON格式错误时抛出ConfigLoadError', async () => {
      await fs.writeFile(configPath, '{ invalid json }');

      await expect(configManager.loadConfig(configPath)).rejects.toThrow(ConfigLoadError);
    });

    it('应该在配置格式验证失败时抛出ConfigLoadError', async () => {
      const invalidConfig = {
        version: '1.0',
        tools: [
          {
            // 缺少必需字段
            id: 'invalid',
          },
        ],
      };

      await fs.writeFile(configPath, JSON.stringify(invalidConfig));

      await expect(configManager.loadConfig(configPath)).rejects.toThrow(ConfigLoadError);
    });
  });

  describe('validateConfig', () => {
    it('应该验证有效配置', () => {
      const validConfig: ApiToolsConfig = {
        version: '1.0',
        tools: [
          {
            id: 'test-tool',
            name: '测试工具',
            description: '测试描述',
            api: {
              url: 'https://api.example.com',
              method: 'GET',
            },
            parameters: {
              type: 'object',
              properties: {},
            },
            response: {},
          },
        ],
      };

      const result = configManager.validateConfig(validConfig);

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('应该检测重复的工具ID', () => {
      const configWithDuplicates: ApiToolsConfig = {
        version: '1.0',
        tools: [
          {
            id: 'duplicate-id',
            name: '工具1',
            description: '描述1',
            api: { url: 'https://api1.com', method: 'GET' },
            parameters: { type: 'object', properties: {} },
            response: {},
          },
          {
            id: 'duplicate-id',
            name: '工具2',
            description: '描述2',
            api: { url: 'https://api2.com', method: 'GET' },
            parameters: { type: 'object', properties: {} },
            response: {},
          },
        ],
      };

      const result = configManager.validateConfig(configWithDuplicates);

      expect(result.valid).toBe(false);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].code).toBe('DUPLICATE_TOOL_ID');
    });

    it('应该返回Zod验证错误', () => {
      const invalidConfig = {
        version: '1.0',
        tools: [
          {
            id: '', // 空ID无效
            name: '测试',
            description: '描述',
            api: {
              url: 'invalid-url', // 无效URL
              method: 'INVALID_METHOD', // 无效HTTP方法
            },
            parameters: {
              type: 'object',
              properties: {},
            },
            response: {},
          },
        ],
      } as ApiToolsConfig;

      const result = configManager.validateConfig(invalidConfig);

      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });
  });

  describe('watchConfigFile', () => {
    it('应该监听配置文件变化', async () => {
      const initialConfig: ApiToolsConfig = {
        version: '1.0',
        tools: [
          {
            id: 'initial-tool',
            name: '初始工具',
            description: '初始描述',
            api: { url: 'https://api.example.com', method: 'GET' },
            parameters: { type: 'object', properties: {} },
            response: {},
          },
        ],
      };

      await fs.writeFile(configPath, JSON.stringify(initialConfig, null, 2));
      await configManager.loadConfig(configPath);

      const mockCallback = vi.fn();
      configManager.watchConfigFile(mockCallback);

      // 修改配置文件
      const updatedConfig: ApiToolsConfig = {
        ...initialConfig,
        tools: [
          {
            ...initialConfig.tools[0],
            name: '更新后的工具',
          },
        ],
      };

      await fs.writeFile(configPath, JSON.stringify(updatedConfig, null, 2));

      // 等待文件系统事件
      await new Promise((resolve) => setTimeout(resolve, 200));

      expect(mockCallback).toHaveBeenCalled();
    });

    it('应该在未加载配置时抛出错误', () => {
      const mockCallback = vi.fn();

      expect(() => configManager.watchConfigFile(mockCallback)).toThrow(
        '必须先调用 loadConfig() 才能监听配置文件变化',
      );
    });
  });

  describe('resolveEnvironmentVariables', () => {
    it('应该解析环境变量引用', () => {
      process.env.TEST_TOKEN = 'test-token';
      process.env.TEST_HOST = 'api.test.com';

      const config = {
        id: 'test',
        name: '测试',
        description: '测试工具',
        api: {
          url: 'https://{{env.TEST_HOST}}/api',
          method: 'GET' as const,
          headers: {
            Authorization: 'Bearer {{env.TEST_TOKEN}}',
          },
        },
        parameters: {
          type: 'object' as const,
          properties: {},
        },
        response: {},
      };

      const resolved = configManager.resolveEnvironmentVariables(config);

      expect(resolved.api.url).toBe('https://api.test.com/api');
      expect(resolved.api.headers?.Authorization).toBe('Bearer test-token');
    });

    it('应该保持未定义环境变量的原始值', () => {
      const config = {
        id: 'test',
        name: '测试',
        description: '测试工具',
        api: {
          url: 'https://{{env.UNDEFINED_VAR}}/api',
          method: 'GET' as const,
        },
        parameters: {
          type: 'object' as const,
          properties: {},
        },
        response: {},
      };

      const resolved = configManager.resolveEnvironmentVariables(config);

      expect(resolved.api.url).toBe('https://{{env.UNDEFINED_VAR}}/api');
    });
  });

  describe('getCurrentConfigPath', () => {
    it('应该返回当前配置文件路径', async () => {
      expect(configManager.getCurrentConfigPath()).toBeUndefined();

      const config: ApiToolsConfig = {
        version: '1.0',
        tools: [],
      };

      await fs.writeFile(configPath, JSON.stringify(config));
      await configManager.loadConfig(configPath);

      expect(configManager.getCurrentConfigPath()).toBe(configPath);
    });
  });

  describe('reloadConfig', () => {
    it('应该重新加载当前配置', async () => {
      const config: ApiToolsConfig = {
        version: '1.0',
        tools: [
          {
            id: 'test-tool',
            name: '测试工具',
            description: '测试描述',
            api: { url: 'https://api.example.com', method: 'GET' },
            parameters: { type: 'object', properties: {} },
            response: {},
          },
        ],
      };

      await fs.writeFile(configPath, JSON.stringify(config));
      await configManager.loadConfig(configPath);

      const reloaded = await configManager.reloadConfig();

      expect(reloaded).toHaveLength(1);
      expect(reloaded[0].id).toBe('test-tool');
    });

    it('应该在没有当前配置路径时抛出错误', async () => {
      await expect(configManager.reloadConfig()).rejects.toThrow(
        '没有当前配置文件路径，请先调用 loadConfig()',
      );
    });
  });

  describe('stopWatching', () => {
    it('应该停止文件监听', async () => {
      const config: ApiToolsConfig = {
        version: '1.0',
        tools: [],
      };

      await fs.writeFile(configPath, JSON.stringify(config));
      await configManager.loadConfig(configPath);

      const mockCallback = vi.fn();
      configManager.watchConfigFile(mockCallback);

      // 停止监听
      configManager.stopWatching();

      // 修改文件
      await fs.writeFile(configPath, JSON.stringify({ ...config, version: '2.0' }));

      // 等待可能的文件系统事件
      await new Promise((resolve) => setTimeout(resolve, 100));

      // 回调不应该被调用
      expect(mockCallback).not.toHaveBeenCalled();
    });
  });

  describe('loadConfig 错误分支明细', () => {
    it('文件不存在 → message 指明路径，path/cause 齐全，name 为 ConfigLoadError', async () => {
      const missing = join(tempDir, 'missing.json');

      const err = await configManager.loadConfig(missing).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(ConfigLoadError);
      const loadError = err as ConfigLoadError;
      expect(loadError.name).toBe('ConfigLoadError');
      expect(loadError.message).toBe(`配置文件不存在: ${missing}`);
      expect(loadError.path).toBe(missing);
      expect(loadError.cause).toBeInstanceOf(Error);
    });

    it('JSON 解析失败 → message 以"配置文件JSON格式错误"开头（不二次包装）', async () => {
      await fs.writeFile(configPath, '{ invalid json }');

      const err = await configManager.loadConfig(configPath).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(ConfigLoadError);
      expect((err as Error).message).toMatch(/^配置文件JSON格式错误/);
    });

    it('配置格式验证失败 → message 包含具体校验错误明细', async () => {
      await fs.writeFile(
        configPath,
        JSON.stringify({ version: '1.0', tools: [{ id: 'invalid' }] }),
      );

      const err = await configManager.loadConfig(configPath).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(ConfigLoadError);
      const message = (err as Error).message;
      expect(message).toMatch(/^配置文件格式验证失败/);
      // 错误明细中包含 zod 校验的路径信息
      expect(message).toMatch(/tools/);
    });

    it('fs.access 抛 EACCES → message 提示无权限', async () => {
      const accessSpy = vi
        .spyOn(fs, 'access')
        .mockRejectedValueOnce(Object.assign(new Error('permission denied'), { code: 'EACCES' }));

      const err = await configManager.loadConfig(configPath).catch((e: unknown) => e);

      accessSpy.mockRestore();
      expect(err).toBeInstanceOf(ConfigLoadError);
      expect((err as Error).message).toBe(`无权限访问配置文件: ${configPath}`);
      expect((err as ConfigLoadError).cause).toBeInstanceOf(Error);
    });

    it('fs.readFile 抛其他错误（EISDIR）→ 走通用失败分支并保留 cause', async () => {
      await fs.writeFile(configPath, '{}'); // 先保证 access 通过
      const readSpy = vi
        .spyOn(fs, 'readFile')
        .mockRejectedValueOnce(Object.assign(new Error('is a directory'), { code: 'EISDIR' }));

      const err = await configManager.loadConfig(configPath).catch((e: unknown) => e);

      readSpy.mockRestore();
      expect(err).toBeInstanceOf(ConfigLoadError);
      const loadError = err as ConfigLoadError;
      expect(loadError.message).toBe(`加载配置文件失败: is a directory`);
      expect(loadError.path).toBe(configPath);
      expect(loadError.cause).toBeInstanceOf(Error);
    });

    it('抛出非 Error 对象（裸 code）→ 兜底为"未知错误"消息', async () => {
      const accessSpy = vi
        .spyOn(fs, 'access')
        .mockRejectedValueOnce({ code: 'ENOENT', message: 'nope' } as unknown as Error);

      const err = await configManager.loadConfig(configPath).catch((e: unknown) => e);

      accessSpy.mockRestore();
      expect(err).toBeInstanceOf(ConfigLoadError);
      expect((err as Error).message).toBe('加载配置文件失败: 未知错误');
    });
  });

  describe('validateConfig 错误转换', () => {
    it('zod 失败 → 转换为 path/message/code 结构（非 VALIDATION_EXCEPTION）', () => {
      const invalidConfig = {
        version: '1.0',
        tools: [
          {
            id: 'x',
            name: '测试',
            description: '描述',
            api: { url: 'invalid-url', method: 'GET' },
            parameters: { type: 'object', properties: {} },
            response: {},
          },
        ],
      } as unknown as ApiToolsConfig;

      const result = configManager.validateConfig(invalidConfig);

      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
      for (const error of result.errors) {
        expect(error.code).not.toBe('VALIDATION_EXCEPTION');
      }
      const urlError = result.errors.find((e) => e.path.includes('url'));
      expect(urlError).toBeDefined();
      expect(urlError?.message).toBeTruthy();
    });

    it('重复工具ID → 错误 message/path 精确指明重复项', () => {
      const config: ApiToolsConfig = {
        version: '1.0',
        tools: [minimalTool('dup'), minimalTool('dup')],
      };

      const result = configManager.validateConfig(config);

      expect(result.errors[0]).toEqual({
        path: 'tools[id="dup"]',
        message: '工具ID重复: dup',
        code: 'DUPLICATE_TOOL_ID',
      });
    });
  });

  describe('watchConfigFile 内部行为（mock watch）', () => {
    function createFakeWatcher() {
      return { close: vi.fn() } as unknown as import('node:fs').FSWatcher;
    }

    async function setupWatched() {
      await writeAndLoad({ version: '1.0', tools: [minimalTool('t1')] });
    }

    it('以 resolved 路径与 persistent:false 选项启动监听', async () => {
      await setupWatched();
      const fakeWatcher = createFakeWatcher();
      watchMock.mockImplementationOnce(() => fakeWatcher);

      configManager.watchConfigFile(vi.fn());

      expect(watchMock).toHaveBeenCalledWith(
        configPath,
        { persistent: false },
        expect.any(Function),
      );
    });

    it('重复监听会先关闭上一个 watcher', async () => {
      await setupWatched();
      const watcher1 = createFakeWatcher();
      const watcher2 = createFakeWatcher();
      watchMock.mockImplementationOnce(() => watcher1);
      configManager.watchConfigFile(vi.fn());
      watchMock.mockImplementationOnce(() => watcher2);
      configManager.watchConfigFile(vi.fn());

      expect(watcher1.close).toHaveBeenCalled();
      expect(watcher2.close).not.toHaveBeenCalled();
    });

    it('change 事件 → 延迟后重新加载并回调新配置', async () => {
      await setupWatched();
      const fakeWatcher = createFakeWatcher();
      watchMock.mockImplementationOnce(() => fakeWatcher);
      const callback = vi.fn();
      configManager.watchConfigFile(callback);

      // 修改文件后触发 change
      await fs.writeFile(
        configPath,
        JSON.stringify({ version: '1.0', tools: [minimalTool('t2')] }),
      );
      const listener = watchMock.mock.calls[0][2] as (event: string) => void;
      listener('change');

      await new Promise((resolve) => setTimeout(resolve, 200));

      expect(callback).toHaveBeenCalledTimes(1);
      expect(callback.mock.calls[0][0]).toHaveLength(1);
      expect(callback.mock.calls[0][0][0].id).toBe('t2');
      expect(loggerMocks.info).toHaveBeenCalledWith('配置文件重新加载成功');
    });

    it('rename 事件不触发重新加载', async () => {
      await setupWatched();
      const fakeWatcher = createFakeWatcher();
      watchMock.mockImplementationOnce(() => fakeWatcher);
      const callback = vi.fn();
      configManager.watchConfigFile(callback);
      const loadSpy = vi.spyOn(configManager, 'loadConfig');

      const listener = watchMock.mock.calls[0][2] as (event: string) => void;
      listener('rename');

      await new Promise((resolve) => setTimeout(resolve, 150));

      expect(callback).not.toHaveBeenCalled();
      expect(loadSpy).not.toHaveBeenCalled();
    });

    it('stopWatching 后的 change 事件 → 直接返回，不重新加载', async () => {
      await setupWatched();
      const fakeWatcher = createFakeWatcher();
      watchMock.mockImplementationOnce(() => fakeWatcher);
      const callback = vi.fn();
      configManager.watchConfigFile(callback);
      const listener = watchMock.mock.calls[0][2] as (event: string) => void;

      configManager.stopWatching();
      listener('change');

      await new Promise((resolve) => setTimeout(resolve, 150));

      expect(callback).not.toHaveBeenCalled();
      expect(fakeWatcher.close).toHaveBeenCalled();
    });

    it('重新加载失败（文件变非法 JSON）→ 记录错误但不抛出、不回调', async () => {
      await setupWatched();
      const fakeWatcher = createFakeWatcher();
      watchMock.mockImplementationOnce(() => fakeWatcher);
      const callback = vi.fn();
      configManager.watchConfigFile(callback);

      await fs.writeFile(configPath, '{ broken');
      const listener = watchMock.mock.calls[0][2] as (event: string) => void;
      listener('change');

      await new Promise((resolve) => setTimeout(resolve, 200));

      expect(callback).not.toHaveBeenCalled();
      expect(loggerMocks.error).toHaveBeenCalledWith('重新加载配置文件失败:', expect.any(Error));
    });

    it('watch 启动抛错 → 抛 ServiceError 且 context 保留原因', async () => {
      await setupWatched();
      watchMock.mockImplementationOnce(() => {
        throw new Error('fs watch broken');
      });

      expect(() => configManager.watchConfigFile(vi.fn())).toThrow('启动配置文件监听失败');
    });
  });

  describe('resolveEnvironmentVariables 边界', () => {
    it('缺少环境变量 → 记录 warn 日志（含工具ID与缺失变量）', () => {
      const config = minimalTool('env-missing');
      config.api = {
        ...config.api,
        headers: { Authorization: 'Bearer {{env.MISSING_VAR_XYZ}}' },
      };

      configManager.resolveEnvironmentVariables(config);

      expect(loggerMocks.warn).toHaveBeenCalledWith(
        '工具 env-missing 缺少环境变量: MISSING_VAR_XYZ',
        { context: { toolId: 'env-missing', missingVars: ['MISSING_VAR_XYZ'] } },
      );
    });

    it('不修改原始配置对象（深度克隆）', () => {
      process.env.CLONE_TEST_VAR = 'resolved-value';
      const config = minimalTool('clone-test');
      config.api = { ...config.api, url: 'https://{{env.CLONE_TEST_VAR}}/x' };

      const resolved = configManager.resolveEnvironmentVariables(config);

      expect(resolved.api.url).toBe('https://resolved-value/x');
      expect(config.api.url).toBe('https://{{env.CLONE_TEST_VAR}}/x');
    });

    it('序列化失败（循环引用）→ 记录错误并返回原配置对象', () => {
      const config = minimalTool('circular') as ApiToolConfig & { extra?: unknown };
      config.extra = config; // 循环引用

      const result = configManager.resolveEnvironmentVariables(config);

      expect(result).toBe(config);
      expect(loggerMocks.error).toHaveBeenCalledWith(
        '解析工具 circular 的环境变量失败',
        expect.any(Error),
        { context: { toolId: 'circular' } },
      );
    });
  });
});
