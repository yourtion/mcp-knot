/**
 * Request ID 中间件测试
 * 验证请求 ID 生成、透传与响应头注入
 */
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';

import { requestIdMiddleware } from './request-id.js';

function buildApp() {
  const app = new Hono();
  app.use('*', requestIdMiddleware);
  app.get('/probe', (c) => c.json({ requestId: c.get('requestId') }));
  return app;
}

describe('requestIdMiddleware', () => {
  it('无入站头时生成 req_ 前缀的唯一 ID 并注入上下文与响应头', async () => {
    const app = buildApp();

    const res = await app.request('/probe');
    const headerId = res.headers.get('X-Request-ID');
    const body = await res.json();

    expect(headerId).toMatch(/^req_[a-z0-9]+_[a-z0-9]{6}$/);
    // 上下文中的 ID 与响应头一致
    expect(body.requestId).toBe(headerId);
  });

  it('不同请求生成不同 ID', async () => {
    const app = buildApp();

    const [res1, res2] = await Promise.all([app.request('/probe'), app.request('/probe')]);
    expect(res1.headers.get('X-Request-ID')).not.toBe(res2.headers.get('X-Request-ID'));
  });

  it('透传入站 X-Request-ID 头', async () => {
    const app = buildApp();

    const res = await app.request('/probe', {
      headers: { 'X-Request-ID': 'client-supplied-id-999' },
    });
    expect(res.headers.get('X-Request-ID')).toBe('client-supplied-id-999');

    const body = await res.json();
    expect(body.requestId).toBe('client-supplied-id-999');
  });

  it('入站头为空字符串时回退为生成 ID', async () => {
    const app = buildApp();

    const res = await app.request('/probe', {
      headers: { 'X-Request-ID': '' },
    });
    expect(res.headers.get('X-Request-ID')).toMatch(/^req_/);
  });
});
