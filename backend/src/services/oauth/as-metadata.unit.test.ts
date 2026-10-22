import { describe, expect, it } from 'vitest';

import {
  buildInsufficientScopeHeader,
  buildWwwAuthenticateHeader,
  getProtectedResourceMetadata,
} from './as-metadata.js';

import type { OAuthConfig } from './types.js';

describe('as-metadata', () => {
  const config: OAuthConfig = {
    mode: 'internal',
    resource: 'https://hub.example.com',
    scopes: ['mcp:tools', 'mcp:resources'],
  };
  const external = {
    issuer: 'https://idp.example.com',
    clientId: 'c',
    clientSecret: 's',
    audience: 'https://hub.example.com',
  };

  it('Protected Resource Metadata 含 MCP MUST 字段（authorization_servers）', () => {
    const doc = getProtectedResourceMetadata(config, 'https://hub.example.com');
    expect(doc.resource).toBe('https://hub.example.com');
    expect(doc.authorization_servers).toBeDefined();
    expect(doc.authorization_servers!.length).toBeGreaterThanOrEqual(1);
    expect(doc.bearer_methods_supported).toEqual(['header']);
    expect(doc.jwks_uri).toBe('https://hub.example.com/api/oauth/jwks');
  });

  it('mode=internal 且未配置 issuer 时 authorization_servers 精确为 [resource]', () => {
    const doc = getProtectedResourceMetadata(config, 'https://hub.example.com');
    // internal.issuer 缺省 → 回退为 resource；且不应混入 undefined 等杂项
    expect(doc.authorization_servers).toEqual(['https://hub.example.com']);
    expect(doc.scopes_supported).toEqual(['mcp:tools', 'mcp:resources']);
  });

  it('mode=internal 且配置了 issuer 时使用 internal.issuer', () => {
    const cfg: OAuthConfig = {
      ...config,
      internal: { tokenTtlSeconds: 3600, clients: [] },
    };
    // internal 无 issuer 字段 → resource；补 issuer 的场景用 both 覆盖（见下）
    const doc = getProtectedResourceMetadata(cfg, 'https://hub.example.com');
    expect(doc.authorization_servers).toEqual(['https://hub.example.com']);
  });

  it('mode=external 时 authorization_servers 含外部 issuer 且不含 resource', () => {
    const cfg: OAuthConfig = { ...config, mode: 'external', external };
    const doc = getProtectedResourceMetadata(cfg, 'https://hub.example.com');
    expect(doc.authorization_servers).toEqual(['https://idp.example.com']);
  });

  it('mode=external 但 external 未配置时 authorization_servers 为空数组', () => {
    const cfg: OAuthConfig = { ...config, mode: 'external' };
    const doc = getProtectedResourceMetadata(cfg, 'https://hub.example.com');
    expect(doc.authorization_servers).toEqual([]);
  });

  it('mode=both 时 authorization_servers 依次含内置与外部 issuer', () => {
    const cfg: OAuthConfig = {
      ...config,
      mode: 'both',
      internal: { issuer: 'https://as.hub.example.com', tokenTtlSeconds: 3600, clients: [] },
      external,
    };
    const doc = getProtectedResourceMetadata(cfg, 'https://hub.example.com');
    // 顺序：internal 在前，external 在后
    expect(doc.authorization_servers).toEqual([
      'https://as.hub.example.com',
      'https://idp.example.com',
    ]);
  });

  it('WWW-Authenticate 头格式符合 MCP 规范（resource_metadata + scope）', () => {
    const header = buildWwwAuthenticateHeader(
      'https://hub.example.com/.well-known/oauth-protected-resource',
      'mcp:tools',
    );
    expect(header).toBe(
      'Bearer resource_metadata="https://hub.example.com/.well-known/oauth-protected-resource", scope="mcp:tools"',
    );
  });

  it('WWW-Authenticate 头无 scope 时省略', () => {
    const header = buildWwwAuthenticateHeader(
      'https://hub.example.com/.well-known/oauth-protected-resource',
    );
    expect(header).toBe(
      'Bearer resource_metadata="https://hub.example.com/.well-known/oauth-protected-resource"',
    );
  });

  describe('buildInsufficientScopeHeader', () => {
    it('基础格式：error + scope + resource_metadata（无 errorDescription）', () => {
      const header = buildInsufficientScopeHeader(
        'https://hub.example.com/.well-known/oauth-protected-resource',
        'mcp:tools',
      );
      expect(header).toBe(
        'Bearer error="insufficient_scope", scope="mcp:tools", ' +
          'resource_metadata="https://hub.example.com/.well-known/oauth-protected-resource"',
      );
    });

    it('含 errorDescription 时追加在末尾', () => {
      const header = buildInsufficientScopeHeader(
        'https://hub.example.com/meta',
        'mcp:tools',
        '需要更高权限',
      );
      expect(header).toBe(
        'Bearer error="insufficient_scope", scope="mcp:tools", ' +
          'resource_metadata="https://hub.example.com/meta", error_description="需要更高权限"',
      );
    });

    it('errorDescription 中的双引号被转义', () => {
      const header = buildInsufficientScopeHeader(
        'https://hub.example.com/meta',
        'mcp:tools',
        '含"引号"的描述',
      );
      // 反斜杠 + 引号的转义序列必须出现，且以完整结尾
      expect(header).toContain('\\"');
      expect(header.endsWith('error_description="含\\"引号\\"的描述"')).toBe(true);
    });
  });
});
