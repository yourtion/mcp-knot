/**
 * 响应处理器测试
 */

import { describe, expect, it } from 'vitest';

import { HttpError, McpError, McpErrorCode, ResponseProcessorImpl } from './response-processor.js';

import type { HttpResponse } from '../types/http-client.js';

/** 非JSON文本响应结果 */
interface TextResponseResult {
  _type: string;
  content: string;
}

/** CSV响应结果 */
interface CsvResponseResult {
  _type: string;
  rows: string[][];
}

/** 键值对响应结果 */
interface KeyValueResponseResult {
  _type: string;
  parsed: Record<string, string>;
}

/** 降级响应结果 */
interface FallbackResponseResult {
  _fallback: boolean;
  _data: unknown;
  _originalError: string;
}

describe('ResponseProcessorImpl', () => {
  const processor = new ResponseProcessorImpl();

  describe('validateJsonataExpression', () => {
    it('应该验证有效的JSONata表达式', () => {
      const result = processor.validateJsonataExpression('$.name');
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('应该验证复杂的JSONata表达式', () => {
      const result = processor.validateJsonataExpression(
        '{ "name": $.user.name, "count": $count($.items) }',
      );
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('应该拒绝无效的JSONata表达式', () => {
      const result = processor.validateJsonataExpression('$.invalid[');
      expect(result.valid).toBe(false);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].code).toBe('INVALID_JSONATA_SYNTAX');
    });

    it('应该拒绝空表达式', () => {
      const result = processor.validateJsonataExpression('');
      expect(result.valid).toBe(false);
      expect(result.errors[0].code).toBe('EMPTY_JSONATA_EXPRESSION');
    });
  });

  describe('processWithJsonata', () => {
    it('应该使用JSONata处理简单数据', async () => {
      const data = { name: 'John', age: 30 };
      const result = await processor.processWithJsonata(data, 'name');
      expect(result).toBe('John');
    });

    it('应该使用JSONata处理复杂数据转换', async () => {
      const data = {
        users: [
          { name: 'John', age: 30 },
          { name: 'Jane', age: 25 },
        ],
      };
      const result = (await processor.processWithJsonata(
        data,
        '{ "names": users.name, "total": $count(users) }',
      )) as Record<string, unknown>;

      expect(result).toHaveProperty('names');
      expect(result).toHaveProperty('total');
      expect(Array.from(result.names as Iterable<unknown>)).toEqual(['John', 'Jane']);
      expect(result.total).toBe(2);
    });

    it('应该处理数组聚合', async () => {
      const data = {
        items: [
          { price: 10, quantity: 2 },
          { price: 20, quantity: 1 },
        ],
      };
      const result = await processor.processWithJsonata(data, '$sum(items.(price * quantity))');
      expect(result).toBe(40);
    });

    it('应该处理JSONata执行错误', async () => {
      const data = { name: 'John' };
      await expect(processor.processWithJsonata(data, 'invalid[')).rejects.toThrow();
    });

    it('无效表达式应抛出包含验证详情的错误', async () => {
      await expect(processor.processWithJsonata({}, 'invalid[')).rejects.toThrow(
        /JSONata表达式无效: .+/,
      );
    });

    it('应该使用安全模式处理JSONata执行错误', async () => {
      const data = { name: 'John' };
      const result = await processor.processWithJsonataSafe(data, 'invalid[');

      expect(result).toHaveProperty('_original', data);
      expect(result).toHaveProperty('_error');
      expect(result).toHaveProperty('_jsonataExpression', 'invalid[');
    });

    it('应该处理空数据', async () => {
      const result = await processor.processWithJsonata(null, 'name');
      expect(result).toBeUndefined();
    });
  });

  describe('processErrorResponse', () => {
    const createMockResponse = (
      status: number,
      statusText: string,
      data?: unknown,
    ): HttpResponse => ({
      status,
      statusText,
      headers: new Headers(),
      data,
      raw: {} as Response,
      config: {
        url: 'http://example.com',
        method: 'GET',
      },
    });

    it('应该处理基本的HTTP错误', () => {
      const response = createMockResponse(404, 'Not Found');
      const error = processor.processErrorResponse(response);

      expect(error.message).toBe('API调用失败: 404 Not Found');
      expect((error as HttpError).status).toBe(404);
      expect((error as HttpError).statusText).toBe('Not Found');
    });

    it('应该使用错误路径提取错误信息', () => {
      const response = createMockResponse(400, 'Bad Request', {
        error: { message: '参数无效' },
      });
      const error = processor.processErrorResponse(response, 'error.message');

      expect(error.message).toBe('参数无效');
    });

    it('应该从常见错误字段提取错误信息', () => {
      const response = createMockResponse(500, 'Internal Server Error', {
        error: '服务器内部错误',
      });
      const error = processor.processErrorResponse(response);

      expect(error.message).toBe('服务器内部错误');
    });

    it('应该处理多种错误字段格式', () => {
      const testCases = [
        { field: 'message', value: '消息错误' },
        { field: 'msg', value: 'msg错误' },
        { field: 'detail', value: '详细错误' },
        { field: 'description', value: '描述错误' },
      ];

      for (const testCase of testCases) {
        const response = createMockResponse(400, 'Bad Request', {
          [testCase.field]: testCase.value,
        });
        const error = processor.processErrorResponse(response);
        expect(error.message).toBe(testCase.value);
      }
    });

    it('应该处理无效的错误路径', () => {
      const response = createMockResponse(400, 'Bad Request', {
        error: '错误信息',
      });
      const error = processor.processErrorResponse(response, 'invalid[');

      // 应该回退到从常见字段提取错误信息
      expect(error.message).toBe('错误信息');
    });

    it('错误路径中间段不存在时应回退到常见字段提取', () => {
      const response = createMockResponse(400, 'Bad Request', {
        error: '回退信息',
      });
      const error = processor.processErrorResponse(response, 'missing.path.segment');

      expect(error.message).toBe('回退信息');
      expect((error as HttpError).mcpData).toHaveProperty('extractedData', '回退信息');
    });

    it('错误路径解析结果非字符串时应回退到常见字段提取消息', () => {
      const response = createMockResponse(400, 'Bad Request', {
        error: { code: 42, message: '来自message' },
      });
      const error = processor.processErrorResponse(response, 'error.code');

      // 路径提取到数字 42：不能作为消息，回退到常见字段并覆盖提取值
      expect(error.message).toBe('来自message');
      expect((error as HttpError).mcpData).toHaveProperty('extractedData', '来自message');
    });

    it('单段错误路径应直接提取顶级字段', () => {
      const response = createMockResponse(400, 'Bad Request', {
        message: '顶级消息',
      });
      const error = processor.processErrorResponse(response, 'message');

      expect(error.message).toBe('顶级消息');
    });

    it('嵌套对象子字段应按优先级顺序提取', () => {
      // msg 优先于 description
      const first = createMockResponse(400, 'Bad Request', {
        error: { msg: '来自msg', description: '来自description' },
      });
      expect(processor.processErrorResponse(first).message).toBe('来自msg');

      // description 优先于 detail
      const second = createMockResponse(400, 'Bad Request', {
        error: { description: '来自description', detail: '来自detail' },
      });
      expect(processor.processErrorResponse(second).message).toBe('来自description');
    });

    it('常见字段应按 error/message/msg/detail/description 优先级提取', () => {
      const response = createMockResponse(400, 'Bad Request', {
        error: '错误字段',
        message: '消息字段',
      });
      const error = processor.processErrorResponse(response);

      expect(error.message).toBe('错误字段');
    });

    it('未提取到字符串错误时应将整个数据对象作为 extractedData', () => {
      const response = createMockResponse(400, 'Bad Request', {
        error: 12345,
      });
      const error = processor.processErrorResponse(response);

      expect(error.message).toBe('API调用失败: 400 Bad Request');
      expect((error as HttpError).mcpData).toHaveProperty('extractedData', { error: 12345 });
    });

    it('HttpError 应携带状态、MCP错误码与原始响应', () => {
      const response = createMockResponse(404, 'Not Found', { error: '不存在' });
      const error = processor.processErrorResponse(response) as HttpError;

      expect(error.name).toBe('HttpError');
      expect(error.status).toBe(404);
      expect(error.statusText).toBe('Not Found');
      expect(error.mcpCode).toBe(McpErrorCode.API_NOT_FOUND);
      expect(error.response).toBe(response);
      expect(error.mcpData).toEqual({
        httpStatus: 404,
        httpStatusText: 'Not Found',
        originalData: { error: '不存在' },
        extractedData: '不存在',
      });
    });
  });

  describe('processResponse', () => {
    const createMockResponse = (status: number, data: unknown): HttpResponse => ({
      status,
      statusText: 'OK',
      headers: new Headers(),
      data,
      raw: {} as Response,
      config: {
        url: 'http://example.com',
        method: 'GET',
      },
    });

    it('应该处理成功的JSON响应', async () => {
      const response = createMockResponse(200, { name: 'John', age: 30 });
      const result = await processor.processResponse(response);

      expect(result).toEqual({ name: 'John', age: 30 });
    });

    it('应该处理成功的JSON响应并应用JSONata', async () => {
      const response = createMockResponse(200, { name: 'John', age: 30 });
      const result = await processor.processResponse(response, '$.name');

      expect(result).toBe('John');
    });

    it('应该处理字符串响应', async () => {
      const response = createMockResponse(200, 'Hello World');
      const result = (await processor.processResponse(response)) as TextResponseResult;

      expect(result._type).toBe('text');
      expect(result.content).toBe('Hello World');
    });

    it('应该处理JSON字符串响应', async () => {
      const response = createMockResponse(200, '{"name": "John", "age": 30}');
      const result = await processor.processResponse(response);

      expect(result).toEqual({ name: 'John', age: 30 });
    });

    it('应该处理JSON字符串响应并应用JSONata', async () => {
      const response = createMockResponse(200, '{"name": "John", "age": 30}');
      const result = await processor.processResponse(response, 'name');

      expect(result).toBe('John');
    });

    it('应该抛出错误响应异常', async () => {
      const response: HttpResponse = {
        status: 404,
        statusText: 'Not Found',
        headers: new Headers(),
        data: { error: '资源未找到' },
        raw: {} as Response,
        config: {
          url: 'http://example.com',
          method: 'GET',
        },
      };

      await expect(processor.processResponse(response)).rejects.toThrow('资源未找到');
    });

    it('应该处理无效的JSON字符串', async () => {
      const response = createMockResponse(200, 'invalid json {');
      const result = (await processor.processResponse(response)) as TextResponseResult;

      expect(result._type).toBe('text');
      expect(result.content).toBe('invalid json {');
    });

    it('应该处理XML响应', async () => {
      const response = createMockResponse(200, '<root><name>John</name></root>');
      const result = (await processor.processResponse(response)) as TextResponseResult;

      expect(result._type).toBe('xml');
      expect(result.content).toBe('<root><name>John</name></root>');
    });

    it('应该处理CSV响应', async () => {
      const csvData = 'name,age\nJohn,30\nJane,25';
      const response = createMockResponse(200, csvData);
      const result = (await processor.processResponse(response)) as CsvResponseResult;

      expect(result._type).toBe('csv');
      expect(result.rows).toEqual([
        ['name', 'age'],
        ['John', '30'],
        ['Jane', '25'],
      ]);
    });

    it('应该处理键值对响应', async () => {
      const kvData = 'name=John\nage=30\ncity:Beijing';
      const response = createMockResponse(200, kvData);
      const result = (await processor.processResponse(response)) as KeyValueResponseResult;

      expect(result._type).toBe('key-value');
      expect(result.parsed).toEqual({
        name: 'John',
        age: '30',
        city: 'Beijing',
      });
    });

    it('应该处理纯文本响应', async () => {
      const response = createMockResponse(200, 'Hello World');
      const result = (await processor.processResponse(response)) as TextResponseResult;

      expect(result._type).toBe('text');
      expect(result.content).toBe('Hello World');
    });

    it('应该处理 Buffer 响应数据', async () => {
      const response = createMockResponse(200, Buffer.from('{"name":"BufferGuy"}'));
      const result = await processor.processResponse(response);

      expect(result).toEqual({ name: 'BufferGuy' });
    });

    it('应该处理 ArrayBuffer 响应数据', async () => {
      const buffer = new TextEncoder().encode('{"name":"ArrayBufferGuy"}');
      const response = createMockResponse(200, buffer.buffer);
      const result = await processor.processResponse(response);

      expect(result).toEqual({ name: 'ArrayBufferGuy' });
    });

    it('单行带逗号文本不应识别为CSV', async () => {
      const response = createMockResponse(200, 'name,age');
      const result = (await processor.processResponse(response)) as TextResponseResult;

      expect(result._type).toBe('text');
    });

    it('逗号数量不一致的多行文本不应识别为CSV', async () => {
      const response = createMockResponse(200, 'a,b,c\n1,2');
      const result = (await processor.processResponse(response)) as TextResponseResult;

      expect(result._type).toBe('text');
      expect(result.content).toBe('a,b,c\n1,2');
    });

    it('分隔符行占比恰好为一半时不应识别为键值对', async () => {
      // 2 行中只有 1 行含 '='，比例 0.5 不大于 0.5
      const response = createMockResponse(200, 'key=value\n普通文本行');
      const result = (await processor.processResponse(response)) as TextResponseResult;

      expect(result._type).toBe('text');
    });

    it('键值对中包含分隔符的值应完整保留', async () => {
      const response = createMockResponse(200, 'url=http://example.com?a=1');
      const result = (await processor.processResponse(response)) as KeyValueResponseResult;

      expect(result._type).toBe('key-value');
      expect(result.parsed).toEqual({ url: 'http://example.com?a=1' });
    });

    it('无分隔符的行应在键值对解析中被忽略', async () => {
      const response = createMockResponse(200, 'a=1\n无分隔符行\nb:2');
      const result = (await processor.processResponse(response)) as KeyValueResponseResult;

      expect(result._type).toBe('key-value');
      expect(result.parsed).toEqual({ a: '1', b: '2' });
      expect(result.content).toBe('a=1\n无分隔符行\nb:2');
    });
  });

  describe('processWithFallback', () => {
    const createMockResponse = (status: number, data: unknown): HttpResponse => ({
      status,
      statusText: 'OK',
      headers: new Headers(),
      data,
      raw: {} as Response,
      config: {
        url: 'http://example.com',
        method: 'GET',
      },
    });

    it('应该使用主要表达式处理成功响应', async () => {
      const response = createMockResponse(200, { name: 'John', age: 30 });
      const result = await processor.processWithFallback(response, 'name', 'age');

      expect(result).toBe('John');
    });

    it('应该在主要表达式失败时使用降级表达式', async () => {
      const response = createMockResponse(200, { name: 'John', age: 30 });
      const result = await processor.processWithFallback(
        response,
        'invalid[', // 无效表达式
        'name', // 降级表达式
      );

      expect(result).toBe('John');
    });

    it('应该在所有表达式失败时返回降级数据', async () => {
      const response = createMockResponse(200, { name: 'John', age: 30 });
      const result = (await processor.processWithFallback(
        response,
        'invalid[', // 无效表达式
        'alsoinvalid[', // 无效降级表达式
      )) as FallbackResponseResult;

      expect(result._fallback).toBe(true);
      expect(result._data).toEqual({ name: 'John', age: 30 });
      expect(result._originalError).toBeDefined();
    });

    it('应该处理没有降级表达式的情况', async () => {
      const response = createMockResponse(200, { name: 'John', age: 30 });
      const result = (await processor.processWithFallback(
        response,
        'invalid[', // 无效表达式
      )) as FallbackResponseResult;

      expect(result._fallback).toBe(true);
      expect(result._data).toEqual({ name: 'John', age: 30 });
    });

    it('没有主要表达式时应直接处理响应', async () => {
      const response = createMockResponse(200, { name: 'John', age: 30 });
      const result = await processor.processWithFallback(response);

      expect(result).toEqual({ name: 'John', age: 30 });
    });

    it('主要表达式与降级表达式都因HTTP错误失败时应返回降级数据', async () => {
      const response = createMockResponse(500, { error: '服务器错误' });
      const result = (await processor.processWithFallback(
        response,
        'name',
        'age',
      )) as FallbackResponseResult;

      expect(result._fallback).toBe(true);
      expect(result._data).toEqual({ error: '服务器错误' });
      expect(result._originalError).toContain('服务器错误');
    });
  });

  describe('McpError', () => {
    it('应该正确创建MCP错误', () => {
      const error = new McpError(McpErrorCode.API_REQUEST_FAILED, '测试错误', {
        test: 'data',
      });

      expect(error.name).toBe('McpError');
      expect(error.code).toBe(McpErrorCode.API_REQUEST_FAILED);
      expect(error.message).toBe('测试错误');
      expect(error.data).toEqual({ test: 'data' });
    });

    it('应该转换为MCP错误响应格式', () => {
      const error = new McpError(McpErrorCode.API_REQUEST_FAILED, '测试错误', {
        test: 'data',
      });

      const response = error.toMcpErrorResponse();
      expect(response).toEqual({
        error: {
          code: McpErrorCode.API_REQUEST_FAILED,
          message: '测试错误',
          data: { test: 'data' },
        },
      });
    });

    it('应该从HTTP状态码创建MCP错误', () => {
      const testCases = [
        { status: 400, expectedCode: McpErrorCode.INVALID_PARAMS },
        { status: 401, expectedCode: McpErrorCode.API_AUTHENTICATION_FAILED },
        { status: 403, expectedCode: McpErrorCode.API_FORBIDDEN },
        { status: 404, expectedCode: McpErrorCode.API_NOT_FOUND },
        { status: 429, expectedCode: McpErrorCode.API_RATE_LIMITED },
        { status: 500, expectedCode: McpErrorCode.API_SERVER_ERROR },
        { status: 418, expectedCode: McpErrorCode.API_REQUEST_FAILED }, // 其他4xx错误
      ];

      for (const testCase of testCases) {
        const error = McpError.fromHttpStatus(testCase.status, '自定义消息');
        expect(error.code).toBe(testCase.expectedCode);
        expect(error.message).toBe('自定义消息');
      }
    });

    it('应该使用默认消息创建MCP错误', () => {
      const error = McpError.fromHttpStatus(404);
      expect(error.code).toBe(McpErrorCode.API_NOT_FOUND);
      expect(error.message).toBe('API端点未找到');
    });

    it('非4xx/5xx状态应使用通用请求失败错误', () => {
      const redirected = McpError.fromHttpStatus(302);
      expect(redirected.code).toBe(McpErrorCode.API_REQUEST_FAILED);
      expect(redirected.message).toBe('API请求失败');

      const serverError = McpError.fromHttpStatus(502);
      expect(serverError.code).toBe(McpErrorCode.API_SERVER_ERROR);
      expect(serverError.message).toBe('API服务器错误');
    });

    it('fromHttpStatus 应透传附加数据', () => {
      const data = { requestId: 'req-1' };
      const error = McpError.fromHttpStatus(400, undefined, data);

      expect(error.message).toBe('请求参数无效');
      expect(error.data).toEqual({ requestId: 'req-1' });
    });
  });

  describe('processErrorResponseAsMcp', () => {
    const createMockResponse = (
      status: number,
      statusText: string,
      data?: unknown,
    ): HttpResponse => ({
      status,
      statusText,
      headers: new Headers(),
      data,
      raw: {} as Response,
      config: {
        url: 'http://example.com',
        method: 'GET',
      },
    });

    it('应该创建基本的MCP错误', () => {
      const response = createMockResponse(404, 'Not Found');
      const error = processor.processErrorResponseAsMcp(response);

      expect(error).toBeInstanceOf(McpError);
      expect(error.code).toBe(McpErrorCode.API_NOT_FOUND);
      expect(error.message).toBe('API调用失败: 404 Not Found');
      expect(error.data).toHaveProperty('httpStatus', 404);
      expect(error.data).toHaveProperty('httpStatusText', 'Not Found');
    });

    it('应该使用错误路径提取错误信息', () => {
      const response = createMockResponse(400, 'Bad Request', {
        error: { message: '参数无效' },
      });
      const error = processor.processErrorResponseAsMcp(response, 'error.message');

      expect(error.code).toBe(McpErrorCode.INVALID_PARAMS);
      expect(error.message).toBe('参数无效');
      expect(error.data).toHaveProperty('extractedData', '参数无效');
    });

    it('应该从常见错误字段提取错误信息', () => {
      const response = createMockResponse(500, 'Internal Server Error', {
        error: '服务器内部错误',
      });
      const error = processor.processErrorResponseAsMcp(response);

      expect(error.code).toBe(McpErrorCode.API_SERVER_ERROR);
      expect(error.message).toBe('服务器内部错误');
    });

    it('应该处理复杂的错误数据结构', () => {
      const errorData = {
        error: {
          code: 'VALIDATION_FAILED',
          message: '验证失败',
          details: ['字段A必填', '字段B格式错误'],
        },
      };
      const response = createMockResponse(400, 'Bad Request', errorData);
      const error = processor.processErrorResponseAsMcp(response);

      expect(error.code).toBe(McpErrorCode.INVALID_PARAMS);
      expect(error.message).toBe('验证失败');
      expect(error.data).toHaveProperty('originalData', errorData);
    });
  });

  describe('processResponse with MCP errors', () => {
    const createMockResponse = (status: number, data: unknown): HttpResponse => ({
      status,
      statusText: status >= 400 ? 'Error' : 'OK',
      headers: new Headers(),
      data,
      raw: {} as Response,
      config: {
        url: 'http://example.com',
        method: 'GET',
      },
    });

    it('应该抛出MCP错误而不是普通错误', async () => {
      const response = createMockResponse(404, { error: '资源未找到' });

      try {
        await processor.processResponse(response);
        expect.fail('应该抛出错误');
      } catch (error) {
        expect(error).toBeInstanceOf(McpError);
        expect((error as McpError).code).toBe(McpErrorCode.API_NOT_FOUND);
      }
    });

    it('应该将JSONata处理错误转换为MCP错误', async () => {
      const response = createMockResponse(200, { name: 'John' });

      try {
        await processor.processResponse(response, 'invalid[');
        expect.fail('应该抛出错误');
      } catch (error) {
        expect(error).toBeInstanceOf(McpError);
        expect((error as McpError).code).toBe(McpErrorCode.JSONATA_EXECUTION_ERROR);
        expect((error as McpError).data).toHaveProperty('jsonataExpression', 'invalid[');
      }
    });
  });
});
