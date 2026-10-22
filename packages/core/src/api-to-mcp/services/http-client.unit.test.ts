/**
 * HTTP客户端测试
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createHttpClient, HttpClient } from './http-client.js';

import type {
  HttpRequestConfig,
  RequestInterceptor,
  ResponseInterceptor,
} from '../types/http-client.js';

// Mock fetch
const mockFetch = vi.fn();
global.fetch = mockFetch;

describe('HttpClient', () => {
  let httpClient: HttpClient;

  beforeEach(() => {
    // 重置所有mock
    vi.clearAllMocks();

    // 创建HTTP客户端
    httpClient = new HttpClient();
  });

  afterEach(() => {
    httpClient.destroy();
  });

  describe('构造函数', () => {
    it('应该使用默认配置创建HTTP客户端', () => {
      const client = new HttpClient();
      expect(client).toBeInstanceOf(HttpClient);
    });

    it('应该使用自定义配置创建HTTP客户端', () => {
      const config = {
        timeout: 5000,
        retries: 1,
        defaultHeaders: {
          'Custom-Header': 'test-value',
        },
      };

      const client = new HttpClient(config);
      expect(client).toBeInstanceOf(HttpClient);
      client.destroy();
    });
  });

  describe('request方法', () => {
    it('应该成功执行HTTP请求', async () => {
      const mockResponse = new Response(JSON.stringify({ message: 'success' }), {
        status: 200,
        statusText: 'OK',
        headers: { 'content-type': 'application/json' },
      });

      mockFetch.mockResolvedValueOnce(mockResponse);

      const config: HttpRequestConfig = {
        url: 'https://api.example.com/test',
        method: 'GET',
      };

      const response = await httpClient.request(config);

      expect(response.status).toBe(200);
      expect(response.statusText).toBe('OK');
      expect(response.data).toEqual({ message: 'success' });
      expect(response.raw).toBe(mockResponse);
      expect(response.config.url).toBe('https://api.example.com/test');
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.example.com/test',
        expect.objectContaining({
          method: 'GET',
        }),
      );
    });

    it('应该合并默认请求头且请求头优先', async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({}), { status: 200, headers: {} }),
      );

      await httpClient.request({
        url: 'https://api.example.com/test',
        method: 'GET',
        headers: { 'User-Agent': 'Custom-Agent/2.0', 'X-Trace': 'abc' },
      });

      const [, options] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(options.headers).toEqual({
        'User-Agent': 'Custom-Agent/2.0',
        Accept: 'application/json, text/plain, */*',
        'X-Trace': 'abc',
      });
    });

    it('非JSON响应体应解析为空对象', async () => {
      mockFetch.mockResolvedValueOnce(new Response('<html>not json</html>', { status: 200 }));

      const response = await httpClient.request({
        url: 'https://api.example.com/test',
        method: 'GET',
      });

      expect(response.status).toBe(200);
      expect(response.data).toEqual({});
    });

    it('字符串请求体应原样传递且不自动设置Content-Type', async () => {
      mockFetch.mockResolvedValueOnce(new Response('{}', { status: 200 }));

      await httpClient.request({
        url: 'https://api.example.com/echo',
        method: 'POST',
        data: 'raw-text-body',
      });

      const [, options] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(options.body).toBe('raw-text-body');
      expect(options.headers).not.toHaveProperty('Content-Type');
    });

    it('对象请求体应JSON序列化并自动设置Content-Type', async () => {
      mockFetch.mockResolvedValueOnce(new Response('{}', { status: 200 }));

      await httpClient.request({
        url: 'https://api.example.com/users',
        method: 'PUT',
        data: { name: 'John' },
      });

      const [, options] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(options.body).toBe(JSON.stringify({ name: 'John' }));
      expect(options.headers).toMatchObject({ 'Content-Type': 'application/json' });
    });

    it('应该处理请求失败并重试', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });

      const error = new Error('Network Error');
      mockFetch
        .mockRejectedValueOnce(error)
        .mockRejectedValueOnce(error)
        .mockImplementationOnce(() => {
          return Promise.resolve(
            new Response(JSON.stringify({ message: 'success after retry' }), {
              status: 200,
              statusText: 'OK',
              headers: {},
            }),
          );
        });

      const config: HttpRequestConfig = {
        url: 'https://api.example.com/test',
        method: 'GET',
        retries: 2,
      };

      const promise = httpClient.request(config);
      await vi.advanceTimersByTimeAsync(5000);
      const response = await promise;

      expect(response.status).toBe(200);
      expect(response.data).toEqual({ message: 'success after retry' });
      expect(mockFetch).toHaveBeenCalledTimes(3);

      vi.useRealTimers();
    });

    it('重试应使用指数退避延迟', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });

      mockFetch.mockImplementation(() => Promise.reject(new Error('Network Error')));

      const config: HttpRequestConfig = {
        url: 'https://api.example.com/test',
        method: 'GET',
        retries: 2, // 延迟 1s + 2s
      };

      const promise = httpClient.request(config);
      promise.catch(() => {});

      // 只推进 2.5 秒（小于 1+2=3 秒总延迟）时尚未完成全部重试
      await vi.advanceTimersByTimeAsync(2500);
      expect(mockFetch.mock.calls.length).toBeLessThan(3);

      await vi.advanceTimersByTimeAsync(1000);
      await expect(promise).rejects.toThrow('Network Error');
      expect(mockFetch).toHaveBeenCalledTimes(3);

      vi.useRealTimers();
    });

    it('未指定重试次数时应使用客户端默认配置', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });

      const customClient = new HttpClient({ retries: 2 });
      mockFetch.mockImplementation(() => Promise.reject(new Error('Network Error')));

      const promise = customClient.request({
        url: 'https://api.example.com/test',
        method: 'GET',
      });
      promise.catch(() => {});
      await vi.advanceTimersByTimeAsync(4000);

      await expect(promise).rejects.toThrow('Network Error');
      expect(mockFetch).toHaveBeenCalledTimes(3); // 1 + 2 次重试

      customClient.destroy();
      vi.useRealTimers();
    });

    it('应该在所有重试失败后抛出错误', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });

      const error = new Error('Network Error');
      mockFetch.mockRejectedValue(error);

      const config: HttpRequestConfig = {
        url: 'https://api.example.com/test',
        method: 'GET',
        retries: 1,
      };

      const promise = httpClient.request(config);
      // 防止 fake timer 推进期间 promise 无 handler 导致 unhandled rejection
      promise.catch(() => {});
      await vi.advanceTimersByTimeAsync(3000);
      await expect(promise).rejects.toThrow('Network Error');
      expect(mockFetch).toHaveBeenCalledTimes(2); // 1 + 1 retry

      vi.useRealTimers();
    });

    it('请求超时应转换为Network timeout错误', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });

      // 模拟遵循 AbortSignal 的 fetch
      mockFetch.mockImplementation(
        (_url: string, options: RequestInit) =>
          new Promise((_resolve, reject) => {
            options.signal?.addEventListener('abort', () => {
              reject(new DOMException('The operation was aborted', 'AbortError'));
            });
          }),
      );

      const promise = httpClient.request({
        url: 'https://api.example.com/slow',
        method: 'GET',
        timeout: 100,
        retries: 0,
      });
      promise.catch(() => {});

      await vi.advanceTimersByTimeAsync(200);
      await expect(promise).rejects.toThrow('Network timeout');

      vi.useRealTimers();
    });

    it('默认超时配置应生效', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });

      const customClient = new HttpClient({ timeout: 100 });
      mockFetch.mockImplementation(
        (_url: string, options: RequestInit) =>
          new Promise((_resolve, reject) => {
            options.signal?.addEventListener('abort', () => {
              reject(new DOMException('The operation was aborted', 'AbortError'));
            });
          }),
      );

      const promise = customClient.request({
        url: 'https://api.example.com/slow',
        method: 'GET',
        retries: 0,
      });
      promise.catch(() => {});

      await vi.advanceTimersByTimeAsync(200);
      await expect(promise).rejects.toThrow('Network timeout');

      customClient.destroy();
      vi.useRealTimers();
    });

    it('应该支持POST请求和请求体', async () => {
      const mockResponse = new Response(JSON.stringify({ id: 1 }), {
        status: 201,
        statusText: 'Created',
        headers: {},
      });

      mockFetch.mockResolvedValueOnce(mockResponse);

      const config: HttpRequestConfig = {
        url: 'https://api.example.com/users',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        data: { name: 'John Doe' },
      };

      const response = await httpClient.request(config);

      expect(response.status).toBe(201);
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.example.com/users',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ name: 'John Doe' }),
          headers: expect.objectContaining({
            'Content-Type': 'application/json',
          }),
        }),
      );
    });
  });

  describe('拦截器', () => {
    it('请求拦截器应能修改实际发出的请求', async () => {
      mockFetch.mockResolvedValueOnce(new Response('{}', { status: 200 }));

      httpClient.addRequestInterceptor((config) => ({
        ...config,
        url: 'https://api.example.com/intercepted',
        headers: { ...config.headers, 'X-Intercepted': 'yes' },
      }));

      await httpClient.request({ url: 'https://api.example.com/original', method: 'GET' });

      const [calledUrl, options] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(calledUrl).toBe('https://api.example.com/intercepted');
      expect(options.headers).toMatchObject({ 'X-Intercepted': 'yes' });
    });

    it('多个请求拦截器应按顺序应用', async () => {
      mockFetch.mockResolvedValueOnce(new Response('{}', { status: 200 }));

      httpClient.addRequestInterceptor((config) => ({ ...config, url: `${config.url}/first` }));
      httpClient.addRequestInterceptor((config) => ({ ...config, url: `${config.url}/second` }));

      await httpClient.request({ url: 'https://api.example.com/base', method: 'GET' });

      expect(mockFetch.mock.calls[0][0]).toBe('https://api.example.com/base/first/second');
    });

    it('响应拦截器应能转换响应结果', async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ original: true }), { status: 200 }),
      );

      httpClient.addResponseInterceptor((response) => ({
        ...response,
        data: { transformed: true },
      }));

      const response = await httpClient.request({
        url: 'https://api.example.com/test',
        method: 'GET',
      });

      expect(response.data).toEqual({ transformed: true });
      expect(response.status).toBe(200);
    });

    it('应该支持添加响应拦截器', () => {
      const responseInterceptor: ResponseInterceptor = (response) => {
        return response;
      };

      expect(() => httpClient.addResponseInterceptor(responseInterceptor)).not.toThrow();
    });
  });

  describe('默认配置', () => {
    it('setDefaults 应更新后续请求使用的默认值', async () => {
      mockFetch.mockResolvedValueOnce(new Response('{}', { status: 200 }));

      httpClient.setDefaults({
        defaultHeaders: { Authorization: 'Bearer token' },
        timeout: 5000,
      });

      await httpClient.request({ url: 'https://api.example.com/test', method: 'GET' });

      const [, options] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(options.headers).toMatchObject({ Authorization: 'Bearer token' });
    });
  });

  describe('连接池管理', () => {
    it('请求成功后应记录目标主机的连接', async () => {
      mockFetch.mockResolvedValueOnce(new Response('{}', { status: 200 }));

      await httpClient.request({ url: 'https://api.example.com/test', method: 'GET' });

      const status = httpClient.getConnectionPoolStatus();
      expect(status.total).toBe(1);
      expect(status.active).toBe(1);
      expect(status.idle).toBe(0);
      expect(status.connections[0]).toMatchObject({
        id: 'api.example.com:443',
        host: 'api.example.com',
        active: true,
      });
    });

    it('http 请求默认端口应为 80', async () => {
      mockFetch.mockResolvedValueOnce(new Response('{}', { status: 200 }));

      await httpClient.request({ url: 'http://api.example.com/test', method: 'GET' });

      const status = httpClient.getConnectionPoolStatus();
      expect(status.connections[0].id).toBe('api.example.com:80');
    });

    it('同一主机的重复请求应复用连接', async () => {
      mockFetch.mockResolvedValue(new Response('{}', { status: 200 }));

      await httpClient.request({ url: 'https://api.example.com/a', method: 'GET' });
      await httpClient.request({ url: 'https://api.example.com/b', method: 'GET' });

      const status = httpClient.getConnectionPoolStatus();
      expect(status.total).toBe(1);
      expect(status.active).toBe(1);
    });

    it('超过空闲超时的连接应被标记为空闲', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));

      const customClient = new HttpClient({
        connectionPool: {
          idleTimeout: 5000,
          maxConnections: 10,
          connectionTimeout: 1000,
          keepAlive: true,
        },
      });
      mockFetch.mockResolvedValue(new Response('{}', { status: 200 }));

      await customClient.request({ url: 'https://api.example.com/test', method: 'GET' });
      expect(customClient.getConnectionPoolStatus().active).toBe(1);

      vi.setSystemTime(new Date('2026-01-01T00:00:10Z'));
      const status = customClient.getConnectionPoolStatus();
      expect(status.active).toBe(0);
      expect(status.idle).toBe(1);

      customClient.destroy();
      vi.useRealTimers();
    });

    it('cleanupIdleConnections 应移除超时连接', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));

      const customClient = new HttpClient({
        connectionPool: {
          idleTimeout: 5000,
          maxConnections: 10,
          connectionTimeout: 1000,
          keepAlive: true,
        },
      });
      mockFetch.mockResolvedValue(new Response('{}', { status: 200 }));

      await customClient.request({ url: 'https://api.example.com/test', method: 'GET' });
      expect(customClient.getConnectionPoolStatus().total).toBe(1);

      vi.setSystemTime(new Date('2026-01-01T00:00:10Z'));
      customClient.cleanupIdleConnections();

      expect(customClient.getConnectionPoolStatus().total).toBe(0);

      customClient.destroy();
      vi.useRealTimers();
    });

    it('未超时的连接不应被清理', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));

      const customClient = new HttpClient({
        connectionPool: {
          idleTimeout: 60000,
          maxConnections: 10,
          connectionTimeout: 1000,
          keepAlive: true,
        },
      });
      mockFetch.mockResolvedValue(new Response('{}', { status: 200 }));

      await customClient.request({ url: 'https://api.example.com/test', method: 'GET' });

      vi.setSystemTime(new Date('2026-01-01T00:00:30Z'));
      customClient.cleanupIdleConnections();

      expect(customClient.getConnectionPoolStatus().total).toBe(1);

      customClient.destroy();
      vi.useRealTimers();
    });

    it('应该返回连接池状态', () => {
      const status = httpClient.getConnectionPoolStatus();

      expect(status).toHaveProperty('total');
      expect(status).toHaveProperty('active');
      expect(status).toHaveProperty('idle');
      expect(status).toHaveProperty('connections');
      expect(Array.isArray(status.connections)).toBe(true);
    });

    it('应该支持清理空闲连接', () => {
      expect(() => httpClient.cleanupIdleConnections()).not.toThrow();
    });
  });

  describe('工厂函数', () => {
    it('应该通过工厂函数创建HTTP客户端', () => {
      const client = createHttpClient();
      expect(client).toBeInstanceOf(HttpClient);
      client.destroy();
    });

    it('应该通过工厂函数创建带配置的HTTP客户端', () => {
      const config = { timeout: 10000 };
      const client = createHttpClient(config);
      expect(client).toBeInstanceOf(HttpClient);
      client.destroy();
    });
  });

  describe('错误处理', () => {
    it('fetch 拒绝且无重试时应直接抛出错误', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Network Error'));

      await expect(
        httpClient.request({
          url: 'https://api.example.com/test',
          method: 'GET',
          retries: 0,
        }),
      ).rejects.toThrow('Network Error');
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('成功请求但URL无效时不应记录连接', async () => {
      mockFetch.mockResolvedValueOnce(new Response('{}', { status: 200 }));

      const response = await httpClient.request({
        url: 'not-a-valid-url',
        method: 'GET',
        retries: 0,
      });

      expect(response.status).toBe(200);
      expect(httpClient.getConnectionPoolStatus().total).toBe(0);
    });
  });

  describe('销毁', () => {
    it('销毁后应清空所有连接', async () => {
      mockFetch.mockResolvedValueOnce(new Response('{}', { status: 200 }));

      await httpClient.request({ url: 'https://api.example.com/test', method: 'GET' });
      expect(httpClient.getConnectionPoolStatus().total).toBe(1);

      httpClient.destroy();

      expect(httpClient.getConnectionPoolStatus().total).toBe(0);
      expect(httpClient.getConnectionPoolStatus().connections).toEqual([]);
    });
  });
});
