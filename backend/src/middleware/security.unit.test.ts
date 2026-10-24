/**
 * 安全头中间件测试
 * 验证各安全响应头的名称、取值与 CSP 组装
 */
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';

import { secureHeadersMiddleware } from './security.js';

function buildApp() {
  const app = new Hono();
  app.use('*', secureHeadersMiddleware());
  app.get('/probe', (c) => c.text('ok'));
  return app;
}

describe('secureHeadersMiddleware', () => {
  it('注入全部基础安全头', async () => {
    const res = await buildApp().request('/probe');

    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(res.headers.get('X-Frame-Options')).toBe('DENY');
    expect(res.headers.get('X-XSS-Protection')).toBe('1; mode=block');
    expect(res.headers.get('Referrer-Policy')).toBe('strict-origin-when-cross-origin');
  });

  it('组装完整的 Content-Security-Policy', async () => {
    const res = await buildApp().request('/probe');

    expect(res.headers.get('Content-Security-Policy')).toBe(
      [
        "default-src 'self'",
        "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data: https:",
        "font-src 'self' data:",
        "connect-src 'self'",
        "frame-ancestors 'none'",
      ].join('; '),
    );
  });

  it('注入权限策略', async () => {
    const res = await buildApp().request('/probe');

    expect(res.headers.get('Permissions-Policy')).toBe(
      'geolocation=(), microphone=(), camera=(), payment=()',
    );
  });

  it('不影响后续处理器执行', async () => {
    const res = await buildApp().request('/probe');

    expect(res.status).toBe(200);
    expect(await res.text()).toBe('ok');
  });
});
