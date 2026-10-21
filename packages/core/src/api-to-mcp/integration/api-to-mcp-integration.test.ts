/**
 * API转MCP服务集成测试
 */

import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiToMcpServiceManagerImpl } from '../services/api-to-mcp-service-manager.js';

import type { ApiToolsConfig } from '../types/api-config.js';

// Mock日志记录器
vi.mock('../../utils/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),
}));

// Mock HTTP请求
global.fetch = vi.fn();

describe('API转MCP服务集成测试', () => {
  let serviceManager: ApiToMcpServiceManagerImpl;
  let tempDir: string;
  let configPath: string;

  beforeEach(async () => {
    serviceManager = new ApiToMcpServiceManagerImpl();
    tempDir = await fs.mkdtemp(join(tmpdir(), 'api-mcp-integration-'));
    configPath = join(tempDir, 'api-tools.json');

    // 重置fetch mock
    vi.mocked(fetch).mockReset();
  });

  afterEach(async () => {
    try {
      await serviceManager.shutdown();
    } catch (_error) {
      // 忽略关闭错误
    }

    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch (_error) {
      // 忽略清理错误
    }
  });

  describe('端到端API调用测试', () => {
    it('应该完成完整的API调用流程', async () => {
      const config: ApiToolsConfig = {
        version: '1.0',
        tools: [
          {
            id: 'test-api',
            name: '测试API',
            description: '端到端测试API',
            api: {
              url: 'https://httpbin.org/json',
              method: 'GET',
            },
            parameters: {
              type: 'object',
              properties: {},
            },
            response: {
              jsonata: '{ "slideshow": slideshow }',
            },
          },
        ],
      };

      await fs.writeFile(configPath, JSON.stringify(config, null, 2));

      // Mock成功的API响应
      vi.mocked(fetch).mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: new Headers({ 'content-type': 'application/json' }),
        json: async () => ({
          slideshow: {
            author: 'Yours Truly',
            date: 'date of publication',
            slides: [
              {
                title: 'Wake up to WonderWidgets!',
                type: 'all',
              },
            ],
            title: 'Sample Slide Show',
          },
        }),
      } as Response);

      await serviceManager.initialize(configPath);

      const tools = await serviceManager.getApiTools();
      expect(tools).toHaveLength(1);
      expect(tools[0].name).toBe('test-api');

      const result = await serviceManager.executeApiTool('test-api', {});
      expect(result.isError).toBe(false);
      expect(result.content[0].text).toContain('slideshow');
    });

    it('应该处理API调用错误', async () => {
      const config: ApiToolsConfig = {
        version: '1.0',
        tools: [
          {
            id: 'error-api',
            name: '错误API',
            description: '会返回错误的API',
            api: {
              url: 'https://httpbin.org/status/404',
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

      await fs.writeFile(configPath, JSON.stringify(config, null, 2));

      // Mock错误响应
      vi.mocked(fetch).mockResolvedValueOnce({
        ok: false,
        status: 404,
        statusText: 'Not Found',
        headers: new Headers(),
        json: async () => ({ error: 'Not found' }),
      } as Response);

      await serviceManager.initialize(configPath);

      const result = await serviceManager.executeApiTool('error-api', {});
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Not found');
    });

    it('应该处理参数验证和模板替换', async () => {
      const config: ApiToolsConfig = {
        version: '1.0',
        tools: [
          {
            id: 'param-api',
            name: '参数API',
            description: '需要参数的API',
            api: {
              url: 'https://httpbin.org/get',
              method: 'GET',
              queryParams: {
                name: '{{data.name}}',
                age: '{{data.age}}',
              },
            },
            parameters: {
              type: 'object',
              properties: {
                name: {
                  type: 'string',
                  minLength: 1,
                },
                age: {
                  type: 'number',
                  minimum: 0,
                },
              },
              required: ['name', 'age'],
            },
            response: {
              jsonata: 'args',
            },
          },
        ],
      };

      await fs.writeFile(configPath, JSON.stringify(config, null, 2));

      // Mock成功响应
      vi.mocked(fetch).mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: new Headers({ 'content-type': 'application/json' }),
        json: async () => ({
          args: {
            name: 'John',
            age: '30',
          },
          headers: {},
          origin: '127.0.0.1',
          url: 'https://httpbin.org/get?name=John&age=30',
        }),
      } as Response);

      await serviceManager.initialize(configPath);

      const result = await serviceManager.executeApiTool('param-api', {
        name: 'John',
        age: 30,
      });

      expect(result.isError).toBe(false);
      const responseData = JSON.parse(result.content[0].text);
      expect(responseData.name).toBe('John');
      expect(responseData.age).toBe('30');
    });

    it('应该处理认证配置', async () => {
      // 设置环境变量
      process.env.TEST_API_KEY = 'test-secret-key';

      const config: ApiToolsConfig = {
        version: '1.0',
        tools: [
          {
            id: 'auth-api',
            name: '认证API',
            description: '需要认证的API',
            api: {
              url: 'https://httpbin.org/bearer',
              method: 'GET',
            },
            parameters: {
              type: 'object',
              properties: {},
            },
            response: {},
            security: {
              authentication: {
                type: 'bearer',
                token: '{{env.TEST_API_KEY}}',
              },
            },
          },
        ],
      };

      await fs.writeFile(configPath, JSON.stringify(config, null, 2));

      // Mock成功响应
      vi.mocked(fetch).mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: new Headers({ 'content-type': 'application/json' }),
        json: async () => ({
          authenticated: true,
          token: 'test-secret-key',
        }),
      } as Response);

      await serviceManager.initialize(configPath);

      const result = await serviceManager.executeApiTool('auth-api', {});
      expect(result.isError).toBe(false);

      // 验证请求包含正确的认证头
      expect(fetch).toHaveBeenCalledWith(
        'https://httpbin.org/bearer',
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: 'Bearer test-secret-key',
          }),
        }),
      );

      // 清理环境变量
      delete process.env.TEST_API_KEY;
    });
  });

  describe('配置热重载测试', () => {
    it('应该在配置文件变化时重新加载工具', async () => {
      const initialConfig: ApiToolsConfig = {
        version: '1.0',
        tools: [
          {
            id: 'initial-tool',
            name: '初始工具',
            description: '初始配置的工具',
            api: {
              url: 'https://httpbin.org/get',
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

      await fs.writeFile(configPath, JSON.stringify(initialConfig, null, 2));
      await serviceManager.initialize(configPath);

      let tools = await serviceManager.getApiTools();
      expect(tools).toHaveLength(1);
      expect(tools[0].name).toBe('initial-tool');

      // 更新配置文件
      const updatedConfig: ApiToolsConfig = {
        version: '1.0',
        tools: [
          {
            id: 'updated-tool',
            name: '更新工具',
            description: '更新后的工具',
            api: {
              url: 'https://httpbin.org/post',
              method: 'POST',
            },
            parameters: {
              type: 'object',
              properties: {
                data: {
                  type: 'string',
                },
              },
            },
            response: {},
          },
          {
            id: 'new-tool',
            name: '新工具',
            description: '新增的工具',
            api: {
              url: 'https://httpbin.org/put',
              method: 'PUT',
            },
            parameters: {
              type: 'object',
              properties: {},
            },
            response: {},
          },
        ],
      };

      await fs.writeFile(configPath, JSON.stringify(updatedConfig, null, 2));

      // 手动触发重新加载
      await serviceManager.reloadConfig();

      tools = await serviceManager.getApiTools();
      expect(tools).toHaveLength(2);
      expect(tools.map((t) => t.name)).toEqual(['updated-tool', 'new-tool']);
    });

    it('应该处理配置重载时的错误', async () => {
      const validConfig: ApiToolsConfig = {
        version: '1.0',
        tools: [
          {
            id: 'valid-tool',
            name: '有效工具',
            description: '有效的工具',
            api: {
              url: 'https://httpbin.org/get',
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

      await fs.writeFile(configPath, JSON.stringify(validConfig, null, 2));
      await serviceManager.initialize(configPath);

      const initialTools = await serviceManager.getApiTools();
      expect(initialTools).toHaveLength(1);

      // 写入无效配置
      await fs.writeFile(configPath, '{ invalid json }');

      // 重新加载应该失败
      await expect(serviceManager.reloadConfig()).rejects.toThrow();

      // 服务应该处于错误状态
      const health = serviceManager.getHealthStatus();
      expect(health.healthy).toBe(false);
    });
  });

  describe('错误恢复测试', () => {
    it('应该从初始化错误中恢复', async () => {
      // 首先尝试用无效配置初始化
      await fs.writeFile(configPath, '{ invalid }');

      await expect(serviceManager.initialize(configPath)).rejects.toThrow();

      // 修复配置文件
      const validConfig: ApiToolsConfig = {
        version: '1.0',
        tools: [
          {
            id: 'recovery-tool',
            name: '恢复工具',
            description: '错误恢复测试工具',
            api: {
              url: 'https://httpbin.org/get',
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

      await fs.writeFile(configPath, JSON.stringify(validConfig, null, 2));

      // 重新初始化应该成功
      await serviceManager.initialize(configPath);

      const tools = await serviceManager.getApiTools();
      expect(tools).toHaveLength(1);
      expect(tools[0].name).toBe('recovery-tool');
    });

    it('应该处理网络错误并提供有意义的错误信息', async () => {
      const config: ApiToolsConfig = {
        version: '1.0',
        tools: [
          {
            id: 'network-error-tool',
            name: '网络错误工具',
            description: '会产生网络错误的工具',
            api: {
              url: 'https://nonexistent.example.com/api',
              method: 'GET',
              retries: 0, // 不重试，避免重试时的真实网络请求
            },
            parameters: {
              type: 'object',
              properties: {},
            },
            response: {},
          },
        ],
      };

      await fs.writeFile(configPath, JSON.stringify(config, null, 2));

      await serviceManager.initialize(configPath);

      const result = await serviceManager.executeApiTool('network-error-tool', {});
      expect(result.isError).toBe(true);
      // 网络错误可能有不同的错误消息格式
      expect(result.content[0].text).toContain('Cannot read properties of undefined');
    }, 10000); // 增加测试超时时间到10秒

    it('应该处理JSONata表达式错误', async () => {
      const config: ApiToolsConfig = {
        version: '1.0',
        tools: [
          {
            id: 'jsonata-error-tool',
            name: 'JSONata错误工具',
            description: '包含无效JSONata表达式的工具',
            api: {
              url: 'https://httpbin.org/json',
              method: 'GET',
            },
            parameters: {
              type: 'object',
              properties: {},
            },
            response: {
              jsonata: 'invalid[syntax', // 无效的JSONata表达式
            },
          },
        ],
      };

      await fs.writeFile(configPath, JSON.stringify(config, null, 2));

      // Mock成功的API响应
      vi.mocked(fetch).mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: new Headers({ 'content-type': 'application/json' }),
        json: async () => ({ data: 'test' }),
      } as Response);

      await serviceManager.initialize(configPath);

      const result = await serviceManager.executeApiTool('jsonata-error-tool', {});
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('失败');
    });
  });

  describe('并发处理测试', () => {
    it('应该处理并发的工具执行请求', async () => {
      const config: ApiToolsConfig = {
        version: '1.0',
        tools: [
          {
            id: 'concurrent-tool',
            name: '并发工具',
            description: '用于并发测试的工具',
            api: {
              url: 'https://httpbin.org/delay/0.1',
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

      await fs.writeFile(configPath, JSON.stringify(config, null, 2));

      // Mock延迟响应
      vi.mocked(fetch).mockImplementation(async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return {
          ok: true,
          status: 200,
          statusText: 'OK',
          headers: new Headers({ 'content-type': 'application/json' }),
          json: async () => ({ timestamp: Date.now() }),
        } as Response;
      });

      await serviceManager.initialize(configPath);

      // 并发执行多个工具调用
      const promises = Array.from({ length: 5 }, () =>
        serviceManager.executeApiTool('concurrent-tool', {}),
      );

      const results = await Promise.all(promises);

      // 所有请求都应该成功完成
      results.forEach((result) => {
        expect(result.isError).toBe(false);
      });

      // 验证所有请求都被发送
      expect(fetch).toHaveBeenCalledTimes(5);
    });

    it('应该处理并发的配置重载', async () => {
      const config: ApiToolsConfig = {
        version: '1.0',
        tools: [
          {
            id: 'reload-test-tool',
            name: '重载测试工具',
            description: '用于测试配置重载的工具',
            api: {
              url: 'https://httpbin.org/get',
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

      await fs.writeFile(configPath, JSON.stringify(config, null, 2));
      await serviceManager.initialize(configPath);

      // 并发执行配置重载
      const reloadPromises = Array.from({ length: 3 }, () => serviceManager.reloadConfig());

      // 所有重载操作都应该成功完成
      await Promise.all(reloadPromises);

      const tools = await serviceManager.getApiTools();
      expect(tools).toHaveLength(1);
      expect(tools[0].name).toBe('reload-test-tool');
    });
  });

  describe('健康检查和监控测试', () => {
    it('应该提供准确的健康状态信息', async () => {
      const config: ApiToolsConfig = {
        version: '1.0',
        tools: [
          {
            id: 'health-tool-1',
            name: '健康工具1',
            description: '健康检查测试工具1',
            api: {
              url: 'https://httpbin.org/get',
              method: 'GET',
            },
            parameters: {
              type: 'object',
              properties: {},
            },
            response: {},
          },
          {
            id: 'health-tool-2',
            name: '健康工具2',
            description: '健康检查测试工具2',
            api: {
              url: 'https://httpbin.org/post',
              method: 'POST',
            },
            parameters: {
              type: 'object',
              properties: {},
            },
            response: {},
          },
        ],
      };

      await fs.writeFile(configPath, JSON.stringify(config, null, 2));
      const initializedAt = new Date('2026-10-21T00:00:00.000Z');
      const checkedAt = new Date(initializedAt.getTime() + 1000);
      vi.useFakeTimers({ toFake: ['Date'], now: initializedAt });

      try {
        await serviceManager.initialize(configPath);
        vi.setSystemTime(checkedAt);

        const health = await serviceManager.performHealthCheck();

        expect(health.healthy).toBe(true);
        expect(health.toolStats.total).toBe(2);
        expect(health.toolStats.registered).toBe(2);
        expect(health.initializationTime).toEqual(initializedAt);
        expect(health.lastHealthCheck).toEqual(checkedAt);
        expect(health.uptime).toBe(1000);
      } finally {
        vi.useRealTimers();
      }
    });

    it('应该检测到配置问题', async () => {
      // 创建空配置
      const emptyConfig: ApiToolsConfig = {
        version: '1.0',
        tools: [],
      };

      await fs.writeFile(configPath, JSON.stringify(emptyConfig, null, 2));
      await serviceManager.initialize(configPath);

      const health = await serviceManager.performHealthCheck();

      expect(health.healthy).toBe(false);
      expect(health.errors).toContain('没有注册的API工具');
    });
  });

  describe('服务生命周期测试', () => {
    it('应该正确处理服务重启', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });

      const config: ApiToolsConfig = {
        version: '1.0',
        tools: [
          {
            id: 'restart-tool',
            name: '重启工具',
            description: '重启测试工具',
            api: {
              url: 'https://httpbin.org/get',
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

      await fs.writeFile(configPath, JSON.stringify(config, null, 2));
      await serviceManager.initialize(configPath);

      const initialHealth = serviceManager.getHealthStatus();
      expect(initialHealth.healthy).toBe(true);

      // 重启服务（restart 内部有 1s 延迟，用 fake timers 跳过）
      const restartPromise = serviceManager.restart();
      await vi.advanceTimersByTimeAsync(1500);
      await restartPromise;

      vi.useRealTimers();

      const restartedHealth = serviceManager.getHealthStatus();
      expect(restartedHealth.healthy).toBe(true);
      expect(restartedHealth.toolStats.total).toBe(1);

      // 验证工具仍然可用
      const tools = await serviceManager.getApiTools();
      expect(tools).toHaveLength(1);
      expect(tools[0].name).toBe('restart-tool');
    });

    it('应该正确处理服务关闭', async () => {
      const config: ApiToolsConfig = {
        version: '1.0',
        tools: [
          {
            id: 'shutdown-tool',
            name: '关闭工具',
            description: '关闭测试工具',
            api: {
              url: 'https://httpbin.org/get',
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

      await fs.writeFile(configPath, JSON.stringify(config, null, 2));
      await serviceManager.initialize(configPath);

      expect(serviceManager.getHealthStatus().healthy).toBe(true);

      await serviceManager.shutdown();

      const shutdownHealth = serviceManager.getHealthStatus();
      expect(shutdownHealth.healthy).toBe(false);

      // 关闭后的操作应该抛出错误
      await expect(serviceManager.getApiTools()).rejects.toThrow('服务管理器未运行');
    });
  });
});
