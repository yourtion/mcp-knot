/**
 * API转MCP服务管理器测试
 */

import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { logger } from '../../utils/logger.js';
import { ApiToMcpServiceManagerImpl, ServiceStatus } from './api-to-mcp-service-manager.js';

import type { ApiToolsConfig } from '../types/api-config.js';

// Mock fetch
const mockFetch = vi.fn();
global.fetch = mockFetch;

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

describe('ApiToMcpServiceManagerImpl', () => {
  let serviceManager: ApiToMcpServiceManagerImpl;
  let tempDir: string;
  let configPath: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockFetch.mockReset();
    serviceManager = new ApiToMcpServiceManagerImpl();

    // 创建临时目录和配置文件
    tempDir = await fs.mkdtemp(join(tmpdir(), 'service-manager-test-'));
    configPath = join(tempDir, 'api-tools.json');
  });

  afterEach(async () => {
    // 恢复真实定时器
    vi.useRealTimers();

    // 关闭服务管理器
    try {
      await serviceManager.shutdown();
    } catch (_error) {
      // 忽略关闭错误
    }

    // 清理临时文件
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch (_error) {
      // 忽略清理错误
    }
  });

  describe('初始化和生命周期', () => {
    it('应该成功初始化服务管理器', async () => {
      const validConfig: ApiToolsConfig = {
        version: '1.0',
        tools: [
          {
            id: 'test-tool',
            name: '测试工具',
            description: '用于测试的API工具',
            api: {
              url: 'https://api.example.com/test',
              method: 'GET',
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
            response: {},
          },
        ],
      };

      await fs.writeFile(configPath, JSON.stringify(validConfig, null, 2));

      await serviceManager.initialize(configPath);

      const health = serviceManager.getHealthStatus();
      expect(health.status).toBe(ServiceStatus.RUNNING);
      expect(health.healthy).toBe(true);
      expect(health.toolStats.total).toBe(1);
    });

    it('应该在配置文件不存在时使用空配置成功初始化', async () => {
      const nonExistentPath = join(tempDir, 'non-existent.json');

      await serviceManager.initialize(nonExistentPath);

      const health = serviceManager.getHealthStatus();
      expect(health.status).toBe(ServiceStatus.RUNNING);
      expect(health.toolStats.total).toBe(0);
    });

    it('应该在重复初始化时发出警告且不重新加载', async () => {
      const validConfig: ApiToolsConfig = {
        version: '1.0',
        tools: [
          {
            id: 'dup-tool',
            name: '重复工具',
            description: '测试重复初始化',
            api: { url: 'https://api.example.com/dup', method: 'GET' },
            parameters: { type: 'object', properties: {} },
            response: {},
          },
        ],
      };

      await fs.writeFile(configPath, JSON.stringify(validConfig));
      await serviceManager.initialize(configPath);

      // 修改配置后再次初始化：应警告并直接返回，不重新加载
      await fs.writeFile(configPath, JSON.stringify({ version: '1.0', tools: [] }));
      await serviceManager.initialize(configPath);

      expect(vi.mocked(logger.warn)).toHaveBeenCalledWith('服务管理器已初始化或正在初始化中', {
        status: ServiceStatus.RUNNING,
      });
      const health = serviceManager.getHealthStatus();
      expect(health.status).toBe(ServiceStatus.RUNNING);
      // 原有工具未被清空
      expect(health.toolStats.total).toBe(1);
    });

    it('ERROR 状态下应允许重新初始化', async () => {
      await fs.writeFile(configPath, '{ invalid json }');
      await expect(serviceManager.initialize(configPath)).rejects.toThrow('初始化失败');
      expect(serviceManager.getHealthStatus().status).toBe(ServiceStatus.ERROR);

      // 修复配置文件后可以从 ERROR 状态重新初始化
      const validConfig: ApiToolsConfig = {
        version: '1.0',
        tools: [],
      };
      await fs.writeFile(configPath, JSON.stringify(validConfig));
      await serviceManager.initialize(configPath);

      expect(serviceManager.getHealthStatus().status).toBe(ServiceStatus.RUNNING);
    });

    it('初始化失败时应抛出包含原因的 ServiceError', async () => {
      await fs.writeFile(configPath, '{ invalid json }');

      await expect(serviceManager.initialize(configPath)).rejects.toThrow(/初始化失败: .+/);
      expect(vi.mocked(logger.error)).toHaveBeenCalledWith(
        'API转MCP服务管理器初始化失败',
        expect.any(Error),
      );
    });

    it('应该成功关闭服务管理器', async () => {
      const validConfig: ApiToolsConfig = {
        version: '1.0',
        tools: [
          {
            id: 'shutdown-tool',
            name: '关闭工具',
            description: '测试关闭',
            api: { url: 'https://api.example.com/shutdown', method: 'GET' },
            parameters: { type: 'object', properties: {} },
            response: {},
          },
        ],
      };

      await fs.writeFile(configPath, JSON.stringify(validConfig));
      await serviceManager.initialize(configPath);

      await serviceManager.shutdown();

      const health = serviceManager.getHealthStatus();
      expect(health.status).toBe(ServiceStatus.SHUTDOWN);
      expect(health.healthy).toBe(false);
      // 关闭后工具被清空
      expect(health.toolStats.total).toBe(0);
      // 关闭后执行被拒绝
      await expect(serviceManager.getApiTools()).rejects.toThrow(
        '服务管理器未运行，当前状态: shutdown',
      );
    });

    it('重复关闭应只记录警告且状态保持 SHUTDOWN', async () => {
      await fs.writeFile(configPath, JSON.stringify({ version: '1.0', tools: [] }));
      await serviceManager.initialize(configPath);

      await serviceManager.shutdown();
      await serviceManager.shutdown();

      expect(vi.mocked(logger.warn)).toHaveBeenCalledWith('服务管理器已关闭');
      expect(serviceManager.getHealthStatus().status).toBe(ServiceStatus.SHUTDOWN);
    });

    it('应该成功重启服务管理器', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });

      const validConfig: ApiToolsConfig = {
        version: '1.0',
        tools: [
          {
            id: 'restart-test',
            name: '重启测试',
            description: '测试重启功能',
            api: {
              url: 'https://api.example.com/restart',
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

      await fs.writeFile(configPath, JSON.stringify(validConfig));
      await serviceManager.initialize(configPath);

      const initialHealth = serviceManager.getHealthStatus();
      expect(initialHealth.status).toBe(ServiceStatus.RUNNING);

      const restartPromise = serviceManager.restart();
      await vi.advanceTimersByTimeAsync(1500);
      await restartPromise;

      const restartedHealth = serviceManager.getHealthStatus();
      expect(restartedHealth.status).toBe(ServiceStatus.RUNNING);
      expect(restartedHealth.toolStats.total).toBe(1);

      vi.useRealTimers();
    });
  });

  describe('配置管理', () => {
    it('应该成功重新加载配置', async () => {
      const initialConfig: ApiToolsConfig = {
        version: '1.0',
        tools: [
          {
            id: 'initial-tool',
            name: '初始工具',
            description: '初始配置的工具',
            api: {
              url: 'https://api.example.com/initial',
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

      await fs.writeFile(configPath, JSON.stringify(initialConfig));
      await serviceManager.initialize(configPath);

      const initialTools = await serviceManager.getApiTools();
      expect(initialTools).toHaveLength(1);
      expect(initialTools[0].name).toBe('initial-tool');

      // 更新配置文件
      const updatedConfig: ApiToolsConfig = {
        version: '1.0',
        tools: [
          {
            id: 'updated-tool',
            name: '更新工具',
            description: '更新后的工具',
            api: {
              url: 'https://api.example.com/updated',
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
              url: 'https://api.example.com/new',
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

      await fs.writeFile(configPath, JSON.stringify(updatedConfig));
      await serviceManager.reloadConfig();

      const updatedTools = await serviceManager.getApiTools();
      expect(updatedTools).toHaveLength(2);
      expect(updatedTools.map((t) => t.name)).toEqual(['updated-tool', 'new-tool']);
    });

    it('应该在未初始化时拒绝重新加载配置', async () => {
      await expect(serviceManager.reloadConfig()).rejects.toThrow(
        '服务管理器未运行，当前状态: not_initialized',
      );
    });
  });

  describe('工具管理', () => {
    beforeEach(async () => {
      const config: ApiToolsConfig = {
        version: '1.0',
        tools: [
          {
            id: 'test-tool',
            name: '测试工具',
            description: '用于测试的API工具',
            api: {
              url: 'https://api.example.com/test',
              method: 'GET',
              queryParams: {
                q: '{{data.query}}',
              },
            },
            parameters: {
              type: 'object',
              properties: {
                query: {
                  type: 'string',
                  description: '查询参数',
                  minLength: 1,
                },
              },
              required: ['query'],
            },
            response: {
              jsonata: '{ "result": data }',
            },
          },
        ],
      };

      await fs.writeFile(configPath, JSON.stringify(config));
      await serviceManager.initialize(configPath);
    });

    it('应该获取所有API工具', async () => {
      const tools = await serviceManager.getApiTools();

      expect(tools).toHaveLength(1);
      expect(tools[0].name).toBe('test-tool');
      expect(tools[0].description).toContain('用于测试的API工具');
    });

    it('应该获取工具定义', () => {
      const tool = serviceManager.getToolDefinition('test-tool');

      expect(tool).toBeDefined();
      expect(tool?.name).toBe('test-tool');
    });

    it('应该在工具不存在时返回undefined', () => {
      const tool = serviceManager.getToolDefinition('non-existent-tool');

      expect(tool).toBeUndefined();
    });

    it('应该验证工具参数', () => {
      const validParams = { query: 'test query' };
      const result = serviceManager.validateToolParameters('test-tool', validParams);

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('应该检测无效的工具参数', () => {
      const invalidParams = {}; // 缺少必需的query参数
      const result = serviceManager.validateToolParameters('test-tool', invalidParams);

      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });

    it('应该在工具不存在时返回验证错误', () => {
      const result = serviceManager.validateToolParameters('non-existent-tool', {});

      expect(result.valid).toBe(false);
      expect(result.errors[0].code).toBe('TOOL_NOT_FOUND');
    });
  });

  describe('工具执行', () => {
    beforeEach(async () => {
      const config: ApiToolsConfig = {
        version: '1.0',
        tools: [
          {
            id: 'mock-tool',
            name: 'Mock工具',
            description: '用于测试的Mock工具',
            api: {
              url: 'https://httpbin.org/json',
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

      await fs.writeFile(configPath, JSON.stringify(config));
      await serviceManager.initialize(configPath);
    });

    it('应该在工具不存在时返回错误结果', async () => {
      const result = await serviceManager.executeApiTool('non-existent', {});

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('不存在');
    });

    it('应该在参数验证失败时返回错误结果', async () => {
      // 创建一个需要参数的工具配置
      const configWithParams: ApiToolsConfig = {
        version: '1.0',
        tools: [
          {
            id: 'param-tool',
            name: '参数工具',
            description: '需要参数的工具',
            api: {
              url: 'https://httpbin.org/get',
              method: 'GET',
            },
            parameters: {
              type: 'object',
              properties: {
                required_param: {
                  type: 'string',
                  minLength: 1,
                },
              },
              required: ['required_param'],
            },
            response: {},
          },
        ],
      };

      await fs.writeFile(configPath, JSON.stringify(configWithParams));
      await serviceManager.reloadConfig();

      const result = await serviceManager.executeApiTool('param-tool', {});

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('参数验证失败');
      expect(result.content[0].text).toContain('required_param');
    });

    it('应该在工具不存在时返回包含工具名的错误', async () => {
      const result = await serviceManager.executeApiTool('missing-tool', {});

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toBe("工具 'missing-tool' 不存在");
    });
  });

  describe('工具执行与响应处理', () => {
    const writeConfig = async (jsonata?: string) => {
      const config: ApiToolsConfig = {
        version: '1.0',
        tools: [
          {
            id: 'mock-tool',
            name: 'Mock工具',
            description: '用于测试的Mock工具',
            api: {
              url: 'https://api.example.com/data',
              method: 'GET',
            },
            parameters: { type: 'object', properties: {} },
            response: jsonata ? { jsonata } : {},
          },
        ],
      };
      await fs.writeFile(configPath, JSON.stringify(config));
      await serviceManager.initialize(configPath);
    };

    it('成功响应应返回 JSON 序列化后的数据', async () => {
      await writeConfig();
      mockFetch.mockResolvedValue(
        new Response(JSON.stringify({ result: 'ok', count: 3 }), { status: 200 }),
      );

      const result = await serviceManager.executeApiTool('mock-tool', {});

      expect(result.isError).toBe(false);
      expect(result.content).toHaveLength(1);
      expect(result.content[0].type).toBe('text');
      expect(result.content[0].text).toBe(JSON.stringify({ result: 'ok', count: 3 }, null, 2));
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('配置 JSONata 表达式时应返回转换后的结果', async () => {
      await writeConfig('{ "value": x, "doubled": x * 2 }');
      mockFetch.mockResolvedValue(new Response(JSON.stringify({ x: 21 }), { status: 200 }));

      const result = await serviceManager.executeApiTool('mock-tool', {});

      expect(result.isError).toBe(false);
      expect(result.content[0].text).toBe(JSON.stringify({ value: 21, doubled: 42 }, null, 2));
    });

    it('字符串响应数据应原样返回不进行 JSON 序列化', async () => {
      await writeConfig();
      // JSON 字符串体经 Response.json() 解析后为 string 类型的 data
      mockFetch.mockResolvedValue(
        new Response(JSON.stringify('plain text result'), { status: 200 }),
      );

      const result = await serviceManager.executeApiTool('mock-tool', {});

      expect(result.isError).toBe(false);
      expect(result.content[0].text).toBe('plain text result');
    });

    it('JSONata 表达式执行失败时应返回响应处理失败', async () => {
      await writeConfig('$invalidField.sub[+]');
      mockFetch.mockResolvedValue(new Response(JSON.stringify({ x: 1 }), { status: 200 }));

      const result = await serviceManager.executeApiTool('mock-tool', {});

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(/^响应处理失败: /);
    });

    it('HTTP 错误响应应返回提取后的错误信息', async () => {
      await writeConfig();
      mockFetch.mockResolvedValue(
        new Response(JSON.stringify({ error: '服务端错误' }), { status: 500 }),
      );

      const result = await serviceManager.executeApiTool('mock-tool', {});

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toBe('服务端错误');
    });

    it('无错误详情的 HTTP 错误应返回状态文本', async () => {
      await writeConfig();
      mockFetch.mockResolvedValue(
        new Response('', { status: 503, statusText: 'Service Unavailable' }),
      );

      const result = await serviceManager.executeApiTool('mock-tool', {});

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toBe('Service Unavailable');
    });

    it('请求失败时应返回执行失败信息而不抛出异常', async () => {
      await writeConfig();
      mockFetch.mockResolvedValue(
        new Response(JSON.stringify({}), { status: 404, statusText: 'Not Found' }),
      );

      const result = await serviceManager.executeApiTool('mock-tool', {});

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toBe('Not Found');
    });
  });

  describe('健康检查', () => {
    it('未初始化时应返回 NOT_INITIALIZED 状态且 uptime 为 0', () => {
      const health = serviceManager.getHealthStatus();

      expect(health.status).toBe(ServiceStatus.NOT_INITIALIZED);
      expect(health.healthy).toBe(false);
      expect(health.initializationTime).toBeUndefined();
      expect(health.lastHealthCheck).toBeUndefined();
      expect(health.uptime).toBe(0);
      expect(health.toolStats).toEqual({ total: 0, registered: 0, failed: 0 });
    });

    it('运行中应根据初始化时间计算 uptime', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      vi.setSystemTime(new Date('2026-01-01T12:00:00Z'));

      await fs.writeFile(configPath, JSON.stringify({ version: '1.0', tools: [] }));
      await serviceManager.initialize(configPath);

      const initTime = serviceManager.getHealthStatus().initializationTime;
      expect(initTime).toBeDefined();

      // 推进 5 秒后 uptime 应随之增长
      vi.setSystemTime(new Date('2026-01-01T12:00:05Z'));
      const health = serviceManager.getHealthStatus();
      expect(health.uptime).toBeGreaterThanOrEqual(5000);
      expect(health.uptime).toBeLessThan(6000);
      expect(health.initializationTime).toBe(initTime);
    });

    it('应该执行健康检查', async () => {
      const config: ApiToolsConfig = {
        version: '1.0',
        tools: [
          {
            id: 'health-test',
            name: '健康测试',
            description: '健康检查测试工具',
            api: {
              url: 'https://api.example.com/health',
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

      await fs.writeFile(configPath, JSON.stringify(config));
      await serviceManager.initialize(configPath);

      const health = await serviceManager.performHealthCheck();

      expect(health.healthy).toBe(true);
      expect(health.status).toBe(ServiceStatus.RUNNING);
      expect(health.lastHealthCheck).toBeDefined();
      expect(health.errors).toBeUndefined();
      expect(health.toolStats).toEqual({ total: 1, registered: 1, failed: 0 });
    });

    it('未初始化的服务执行健康检查应报告全部问题', async () => {
      const health = await serviceManager.performHealthCheck();

      expect(health.healthy).toBe(false);
      expect(health.errors).toEqual(['没有注册的API工具', '配置文件路径未设置']);
      expect(vi.mocked(logger.warn)).toHaveBeenCalledWith('健康检查发现问题', {
        context: { errors: ['没有注册的API工具', '配置文件路径未设置'] },
      });
    });

    it('应该在未初始化时报告不健康状态', () => {
      const health = serviceManager.getHealthStatus();

      expect(health.healthy).toBe(false);
      expect(health.status).toBe(ServiceStatus.NOT_INITIALIZED);
    });

    it('应定期执行健康检查并更新检查时间', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });

      await fs.writeFile(configPath, JSON.stringify({ version: '1.0', tools: [] }));
      await serviceManager.initialize(configPath);

      // 等待 setImmediate 触发的初始健康检查
      await vi.advanceTimersByTimeAsync(0);
      const firstCheck = serviceManager.getHealthStatus().lastHealthCheck;
      expect(firstCheck).toBeDefined();

      // 推进 30 秒触发定时健康检查
      await vi.advanceTimersByTimeAsync(31000);
      const secondCheck = serviceManager.getHealthStatus().lastHealthCheck;
      expect(secondCheck).toBeDefined();
      expect(secondCheck!.getTime()).toBeGreaterThan(firstCheck!.getTime());
    });
  });

  describe('错误处理', () => {
    it('应该在未初始化时拒绝获取工具', async () => {
      await expect(serviceManager.getApiTools()).rejects.toThrow(
        '服务管理器未运行，当前状态: not_initialized',
      );
    });

    it('应该在未初始化时拒绝执行工具', async () => {
      await expect(serviceManager.executeApiTool('test', {})).rejects.toThrow(
        '服务管理器未运行，当前状态: not_initialized',
      );
    });

    it('应该处理配置文件格式错误', async () => {
      await fs.writeFile(configPath, '{ invalid json }');

      await expect(serviceManager.initialize(configPath)).rejects.toThrow('初始化失败');

      const health = serviceManager.getHealthStatus();
      expect(health.status).toBe(ServiceStatus.ERROR);
    });

    it('应该处理重新加载时的配置错误', async () => {
      const validConfig: ApiToolsConfig = {
        version: '1.0',
        tools: [],
      };

      await fs.writeFile(configPath, JSON.stringify(validConfig));
      await serviceManager.initialize(configPath);

      // 写入无效配置
      await fs.writeFile(configPath, '{ invalid }');

      await expect(serviceManager.reloadConfig()).rejects.toThrow('重新加载失败');

      const health = serviceManager.getHealthStatus();
      expect(health.status).toBe(ServiceStatus.ERROR);
    });

    it('应该在没有配置路径时拒绝重启', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });

      // 创建一个没有配置路径的服务管理器
      const manager = new ApiToMcpServiceManagerImpl();
      await manager.shutdown(); // 设置为关闭状态

      // restart() 内部有 1s 延迟，用 fake timers 跳过
      const restartPromise = manager.restart();
      // 防止 fake timer 推进期间 promise 无 handler 导致 unhandled rejection
      restartPromise.catch(() => {});
      await vi.advanceTimersByTimeAsync(1500);
      await expect(restartPromise).rejects.toThrow('无法重启：配置文件路径未设置');

      vi.useRealTimers();
    });

    it('重启时初始化失败应进入 ERROR 状态并抛出原始错误', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });

      await fs.writeFile(configPath, JSON.stringify({ version: '1.0', tools: [] }));
      await serviceManager.initialize(configPath);

      // 写入无效配置后重启
      await fs.writeFile(configPath, '{ invalid }');
      const restartPromise = serviceManager.restart();
      restartPromise.catch(() => {});
      await vi.advanceTimersByTimeAsync(1500);
      await expect(restartPromise).rejects.toThrow('初始化失败');

      expect(serviceManager.getHealthStatus().status).toBe(ServiceStatus.ERROR);

      vi.useRealTimers();
    });

    it('重启后应重建组件并恢复工具', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });

      const config: ApiToolsConfig = {
        version: '1.0',
        tools: [
          {
            id: 'restart-tool',
            name: '重启工具',
            description: '测试重启重建',
            api: { url: 'https://api.example.com/restart-tool', method: 'GET' },
            parameters: { type: 'object', properties: {} },
            response: {},
          },
        ],
      };
      await fs.writeFile(configPath, JSON.stringify(config));
      await serviceManager.initialize(configPath);

      const restartPromise = serviceManager.restart();
      await vi.advanceTimersByTimeAsync(1500);
      await restartPromise;

      const health = serviceManager.getHealthStatus();
      expect(health.status).toBe(ServiceStatus.RUNNING);
      expect(health.toolStats.total).toBe(1);
      expect(serviceManager.getToolDefinition('restart-tool')).toBeDefined();
      expect(vi.mocked(logger.info)).toHaveBeenCalledWith('服务管理器重启完成');

      vi.useRealTimers();
    });
  });

  describe('并发和资源管理', () => {
    it('应该处理并发的工具执行请求', async () => {
      // Mock fetch 以避免真实网络请求
      mockFetch.mockResolvedValue(new Response(JSON.stringify({ result: 'ok' }), { status: 200 }));

      const config: ApiToolsConfig = {
        version: '1.0',
        tools: [
          {
            id: 'concurrent-tool',
            name: '并发工具',
            description: '用于并发测试的工具',
            api: {
              url: 'https://api.example.com/test',
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

      await fs.writeFile(configPath, JSON.stringify(config));
      await serviceManager.initialize(configPath);

      // 并发执行多个工具调用
      const promises = Array.from({ length: 3 }, () =>
        serviceManager.executeApiTool('concurrent-tool', {}),
      );

      const results = await Promise.allSettled(promises);

      // 所有请求都应该完成（无论成功还是失败）
      expect(results).toHaveLength(3);
      results.forEach((result) => {
        expect(result.status).toBe('fulfilled');
      });
    }, 10000);

    it('应该正确清理资源', async () => {
      const config: ApiToolsConfig = {
        version: '1.0',
        tools: [
          {
            id: 'cleanup-test',
            name: '清理测试',
            description: '测试资源清理',
            api: {
              url: 'https://api.example.com/cleanup',
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

      await fs.writeFile(configPath, JSON.stringify(config));
      await serviceManager.initialize(configPath);

      const initialHealth = serviceManager.getHealthStatus();
      expect(initialHealth.toolStats.total).toBe(1);

      await serviceManager.shutdown();

      const finalHealth = serviceManager.getHealthStatus();
      expect(finalHealth.status).toBe(ServiceStatus.SHUTDOWN);
    });
  });
});
