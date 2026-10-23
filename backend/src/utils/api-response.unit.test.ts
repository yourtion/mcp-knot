/**
 * 统一 API 响应工具测试
 * 验证成功/错误响应体结构与 HTTP 状态码推导规则
 */
import { ErrorCode, McpKnotCoreError } from '@mcp-core/mcp-knot-core';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { errorResponse, successResponse } from './api-response.js';
import { logger } from './logger.js';

vi.mock('./logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

function buildApp() {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('requestId', 'req-test-123');
    await next();
  });
  return app;
}

describe('successResponse', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('返回带 requestId 与时间戳的成功响应体，默认 200', async () => {
    const app = buildApp();
    app.get('/ok', (c) => successResponse(c, { items: [1, 2] }));

    const res = await app.request('/ok');
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data).toEqual({ items: [1, 2] });
    expect(body.requestId).toBe('req-test-123');
    expect(typeof body.timestamp).toBe('string');
    expect(new Date(body.timestamp).toString()).not.toBe('Invalid Date');
  });

  it('支持自定义状态码', async () => {
    const app = buildApp();
    app.post('/created', (c) => successResponse(c, { id: 1 }, 201));

    const res = await app.request('/created', { method: 'POST' });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.success).toBe(true);
  });
});

describe('errorResponse', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('普通错误默认映射为 500，响应体包含 requestId 与错误详情', async () => {
    const app = buildApp();
    const error = new Error('服务器内部错误');
    app.get('/boom', (c) => errorResponse(c, error));

    const res = await app.request('/boom');
    expect(res.status).toBe(500);

    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.requestId).toBe('req-test-123');
    expect(body.error.message).toBe('服务器内部错误');
    expect(body.error.code).toBe(ErrorCode.UNKNOWN_ERROR);
  });

  it('结构化错误按 ErrorCode 映射 HTTP 状态码', async () => {
    const app = buildApp();
    const error = new McpKnotCoreError(ErrorCode.AUTH_INVALID_CREDENTIALS, '用户名或密码错误');
    app.get('/unauthorized', (c) => errorResponse(c, error));

    const res = await app.request('/unauthorized');
    expect(res.status).toBe(401);

    const body = await res.json();
    expect(body.error.code).toBe(ErrorCode.AUTH_INVALID_CREDENTIALS);
    expect(body.error.message).toBe('用户名或密码错误');
  });

  it('验证类结构化错误映射为 400', async () => {
    const app = buildApp();
    const error = new McpKnotCoreError(ErrorCode.INVALID_PARAMETER_VALUE, '参数非法');
    app.get('/bad-request', (c) => errorResponse(c, error));

    const res = await app.request('/bad-request');
    expect(res.status).toBe(400);
  });

  it('显式指定 status 时优先于错误码推导', async () => {
    const app = buildApp();
    const error = new McpKnotCoreError(ErrorCode.AUTH_INVALID_CREDENTIALS, '本应 401');
    app.get('/override', (c) => errorResponse(c, error, 503));

    const res = await app.request('/override');
    expect(res.status).toBe(503);
  });

  it('普通错误指定 status 时使用指定值', async () => {
    const app = buildApp();
    app.get('/teapot', (c) => errorResponse(c, new Error('x'), 418));

    const res = await app.request('/teapot');
    expect(res.status).toBe(418);
  });

  it('记录错误日志（含 requestId、路径与方法）', async () => {
    const app = buildApp();
    const error = new Error('日志断言');
    app.get('/logged', (c) => errorResponse(c, error));

    await app.request('/logged', { method: 'GET' });

    expect(logger.error).toHaveBeenCalledWith('API error', error, {
      requestId: 'req-test-123',
      path: '/logged',
      method: 'GET',
    });
  });
});
