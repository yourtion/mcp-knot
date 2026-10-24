import bcrypt from 'bcryptjs';
import { jwtVerify } from 'jose';
import { describe, expect, it, beforeEach, afterEach } from 'vitest';

import { loadOrCreateSigningKey, _resetForTesting } from './crypto-keys.js';
import { issueClientCredentialsToken, getInternalAsMetadata } from './internal-as.js';

import type { OAuthConfig } from './types.js';

describe('internal-as', () => {
  beforeEach(async () => {
    _resetForTesting();
    delete process.env.OAUTH_INTERNAL_PRIVATE_KEY;
  });
  afterEach(() => _resetForTesting());

  const config: OAuthConfig = {
    mode: 'internal',
    resource: 'https://hub.example.com',
    scopes: ['mcp:tools', 'mcp:resources'],
    internal: {
      issuer: 'https://hub.example.com',
      tokenTtlSeconds: 3600,
      clients: [
        { clientId: 'c1', clientSecret: '$2a$10$hashedplaceholder', scopes: ['mcp:tools'] },
      ],
    },
  };

  it('未配置 oauth.internal 时抛 OAUTH_CONFIG_ERROR', async () => {
    const cfg: OAuthConfig = { ...config, internal: undefined };
    await expect(
      issueClientCredentialsToken(
        { clientId: 'c1', clientSecret: 'secret123', resource: 'https://hub.example.com' },
        cfg,
      ),
    ).rejects.toThrow('内置 AS 未配置');
  });

  it('client_id 不存在时抛 AUTH_INVALID_CREDENTIALS', async () => {
    const cfg = withPlaintextClient(config, 'c1', 'secret123');
    await expect(
      issueClientCredentialsToken(
        {
          clientId: 'no-such-client',
          clientSecret: 'secret123',
          resource: 'https://hub.example.com',
        },
        cfg,
      ),
    ).rejects.toThrow('client_id 不存在');
  });

  it('client_credentials 正确凭据签发 JWT', async () => {
    // 用真实 bcrypt hash：为测试可执行性，这里直接传明文 secret 配合 mock
    const cfg = withPlaintextClient(config, 'c1', 'secret123');
    const result = await issueClientCredentialsToken(
      {
        clientId: 'c1',
        clientSecret: 'secret123',
        scope: 'mcp:tools',
        resource: 'https://hub.example.com',
      },
      cfg,
    );
    expect(result.accessToken.split('.')).toHaveLength(3);
    expect(result.expiresIn).toBe(3600);
    expect(result.scope).toBe('mcp:tools');
  });

  it('错误 clientSecret 拒绝', async () => {
    const cfg = withPlaintextClient(config, 'c1', 'secret123');
    await expect(
      issueClientCredentialsToken(
        {
          clientId: 'c1',
          clientSecret: 'wrong',
          scope: 'mcp:tools',
          resource: 'https://hub.example.com',
        },
        cfg,
      ),
    ).rejects.toThrow(/client_secret|invalid/i);
  });

  it('签发的 token claims 含 iss/aud/scope（audience 绑定 resource）', async () => {
    const cfg = withPlaintextClient(config, 'c1', 'secret123');
    const before = Math.floor(Date.now() / 1000);
    const { accessToken } = await issueClientCredentialsToken(
      {
        clientId: 'c1',
        clientSecret: 'secret123',
        scope: 'mcp:tools',
        resource: 'https://hub.example.com',
      },
      cfg,
    );
    const after = Math.floor(Date.now() / 1000);
    const { publicKeyJwk, kid } = await loadOrCreateSigningKey();
    const key = await importJwk(publicKeyJwk);
    const { payload, protectedHeader } = await jwtVerify(accessToken, key, {
      algorithms: ['RS256'],
    });
    expect(payload.iss).toBe('https://hub.example.com');
    expect(payload.aud).toBe('https://hub.example.com');
    expect(payload.scope).toBe('mcp:tools');
    expect(payload.sub).toBe('c1');
    expect(payload.client_id).toBe('c1');
    // iat 以秒计（毫秒级 iat 会与 exp 量级不符）
    expect(payload.iat).toBeGreaterThanOrEqual(before);
    expect(payload.iat).toBeLessThanOrEqual(after);
    // exp = iat + tokenTtlSeconds
    expect(payload.exp).toBe((payload.iat as number) + 3600);
    // kid 在 protected header
    expect(protectedHeader.kid).toBe(kid);
    expect(protectedHeader.alg).toBe('RS256');
  });

  it('internal.issuer 未配置时回退使用 config.resource 作为 iss', async () => {
    const cfg = withPlaintextClient(config, 'c1', 'secret123');
    cfg.internal = { ...cfg.internal!, issuer: undefined };
    const { accessToken } = await issueClientCredentialsToken(
      {
        clientId: 'c1',
        clientSecret: 'secret123',
        scope: 'mcp:tools',
        resource: 'https://hub.example.com',
      },
      cfg,
    );
    const { publicKeyJwk } = await loadOrCreateSigningKey();
    const key = await importJwk(publicKeyJwk);
    const { payload } = await jwtVerify(accessToken, key, { algorithms: ['RS256'] });
    expect(payload.iss).toBe('https://hub.example.com');
  });

  it('未请求 scope 时授予 client 配置的全部 scope（空格连接）', async () => {
    const cfg: OAuthConfig = {
      ...config,
      internal: {
        ...config.internal!,
        clients: [
          { clientId: 'c1', clientSecret: 'secret123', scopes: ['mcp:tools', 'mcp:resources'] },
        ],
      },
    };
    const result = await issueClientCredentialsToken(
      {
        clientId: 'c1',
        clientSecret: 'secret123',
        resource: 'https://hub.example.com',
      },
      cfg,
    );
    // 全部配置 scope，以单空格 join
    expect(result.scope).toBe('mcp:tools mcp:resources');
  });

  it('请求多 scope（均为配置子集）时按请求顺序返回', async () => {
    const cfg: OAuthConfig = {
      ...config,
      internal: {
        ...config.internal!,
        clients: [
          {
            clientId: 'c1',
            clientSecret: 'secret123',
            scopes: ['mcp:tools', 'mcp:resources', 'mcp:prompts'],
          },
        ],
      },
    };
    const result = await issueClientCredentialsToken(
      {
        clientId: 'c1',
        clientSecret: 'secret123',
        scope: 'mcp:prompts mcp:tools',
        resource: 'https://hub.example.com',
      },
      cfg,
    );
    expect(result.scope).toBe('mcp:prompts mcp:tools');
  });

  it('scope 超出 client 配置范围拒绝', async () => {
    const cfg = withPlaintextClient(config, 'c1', 'secret123'); // client scopes = ['mcp:tools']
    await expect(
      issueClientCredentialsToken(
        {
          clientId: 'c1',
          clientSecret: 'secret123',
          scope: 'mcp:admin',
          resource: 'https://hub.example.com',
        },
        cfg,
      ),
    ).rejects.toThrow(/scope/i);
  });

  describe('clientSecret 校验（bcrypt 优先，否则明文常量时间比较）', () => {
    it('存储值为 bcrypt hash 时走 bcrypt.compare（正确明文通过）', async () => {
      const hash = bcrypt.hashSync('secret123', 4);
      const cfg: OAuthConfig = {
        ...config,
        internal: {
          ...config.internal!,
          clients: [{ clientId: 'c1', clientSecret: hash, scopes: ['mcp:tools'] }],
        },
      };
      const result = await issueClientCredentialsToken(
        {
          clientId: 'c1',
          clientSecret: 'secret123',
          scope: 'mcp:tools',
          resource: 'https://hub.example.com',
        },
        cfg,
      );
      expect(result.accessToken.split('.')).toHaveLength(3);
    });

    it('bcrypt hash + 错误明文拒绝', async () => {
      const hash = bcrypt.hashSync('secret123', 4);
      const cfg: OAuthConfig = {
        ...config,
        internal: {
          ...config.internal!,
          clients: [{ clientId: 'c1', clientSecret: hash, scopes: ['mcp:tools'] }],
        },
      };
      await expect(
        issueClientCredentialsToken(
          {
            clientId: 'c1',
            clientSecret: 'wrong',
            scope: 'mcp:tools',
            resource: 'https://hub.example.com',
          },
          cfg,
        ),
      ).rejects.toThrow(/client_secret|invalid/i);
    });

    it('明文中含 $2x 子串（非 bcrypt 前缀）仍按明文比较通过', async () => {
      // /^\$2[abcy]/ 仅锚定开头：'my$2bsecret' 不是 hash，应走明文比较
      const cfg: OAuthConfig = {
        ...config,
        internal: {
          ...config.internal!,
          clients: [{ clientId: 'c1', clientSecret: 'my$2bsecret', scopes: ['mcp:tools'] }],
        },
      };
      const result = await issueClientCredentialsToken(
        {
          clientId: 'c1',
          clientSecret: 'my$2bsecret',
          scope: 'mcp:tools',
          resource: 'https://hub.example.com',
        },
        cfg,
      );
      expect(result.accessToken.split('.')).toHaveLength(3);
    });

    it('等长但内容不同的明文 secret 拒绝（timingSafeEqual 路径）', async () => {
      const cfg = withPlaintextClient(config, 'c1', 'secret123');
      await expect(
        issueClientCredentialsToken(
          {
            clientId: 'c1',
            clientSecret: 'secret124',
            scope: 'mcp:tools',
            resource: 'https://hub.example.com',
          },
          cfg,
        ),
      ).rejects.toThrow(/client_secret|invalid/i);
    });
  });

  it('AS metadata 精确匹配（端点、grant、auth 方法、scope、revocation）', () => {
    const meta = getInternalAsMetadata('https://hub.example.com');
    expect(meta).toEqual({
      issuer: 'https://hub.example.com',
      token_endpoint: 'https://hub.example.com/api/oauth/token',
      jwks_uri: 'https://hub.example.com/api/oauth/jwks',
      response_types_supported: ['none'],
      grant_types_supported: ['client_credentials'],
      token_endpoint_auth_methods_supported: ['client_secret_post', 'none'],
      code_challenge_methods_supported: ['S256'],
      scopes_supported: ['mcp:tools', 'mcp:resources'],
      resource_parameter_supported: true,
      revocation_endpoint: 'https://hub.example.com/api/oauth/revoke',
    });
  });
});

// 测试辅助：用明文 secret 替换 bcrypt（避免测试依赖 bcrypt 预算）
function withPlaintextClient(cfg: OAuthConfig, clientId: string, plain: string): OAuthConfig {
  return {
    ...cfg,
    internal: {
      ...cfg.internal!,
      clients: [{ clientId, clientSecret: plain, scopes: ['mcp:tools'] }],
    },
  };
}

async function importJwk(jwk: { kty: string; n: string; e: string; kid?: string }) {
  const { importJWK } = await import('jose');
  return importJWK(jwk, 'RS256');
}
