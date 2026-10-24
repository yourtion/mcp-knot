/**
 * API执行器测试
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ErrorCode, ServiceError } from '../../errors/index.js';
import { ApiExecutorImpl, createApiExecutor } from './api-executor.js';

import type { ApiToolConfig, AuthConfig } from '../types/api-config.js';
import type { HttpRequestConfig, HttpResponse } from '../types/http-client.js';
import type { AuthenticationManager } from './authentication.js';
import type { HttpClient } from './http-client.js';

const mockBuildRequest = vi.fn().mockImplementation((apiConfig, _context) => ({
  success: true,
  request: {
    url: apiConfig.url,
    method: apiConfig.method,
    headers: apiConfig.headers,
    params: apiConfig.queryParams,
    data: apiConfig.body,
    timeout: apiConfig.timeout,
    retries: apiConfig.retries,
  },
  usedVariables: [],
}));

const mockValidateParameters = vi.fn().mockReturnValue({ valid: true, errors: [] });

const loggerMocks = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));

// Mock依赖
vi.mock('../../utils/logger.js', () => ({
  logger: loggerMocks,
  createLogger: vi.fn(() => loggerMocks),
}));
vi.mock('./http-client.js');
vi.mock('./authentication.js');
vi.mock('../utils/http-request-builder.js', () => ({
  HttpRequestBuilderImpl: vi.fn(
    class MockHttpRequestBuilderImpl {
      buildRequest = mockBuildRequest;
    },
  ),
}));
vi.mock('../utils/parameter-validator.js', () => ({
  ParameterValidatorImpl: vi.fn(
    class MockParameterValidatorImpl {
      validate = mockValidateParameters;
    },
  ),
}));

describe('ApiExecutorImpl', () => {
  let apiExecutor: ApiExecutorImpl;
  let mockHttpClient: HttpClient;
  let mockAuthManager: AuthenticationManager;

  beforeEach(() => {
    vi.clearAllMocks();

    // 创建mock实例
    mockHttpClient = {
      request: vi.fn(),
      addRequestInterceptor: vi.fn(),
      addResponseInterceptor: vi.fn(),
      setDefaults: vi.fn(),
      getConnectionPoolStatus: vi.fn(),
      cleanupIdleConnections: vi.fn(),
      destroy: vi.fn(),
    } as unknown as HttpClient;

    mockAuthManager = {
      applyAuthentication: vi.fn(),
      validateAuthConfig: vi.fn(),
      resolveEnvironmentVariables: vi.fn(),
      validateEnvironmentVariables: vi.fn(),
      getSupportedTypes: vi.fn(),
      getStrategy: vi.fn(),
      registerStrategy: vi.fn(),
    } as unknown as AuthenticationManager;

    apiExecutor = new ApiExecutorImpl(mockHttpClient, mockAuthManager);
  });

  describe('构造函数', () => {
    it('应该使用默认配置创建API执行器', () => {
      const executor = new ApiExecutorImpl(mockHttpClient, mockAuthManager);
      expect(executor).toBeInstanceOf(ApiExecutorImpl);
    });

    it('应该使用自定义配置创建API执行器', () => {
      const config = {
        defaultTimeout: 5000,
        defaultRetries: 1,
        enableRequestLogging: false,
      };

      const executor = new ApiExecutorImpl(mockHttpClient, mockAuthManager, config);
      expect(executor).toBeInstanceOf(ApiExecutorImpl);
    });
  });

  describe('buildHttpRequest', () => {
    it('应该构建基本的HTTP请求', () => {
      const apiConfig: ApiToolConfig = {
        id: 'test-api',
        name: '测试API',
        description: '测试用API',
        api: {
          url: 'https://api.example.com/test',
          method: 'GET',
          headers: { 'Content-Type': 'application/json' },
          timeout: 5000,
          retries: 2,
        },
        parameters: {
          type: 'object',
          properties: {},
        },
        response: {},
      };

      const parameters = { param1: 'value1' };
      const request = apiExecutor.buildHttpRequest(apiConfig, parameters);

      expect(request.url).toBe('https://api.example.com/test');
      expect(request.method).toBe('GET');
      expect(request.headers).toEqual({ 'Content-Type': 'application/json' });
      expect(request.timeout).toBe(5000);
      expect(request.retries).toBe(2);
    });

    it('应该设置默认超时和重试次数', () => {
      const apiConfig: ApiToolConfig = {
        id: 'test-api',
        name: '测试API',
        description: '测试用API',
        api: {
          url: 'https://api.example.com/test',
          method: 'GET',
        },
        parameters: {
          type: 'object',
          properties: {},
        },
        response: {},
      };

      const request = apiExecutor.buildHttpRequest(apiConfig, {});

      expect(request.timeout).toBe(30000); // 默认超时
      expect(request.retries).toBe(3); // 默认重试次数
    });

    it('构建结果缺少请求对象时应抛出错误', () => {
      const originalImpl = mockBuildRequest.getMockImplementation();
      mockBuildRequest.mockReturnValue({
        success: true,
        request: undefined,
        usedVariables: [],
      });

      expect(() =>
        apiExecutor.buildHttpRequest(
          {
            id: 'test-api',
            name: '测试API',
            description: '测试用API',
            api: { url: 'https://api.example.com/test', method: 'GET' },
            parameters: { type: 'object', properties: {} },
            response: {},
          },
          {},
        ),
      ).toThrow('构建HTTP请求失败: 请求对象为空');

      mockBuildRequest.mockImplementation(originalImpl);
    });

    it('构建失败时应抛出包含原因的错误', () => {
      const originalImpl = mockBuildRequest.getMockImplementation();
      mockBuildRequest.mockReturnValue({
        success: false,
        error: '无效的 URL 模板',
        usedVariables: [],
      });

      expect(() =>
        apiExecutor.buildHttpRequest(
          {
            id: 'test-api',
            name: '测试API',
            description: '测试用API',
            api: { url: 'https://api.example.com/test', method: 'GET' },
            parameters: { type: 'object', properties: {} },
            response: {},
          },
          {},
        ),
      ).toThrow('构建HTTP请求失败: 无效的 URL 模板');

      mockBuildRequest.mockImplementation(originalImpl);
    });
  });

  describe('applyAuthentication', () => {
    it('应该应用认证到HTTP请求', async () => {
      const request: HttpRequestConfig = {
        url: 'https://api.example.com/test',
        method: 'GET',
      };

      const authConfig: AuthConfig = {
        type: 'bearer',
        token: 'test-token',
      };

      const authenticatedRequest = {
        ...request,
        headers: { Authorization: 'Bearer test-token' },
      };

      // Mock认证管理器方法
      vi.mocked(mockAuthManager.resolveEnvironmentVariables).mockReturnValue(authConfig);
      vi.mocked(mockAuthManager.validateEnvironmentVariables).mockReturnValue({
        valid: true,
        missingVars: [],
      });
      vi.mocked(mockAuthManager.applyAuthentication).mockResolvedValue(authenticatedRequest);

      const result = await apiExecutor.applyAuthentication(request, authConfig);

      expect(mockAuthManager.resolveEnvironmentVariables).toHaveBeenCalledWith(authConfig);
      expect(mockAuthManager.validateEnvironmentVariables).toHaveBeenCalled();
      expect(mockAuthManager.applyAuthentication).toHaveBeenCalledWith(request, authConfig);
      expect(result).toEqual(authenticatedRequest);
    });

    it('应该在环境变量缺失时抛出错误', async () => {
      const request: HttpRequestConfig = {
        url: 'https://api.example.com/test',
        method: 'GET',
      };

      const authConfig: AuthConfig = {
        type: 'bearer',
        token: '{{env.MISSING_TOKEN}}',
      };

      // Mock认证管理器方法
      vi.mocked(mockAuthManager.resolveEnvironmentVariables).mockReturnValue(authConfig);
      vi.mocked(mockAuthManager.validateEnvironmentVariables).mockReturnValue({
        valid: false,
        missingVars: ['MISSING_TOKEN'],
      });

      await expect(apiExecutor.applyAuthentication(request, authConfig)).rejects.toThrow(
        '认证配置中的环境变量未定义: MISSING_TOKEN',
      );
    });

    it('oauth 配置环境变量未定义 → 抛 OAUTH_OUTBOUND_ENV_VAR_MISSING (6203)', async () => {
      const request: HttpRequestConfig = {
        url: 'https://api.example.com/test',
        method: 'GET',
      };

      // OAuth 配置：clientSecret 引用了未设置的环境变量
      const authConfig: AuthConfig = {
        type: 'oauth',
        grantType: 'client_credentials',
        clientId: 'test-client-id',
        clientSecret: '{{env.NOT_SET_VAR}}',
        tokenUrl: 'https://as.example.com/token',
      };

      // Mock：resolveEnvironmentVariables 原样返回（未定义的引用保持原样），
      // validateEnvironmentVariables 报告 NOT_SET_VAR 缺失。
      vi.mocked(mockAuthManager.resolveEnvironmentVariables).mockReturnValue(authConfig);
      vi.mocked(mockAuthManager.validateEnvironmentVariables).mockReturnValue({
        valid: false,
        missingVars: ['NOT_SET_VAR'],
      });

      await expect(apiExecutor.applyAuthentication(request, authConfig)).rejects.toMatchObject({
        name: 'ServiceError',
        code: ErrorCode.OAUTH_OUTBOUND_ENV_VAR_MISSING,
        message: 'OAuth 出站环境变量未定义: NOT_SET_VAR',
        context: {
          clientId: 'test-client-id',
          missingVars: ['NOT_SET_VAR'],
        },
      });
      // 同时确认是 ServiceError 实例（而非裸 Error）
      await expect(apiExecutor.applyAuthentication(request, authConfig)).rejects.toBeInstanceOf(
        ServiceError,
      );
    });
  });

  describe('handleTimeoutAndRetry', () => {
    it('应该成功执行HTTP请求', async () => {
      const request: HttpRequestConfig = {
        url: 'https://api.example.com/test',
        method: 'GET',
      };

      const mockResponse: HttpResponse = {
        status: 200,
        statusText: 'OK',
        headers: new Headers(),
        data: { message: 'success' },
        raw: {} as Response,
        config: request,
      };

      vi.mocked(mockHttpClient.request).mockResolvedValue(mockResponse);

      const result = await apiExecutor.handleTimeoutAndRetry(request);

      expect(mockHttpClient.request).toHaveBeenCalledWith(request);
      expect(result).toEqual(mockResponse);
    });

    it('应该在HTTP请求失败时抛出错误', async () => {
      const request: HttpRequestConfig = {
        url: 'https://api.example.com/test',
        method: 'GET',
      };

      const error = new Error('Network Error');
      vi.mocked(mockHttpClient.request).mockRejectedValue(error);

      await expect(apiExecutor.handleTimeoutAndRetry(request)).rejects.toThrow('Network Error');
    });
  });

  describe('executeApiCall', () => {
    const simpleConfig: ApiToolConfig = {
      id: 'test-api',
      name: '测试API',
      description: '测试用API',
      api: {
        url: 'https://api.example.com/test',
        method: 'GET',
      },
      parameters: {
        type: 'object',
        properties: {},
      },
      response: {},
    };

    const buildResponse = (status: number, data: unknown, statusText = ''): HttpResponse => ({
      status,
      statusText,
      headers: new Headers(),
      data,
      raw: {} as Response,
      config: {} as HttpRequestConfig,
    });

    it('应该成功执行完整的API调用流程', async () => {
      const parameters = { param1: 'value1' };

      const mockResponse: HttpResponse = {
        status: 200,
        statusText: 'OK',
        headers: new Headers(),
        data: { result: 'success' },
        raw: {} as Response,
        config: {} as HttpRequestConfig,
      };

      vi.mocked(mockHttpClient.request).mockResolvedValue(mockResponse);

      const result = await apiExecutor.executeApiCall(
        {
          ...simpleConfig,
          parameters: { type: 'object', properties: { param1: { type: 'string' } } },
        },
        parameters,
      );

      expect(result.success).toBe(true);
      expect(result.data).toEqual({ result: 'success' });
      expect(result.error).toBeUndefined();
      expect(result.raw).toEqual(mockResponse);
      expect(loggerMocks.info).toHaveBeenCalledWith('开始执行API调用: test-api');
      expect(loggerMocks.debug).toHaveBeenCalledWith(
        'HTTP请求详情: test-api GET https://api.example.com/test',
      );
      // {"result":"success"} JSON 长度为 20
      expect(loggerMocks.debug).toHaveBeenCalledWith('HTTP响应详情: test-api 200 OK (20 bytes)');
      expect(loggerMocks.info).toHaveBeenCalledWith(
        expect.stringMatching(/^API调用完成: test-api, 状态: 200, 耗时: \d+ms$/),
      );
    });

    it('关闭请求/响应日志时不应输出详情日志', async () => {
      const quietExecutor = new ApiExecutorImpl(mockHttpClient, mockAuthManager, {
        enableRequestLogging: false,
        enableResponseLogging: false,
      });
      vi.mocked(mockHttpClient.request).mockResolvedValue(buildResponse(200, { ok: true }, 'OK'));

      await quietExecutor.executeApiCall(simpleConfig, {});

      expect(loggerMocks.debug).not.toHaveBeenCalledWith(
        'HTTP请求详情: test-api GET https://api.example.com/test',
      );
      expect(loggerMocks.debug).not.toHaveBeenCalledWith(expect.stringContaining('HTTP响应详情'));
    });

    describe('状态码边界', () => {
      it.each([
        { status: 200, success: true },
        { status: 299, success: true },
        { status: 300, success: false },
      ])('状态 $status 的 success 应为 $success', async ({ status, success }) => {
        vi.mocked(mockHttpClient.request).mockResolvedValue(buildResponse(status, {}, 'Moved'));

        const result = await apiExecutor.executeApiCall(simpleConfig, {});

        expect(result.success).toBe(success);
      });

      it('3xx/4xx 以下状态不应提取错误信息', async () => {
        vi.mocked(mockHttpClient.request).mockResolvedValue(
          buildResponse(305, { error: 'ignored' }, 'Use Proxy'),
        );

        const result = await apiExecutor.executeApiCall(simpleConfig, {});

        expect(result.success).toBe(false);
        expect(result.error).toBeUndefined();
      });

      it('429 状态应提取错误信息', async () => {
        vi.mocked(mockHttpClient.request).mockResolvedValue(
          buildResponse(429, { error: 'Too Many Requests' }, 'Too Many Requests'),
        );

        const result = await apiExecutor.executeApiCall(simpleConfig, {});

        expect(result.success).toBe(false);
        expect(result.error).toBe('Too Many Requests');
      });
    });

    describe('错误信息提取', () => {
      it.each([
        { field: 'error', expected: '来自error' },
        { field: 'message', expected: '来自message' },
        { field: 'error_description', expected: '来自error_description' },
        { field: 'detail', expected: '来自detail' },
        { field: 'msg', expected: '来自msg' },
      ])('应从 $field 字段提取错误信息', async ({ field, expected }) => {
        vi.mocked(mockHttpClient.request).mockResolvedValue(
          buildResponse(500, { [field]: expected }, 'Internal Server Error'),
        );

        const result = await apiExecutor.executeApiCall(simpleConfig, {});

        expect(result.error).toBe(expected);
      });

      it('错误字段优先级应为 error > message', async () => {
        vi.mocked(mockHttpClient.request).mockResolvedValue(
          buildResponse(500, { error: '一级', message: '二级' }, 'Internal Server Error'),
        );

        const result = await apiExecutor.executeApiCall(simpleConfig, {});

        expect(result.error).toBe('一级');
      });

      it('非字符串错误字段应被跳过', async () => {
        vi.mocked(mockHttpClient.request).mockResolvedValue(
          buildResponse(500, { error: { message: '嵌套' } }, 'Internal Server Error'),
        );

        const result = await apiExecutor.executeApiCall(simpleConfig, {});

        expect(result.error).toBe('Internal Server Error');
      });

      it('无匹配字段时应回退到状态文本', async () => {
        vi.mocked(mockHttpClient.request).mockResolvedValue(
          buildResponse(502, { unexpected: 'shape' }, 'Bad Gateway'),
        );

        const result = await apiExecutor.executeApiCall(simpleConfig, {});

        expect(result.error).toBe('Bad Gateway');
      });

      it('无状态文本时应回退到 HTTP 状态码', async () => {
        vi.mocked(mockHttpClient.request).mockResolvedValue(buildResponse(503, {}, ''));

        const result = await apiExecutor.executeApiCall(simpleConfig, {});

        expect(result.error).toBe('HTTP 503');
      });

      it('非对象响应数据应回退到状态文本', async () => {
        vi.mocked(mockHttpClient.request).mockResolvedValue(
          buildResponse(500, 'plain', 'Server Error'),
        );

        const result = await apiExecutor.executeApiCall(simpleConfig, {});

        expect(result.error).toBe('Server Error');
      });
    });

    describe('响应大小计算', () => {
      it('字符串数据的字节数应为字符串长度', async () => {
        vi.mocked(mockHttpClient.request).mockResolvedValue(buildResponse(200, '0123456789', 'OK'));

        await apiExecutor.executeApiCall(simpleConfig, {});

        expect(loggerMocks.debug).toHaveBeenCalledWith('HTTP响应详情: test-api 200 OK (10 bytes)');
      });

      it('null 数据的大小应为 0', async () => {
        vi.mocked(mockHttpClient.request).mockResolvedValue(buildResponse(200, null, 'OK'));

        await apiExecutor.executeApiCall(simpleConfig, {});

        expect(loggerMocks.debug).toHaveBeenCalledWith('HTTP响应详情: test-api 200 OK (0 bytes)');
      });

      it('循环引用对象的大小应为 0', async () => {
        const circular: Record<string, unknown> = {};
        circular.self = circular;
        vi.mocked(mockHttpClient.request).mockResolvedValue(buildResponse(200, circular, 'OK'));

        await apiExecutor.executeApiCall(simpleConfig, {});

        expect(loggerMocks.debug).toHaveBeenCalledWith('HTTP响应详情: test-api 200 OK (0 bytes)');
      });

      it('数值数据的字节数应为字符串化长度', async () => {
        vi.mocked(mockHttpClient.request).mockResolvedValue(buildResponse(200, 12345, 'OK'));

        await apiExecutor.executeApiCall(simpleConfig, {});

        expect(loggerMocks.debug).toHaveBeenCalledWith('HTTP响应详情: test-api 200 OK (5 bytes)');
      });
    });

    it('应该处理参数验证失败', async () => {
      const apiConfig: ApiToolConfig = {
        id: 'test-api',
        name: '测试API',
        description: '测试用API',
        api: {
          url: 'https://api.example.com/test',
          method: 'GET',
        },
        parameters: {
          type: 'object',
          properties: {
            required_param: { type: 'string' },
          },
          required: ['required_param'],
        },
        response: {},
      };

      const parameters = {}; // 缺少必需参数

      // 创建一个新的执行器实例，并mock参数验证器返回失败
      const mockValidatorInstance = {
        validate: vi.fn().mockReturnValue({
          valid: false,
          errors: ['required_param is required'],
        }),
      };

      // 创建新的执行器实例
      const _MockParameterValidatorImpl = vi.fn().mockImplementation(() => mockValidatorInstance);

      // 临时替换构造函数中使用的验证器
      const originalValidator = (apiExecutor as unknown as { parameterValidator: unknown })
        .parameterValidator;
      (apiExecutor as unknown as { parameterValidator: unknown }).parameterValidator =
        mockValidatorInstance;

      const result = await apiExecutor.executeApiCall(apiConfig, parameters);

      // 恢复原始验证器
      (apiExecutor as unknown as { parameterValidator: unknown }).parameterValidator =
        originalValidator;

      expect(result.success).toBe(false);
      expect(result.error).toContain('参数验证失败');
    });

    it('应该处理HTTP错误响应', async () => {
      const apiConfig: ApiToolConfig = {
        id: 'test-api',
        name: '测试API',
        description: '测试用API',
        api: {
          url: 'https://api.example.com/test',
          method: 'GET',
        },
        parameters: {
          type: 'object',
          properties: {},
        },
        response: {},
      };

      const mockResponse: HttpResponse = {
        status: 404,
        statusText: 'Not Found',
        headers: new Headers(),
        data: { error: 'Resource not found' },
        raw: {} as Response,
        config: {} as HttpRequestConfig,
      };

      vi.mocked(mockHttpClient.request).mockResolvedValue(mockResponse);

      const result = await apiExecutor.executeApiCall(apiConfig, {});

      expect(result.success).toBe(false);
      expect(result.error).toBe('Resource not found');
      expect(result.raw).toEqual(mockResponse);
    });

    it('应该处理带认证的API调用', async () => {
      const apiConfig: ApiToolConfig = {
        id: 'test-api',
        name: '测试API',
        description: '测试用API',
        api: {
          url: 'https://api.example.com/test',
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
            token: 'test-token',
          },
        },
      };

      const mockResponse: HttpResponse = {
        status: 200,
        statusText: 'OK',
        headers: new Headers(),
        data: { result: 'authenticated success' },
        raw: {} as Response,
        config: {} as HttpRequestConfig,
      };

      // Mock认证相关方法
      vi.mocked(mockAuthManager.resolveEnvironmentVariables).mockReturnValue(
        apiConfig.security?.authentication ?? { type: 'bearer', token: 'test' },
      );
      vi.mocked(mockAuthManager.validateEnvironmentVariables).mockReturnValue({
        valid: true,
        missingVars: [],
      });
      vi.mocked(mockAuthManager.applyAuthentication).mockImplementation(async (req) => ({
        ...req,
        headers: { ...req.headers, Authorization: 'Bearer test-token' },
      }));

      vi.mocked(mockHttpClient.request).mockResolvedValue(mockResponse);

      const result = await apiExecutor.executeApiCall(apiConfig, {});

      expect(result.success).toBe(true);
      expect(result.data).toEqual({ result: 'authenticated success' });
      expect(mockAuthManager.applyAuthentication).toHaveBeenCalled();
    });

    it('应该处理网络错误', async () => {
      const apiConfig: ApiToolConfig = {
        id: 'test-api',
        name: '测试API',
        description: '测试用API',
        api: {
          url: 'https://api.example.com/test',
          method: 'GET',
        },
        parameters: {
          type: 'object',
          properties: {},
        },
        response: {},
      };

      const networkError = new Error('Network timeout');
      vi.mocked(mockHttpClient.request).mockRejectedValue(networkError);

      const result = await apiExecutor.executeApiCall(apiConfig, {});

      expect(result.success).toBe(false);
      expect(result.error).toBe('Network timeout');
      expect(result.data).toBeNull();
    });
  });

  describe('工厂函数', () => {
    it('应该通过工厂函数创建API执行器', () => {
      const executor = createApiExecutor(mockHttpClient, mockAuthManager);
      expect(executor).toBeInstanceOf(ApiExecutorImpl);
    });

    it('应该通过工厂函数创建带配置的API执行器', () => {
      const config = { defaultTimeout: 10000 };
      const executor = createApiExecutor(mockHttpClient, mockAuthManager, config);
      expect(executor).toBeInstanceOf(ApiExecutorImpl);
    });
  });

  describe('executor 边界：内部 throw 不逃逸到调用方', () => {
    // 这些测试证明：当 executor 内部抛出 ServiceError（重构后的裸 Error→ServiceError）时，
    // executeApiCall 的 catch-all 边界会把它转成 { success:false, error:<string> }，
    // 绝不把 ServiceError 对象（含内部错误码/code/category 等）抛给调用方，
    // 否则会把内部错误码结构泄露给 MCP 客户端。

    const baseConfig: ApiToolConfig = {
      id: 'boundary-api',
      name: '边界测试API',
      description: '验证内部错误不逃逸',
      api: {
        url: 'https://api.example.com/test',
        method: 'GET',
      },
      parameters: {
        type: 'object',
        properties: {},
      },
      response: {},
    };

    it('参数验证失败抛 ServiceError(BUILD_FAILED) → 被 catch 转成 {success:false}，不抛出', async () => {
      // 触发 L119 路径：parameterValidator.validate 返回 invalid
      const failingValidator = {
        validate: vi.fn().mockReturnValue({
          valid: false,
          errors: ['required_param is required'],
        }),
      };
      const originalValidator = (apiExecutor as unknown as { parameterValidator: unknown })
        .parameterValidator;
      (apiExecutor as unknown as { parameterValidator: unknown }).parameterValidator =
        failingValidator;

      const result = await apiExecutor.executeApiCall(baseConfig, {});

      // 恢复原始验证器，避免污染后续测试
      (apiExecutor as unknown as { parameterValidator: unknown }).parameterValidator =
        originalValidator;

      // 核心：不 throw，返回 success:false
      expect(result.success).toBe(false);
      expect(typeof result.error).toBe('string');
      expect(result.error).toContain('参数验证失败');
      // 错误是扁平 string，不是 ServiceError 对象——内部错误码未逃逸
      expect(result.error).not.toHaveProperty('code');
      expect(result.error).not.toBeInstanceOf(ServiceError);
    });

    it('buildHttpRequest 失败抛 ServiceError(BUILD_FAILED) → 被 catch 转成 {success:false}，不抛出', async () => {
      // 触发 L190 路径：requestBuilder.buildRequest 返回 success:false
      const originalBuild = mockBuildRequest.getMockImplementation();
      mockBuildRequest.mockImplementation(() => ({
        success: false,
        error: '无效的 URL 模板',
        usedVariables: [],
      }));

      const result = await apiExecutor.executeApiCall(baseConfig, {});

      // 恢复原始 buildRequest 实现
      mockBuildRequest.mockImplementation(originalBuild);

      expect(result.success).toBe(false);
      expect(typeof result.error).toBe('string');
      expect(result.error).toContain('构建HTTP请求失败');
      expect(result.error).not.toBeInstanceOf(ServiceError);
    });

    it('认证环境变量缺失抛 ServiceError(CONFIG_ERROR) → 被 catch 转成 {success:false}，不抛出', async () => {
      // 触发 L238 路径（bearer 类型，端到端走 executeApiCall→applyAuthentication→throw→catch）
      const configWithAuth: ApiToolConfig = {
        ...baseConfig,
        security: {
          authentication: {
            type: 'bearer',
            token: '{{env.MISSING_TOKEN}}',
          },
        },
      };

      vi.mocked(mockAuthManager.resolveEnvironmentVariables).mockReturnValue(
        configWithAuth.security!.authentication!,
      );
      vi.mocked(mockAuthManager.validateEnvironmentVariables).mockReturnValue({
        valid: false,
        missingVars: ['MISSING_TOKEN'],
      });

      const result = await apiExecutor.executeApiCall(configWithAuth, {});

      // 核心：applyAuthentication 内部抛了 ServiceError(CONFIG_ERROR)，
      // 但 executeApiCall 的 catch-all 把它降级成 {success:false, error:string}，不抛出
      expect(result.success).toBe(false);
      expect(typeof result.error).toBe('string');
      expect(result.error).toBe('认证配置中的环境变量未定义: MISSING_TOKEN');
      // 断言错误是 string 而非结构化 ServiceError：内部 code/category/context 未泄露
      expect(result.error).not.toBeInstanceOf(ServiceError);
      expect(result.data).toBeNull();
    });
  });
});
