import { SignJWT, generateKeyPair, exportJWK } from 'jose';
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';

import { logger } from '../../utils/logger.js';
import { _resetForTesting as resetCryptoKeys, loadOrCreateSigningKey } from './crypto-keys.js';
import { issueClientCredentialsToken } from './internal-as.js';
import { createTokenValidator } from './token-validator.js';

import type { JwksCache } from './jwks-cache.js';
import type { OAuthConfig } from './types.js';

describe('token-validator', () => {
  let keypair: { privateKey: CryptoKey; publicKey: CryptoKey; kid: string };

  beforeEach(async () => {
    const kp = await generateKeyPair('RS256');
    keypair = { ...kp, kid: 'test-kid' };
  });

  const externalCfg: OAuthConfig = {
    mode: 'external',
    resource: 'https://hub.example.com',
    scopes: ['mcp:tools'],
    external: {
      issuer: 'https://idp.example.com',
      clientId: 'hub',
      clientSecret: 's',
      jwksUri: 'https://idp.example.com/jwks',
      audience: 'https://hub.example.com',
    },
  };

  async function signToken(overrides: Record<string, unknown> = {}) {
    return new SignJWT({ scope: 'mcp:tools', ...overrides })
      .setProtectedHeader({ alg: 'RS256', kid: keypair.kid })
      .setIssuedAt()
      .setIssuer('https://idp.example.com')
      .setSubject('c1')
      .setAudience('https://hub.example.com')
      .setExpirationTime('1h')
      .sign(keypair.privateKey);
  }

  function stubJwks() {
    // jose v6 的 createRemoteJWKSet 校验 res.status（=== 200）而非 res.ok，
    // 因此 mock 必须返回 status: 200（参考 jwks-cache.unit.test.ts 的可用写法）。
    vi.stubGlobal('fetch', async () => ({
      status: 200,
      json: async () => ({ keys: [{ ...(await exportJWK(keypair.publicKey)), kid: keypair.kid }] }),
    }));
  }

  it('JWT 本地验签通过（iss/aud/scope 正确）', async () => {
    stubJwks();
    const validator = createTokenValidator(externalCfg);
    const token = await signToken();
    const result = await validator.validate(token, 'mcp:tools');
    expect(result.ok).toBe(true);
    vi.unstubAllGlobals();
  });

  it('aud 不匹配拒绝（OAUTH_INVALID_AUDIENCE）', async () => {
    stubJwks();
    const validator = createTokenValidator(externalCfg);
    const token = await signToken({}).then(() =>
      // 重新签一个 aud 错的
      new SignJWT({ scope: 'mcp:tools' })
        .setProtectedHeader({ alg: 'RS256', kid: keypair.kid })
        .setIssuedAt()
        .setIssuer('https://idp.example.com')
        .setSubject('c1')
        .setAudience('https://other.example.com')
        .setExpirationTime('1h')
        .sign(keypair.privateKey),
    );
    const result = await validator.validate(token, 'mcp:tools');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('audience');
    vi.unstubAllGlobals();
  });

  it('过期 token 拒绝', async () => {
    stubJwks();
    const validator = createTokenValidator(externalCfg);
    const token = await new SignJWT({ scope: 'mcp:tools' })
      .setProtectedHeader({ alg: 'RS256', kid: keypair.kid })
      .setIssuedAt()
      .setIssuer('https://idp.example.com')
      .setSubject('c1')
      .setAudience('https://hub.example.com')
      .setExpirationTime('0s')
      .sign(keypair.privateKey);
    // 等过期
    await new Promise((r) => setTimeout(r, 50));
    const result = await validator.validate(token, 'mcp:tools');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('expired');
    vi.unstubAllGlobals();
  });

  it('scope 不足拒绝（insufficient_scope）', async () => {
    stubJwks();
    const validator = createTokenValidator(externalCfg);
    const token = await new SignJWT({ scope: 'mcp:resources' }) // 只有 resources
      .setProtectedHeader({ alg: 'RS256', kid: keypair.kid })
      .setIssuedAt()
      .setIssuer('https://idp.example.com')
      .setSubject('c1')
      .setAudience('https://hub.example.com')
      .setExpirationTime('1h')
      .sign(keypair.privateKey);
    const result = await validator.validate(token, 'mcp:tools');
    expect(result.ok).toBe(false);
    // scope 不匹配返回 reason: 'scope'，供中间件层（Task 10）映射为 OAUTH_INSUFFICIENT_SCOPE + 403
    if (!result.ok) expect(result.reason).toBe('scope');
    vi.unstubAllGlobals();
  });

  it('opaque token 触发 introspection 回退', async () => {
    const introspectMock = vi.fn().mockResolvedValue({
      active: true,
      aud: 'https://hub.example.com',
      scope: 'mcp:tools',
      exp: Math.floor(Date.now() / 1000) + 3600,
      client_id: 'c1',
    });
    const validator = createTokenValidator(externalCfg, { introspectToken: introspectMock });
    // opaque token：不是 JWT 格式（少于 3 段 .）
    const result = await validator.validate('opaque-token-xyz', 'mcp:tools');
    expect(introspectMock).toHaveBeenCalledWith('opaque-token-xyz');
    expect(result.ok).toBe(true);
  });

  it('introspection 返回 inactive 拒绝', async () => {
    const introspectMock = vi.fn().mockResolvedValue({ active: false });
    const validator = createTokenValidator(externalCfg, { introspectToken: introspectMock });
    const result = await validator.validate('opaque-token-xyz', 'mcp:tools');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('inactive');
  });

  it('mode=internal 且 JWT 验签失败 → 不回退 introspection，直接 invalid', async () => {
    const internalCfg: OAuthConfig = {
      ...externalCfg,
      mode: 'internal',
      internal: { tokenTtlSeconds: 3600, clients: [] },
    };
    delete (internalCfg as { external?: unknown }).external;
    const introspectMock = vi.fn();
    const validator = createTokenValidator(internalCfg, { introspectToken: introspectMock });
    const result = await validator.validate('malformed-jwt', 'mcp:tools');
    expect(result.ok).toBe(false);
    expect(introspectMock).not.toHaveBeenCalled();
  });

  // ------------------------------------------------------------------
  // internal 模式本地验签（load-bearing 修复覆盖）
  //
  // 此前 verifyJwt 在 !ext 分支直接返回 invalid，导致 internal 模式签发的
  // 合法 token 被错误拒绝。修复后用 getInternalPublicKeySet + importJWK 本地验签。
  // ------------------------------------------------------------------
  describe('internal 模式本地验签（load-bearing 修复）', () => {
    const internalResource = 'https://hub.example.com';
    const internalIssuer = 'https://hub.example.com';

    const internalCfg: OAuthConfig = {
      mode: 'internal',
      resource: internalResource,
      scopes: ['mcp:tools', 'mcp:resources'],
      internal: {
        issuer: internalIssuer,
        tokenTtlSeconds: 3600,
        clients: [{ clientId: 'c1', clientSecret: 's3cret', scopes: ['mcp:tools'] }],
      },
    };

    beforeEach(() => {
      // crypto-keys 模块级缓存会影响其它测试，每个 case 前重置
      resetCryptoKeys();
    });

    it('内置 AS 签发的 token 能本地验签通过（iss/aud/scope 正确）', async () => {
      // 用内置 AS 签发（内部会调用 loadOrCreateSigningKey 初始化公钥）
      const { accessToken } = await issueClientCredentialsToken(
        { clientId: 'c1', clientSecret: 's3cret', scope: 'mcp:tools', resource: internalResource },
        internalCfg,
      );
      const validator = createTokenValidator(internalCfg);
      const result = await validator.validate(accessToken, 'mcp:tools');
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.method).toBe('jwt');
        expect((result.claims as { sub?: string }).sub).toBe('c1');
      }
    });

    it('aud 与 resource 不匹配 → audience 拒绝', async () => {
      // 手动签一个 aud 错的 token（用内置密钥）
      const { privateKey, kid } = await loadOrCreateSigningKey();
      const token = await new SignJWT({ scope: 'mcp:tools', client_id: 'c1' })
        .setProtectedHeader({ alg: 'RS256', kid })
        .setIssuedAt()
        .setIssuer(internalIssuer)
        .setSubject('c1')
        .setAudience('https://other.example.com') // 错的 resource
        .setExpirationTime('1h')
        .sign(privateKey);
      const validator = createTokenValidator(internalCfg);
      const result = await validator.validate(token, 'mcp:tools');
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe('audience');
    });

    it('scope 不足 → scope 拒绝', async () => {
      const { privateKey, kid } = await loadOrCreateSigningKey();
      const token = await new SignJWT({ scope: 'mcp:resources', client_id: 'c1' })
        .setProtectedHeader({ alg: 'RS256', kid })
        .setIssuedAt()
        .setIssuer(internalIssuer)
        .setSubject('c1')
        .setAudience(internalResource)
        .setExpirationTime('1h')
        .sign(privateKey);
      const validator = createTokenValidator(internalCfg);
      const result = await validator.validate(token, 'mcp:tools');
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe('scope');
    });

    it('过期 token → expired 拒绝', async () => {
      const { privateKey, kid } = await loadOrCreateSigningKey();
      const token = await new SignJWT({ scope: 'mcp:tools', client_id: 'c1' })
        .setProtectedHeader({ alg: 'RS256', kid })
        .setIssuedAt()
        .setIssuer(internalIssuer)
        .setSubject('c1')
        .setAudience(internalResource)
        .setExpirationTime('0s')
        .sign(privateKey);
      await new Promise((r) => setTimeout(r, 50));
      const validator = createTokenValidator(internalCfg);
      const result = await validator.validate(token, 'mcp:tools');
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe('expired');
    });

    it('用未知 kid 签发的 token → invalid 拒绝', async () => {
      // 用一把完全不同的密钥签发（kid 不在内置公钥集里）
      const foreignKp = await generateKeyPair('RS256');
      const token = await new SignJWT({ scope: 'mcp:tools', client_id: 'c1' })
        .setProtectedHeader({ alg: 'RS256', kid: 'unknown-kid' })
        .setIssuedAt()
        .setIssuer(internalIssuer)
        .setSubject('c1')
        .setAudience(internalResource)
        .setExpirationTime('1h')
        .sign(foreignKp.privateKey);
      // 先确保内置密钥已初始化（否则公钥集为空，会走另一条 invalid 分支）
      await loadOrCreateSigningKey();
      const validator = createTokenValidator(internalCfg);
      const result = await validator.validate(token, 'mcp:tools');
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe('invalid');
    });
  });

  // ------------------------------------------------------------------
  // 外部 JWKS 路径（注入 fake jwksCache，替代 fetch stub，确定性验证）
  // ------------------------------------------------------------------
  describe('外部 JWKS 路径（fake jwksCache）', () => {
    beforeEach(() => {
      vi.restoreAllMocks();
    });

    function fakeJwksCache(key: CryptoKey = keypair.publicKey): {
      cache: JwksCache;
      getKey: ReturnType<typeof vi.fn>;
    } {
      const getKey = vi.fn(
        (_kid: string | undefined, _jwksUri: string): Promise<CryptoKey | Uint8Array> =>
          Promise.resolve(key),
      );
      return { cache: { getKey, clear: vi.fn() }, getKey };
    }

    it('验签通过：method=jwt 且 claims 原样返回，getKey 收到 kid 与 jwksUri', async () => {
      const { cache, getKey } = fakeJwksCache();
      const validator = createTokenValidator(externalCfg, { jwksCache: cache });
      const token = await signToken();

      const result = await validator.validate(token, 'mcp:tools');

      expect(getKey).toHaveBeenCalledWith('test-kid', 'https://idp.example.com/jwks');
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.method).toBe('jwt');
        expect((result.claims as { scope?: string }).scope).toBe('mcp:tools');
      }
    });

    it('签名错误的外部 JWT（reason=invalid）回退 introspection', async () => {
      const { cache } = fakeJwksCache();
      const foreign = await generateKeyPair('RS256');
      const token = await new SignJWT({ scope: 'mcp:tools' })
        .setProtectedHeader({ alg: 'RS256', kid: 'test-kid' })
        .setIssuedAt()
        .setIssuer('https://idp.example.com')
        .setSubject('c1')
        .setAudience('https://hub.example.com')
        .setExpirationTime('1h')
        .sign(foreign.privateKey);
      const introspectMock = vi.fn().mockResolvedValue({
        active: true,
        aud: 'https://hub.example.com',
        scope: 'mcp:tools',
      });
      const validator = createTokenValidator(externalCfg, {
        jwksCache: cache,
        introspectToken: introspectMock,
      });

      const result = await validator.validate(token, 'mcp:tools');

      expect(introspectMock).toHaveBeenCalledWith(token);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.method).toBe('introspection');
    });

    it('过期的外部 token：reason=expired 直接返回，不回退 introspection', async () => {
      const { cache } = fakeJwksCache();
      const token = await new SignJWT({ scope: 'mcp:tools' })
        .setProtectedHeader({ alg: 'RS256', kid: 'test-kid' })
        .setIssuedAt()
        .setIssuer('https://idp.example.com')
        .setSubject('c1')
        .setAudience('https://hub.example.com')
        .setExpirationTime(Math.floor(Date.now() / 1000) - 60)
        .sign(keypair.privateKey);
      const introspectMock = vi.fn();
      const validator = createTokenValidator(externalCfg, {
        jwksCache: cache,
        introspectToken: introspectMock,
      });

      const result = await validator.validate(token, 'mcp:tools');

      expect(result).toStrictEqual({ ok: false, reason: 'expired' });
      expect(introspectMock).not.toHaveBeenCalled();
    });

    it('scope 不足的外部 token：reason=scope 直接返回，不回退 introspection', async () => {
      const { cache } = fakeJwksCache();
      const token = await signToken({ scope: 'mcp:resources' });
      const introspectMock = vi.fn();
      const validator = createTokenValidator(externalCfg, {
        jwksCache: cache,
        introspectToken: introspectMock,
      });

      const result = await validator.validate(token, 'mcp:tools');

      expect(result).toStrictEqual({ ok: false, reason: 'scope' });
      expect(introspectMock).not.toHaveBeenCalled();
    });

    it('aud 不匹配的外部 token：reason=audience 直接返回，不回退 introspection', async () => {
      const { cache } = fakeJwksCache();
      const token = await new SignJWT({ scope: 'mcp:tools' })
        .setProtectedHeader({ alg: 'RS256', kid: 'test-kid' })
        .setIssuedAt()
        .setIssuer('https://idp.example.com')
        .setSubject('c1')
        .setAudience('https://other.example.com')
        .setExpirationTime('1h')
        .sign(keypair.privateKey);
      const introspectMock = vi.fn();
      const validator = createTokenValidator(externalCfg, {
        jwksCache: cache,
        introspectToken: introspectMock,
      });

      const result = await validator.validate(token, 'mcp:tools');

      expect(result).toStrictEqual({ ok: false, reason: 'audience' });
      expect(introspectMock).not.toHaveBeenCalled();
    });

    it('iss 不匹配：invalid（非 audience）后回退 introspection 成功', async () => {
      const { cache } = fakeJwksCache();
      const badIssToken = await new SignJWT({ scope: 'mcp:tools' })
        .setProtectedHeader({ alg: 'RS256', kid: 'test-kid' })
        .setIssuedAt()
        .setIssuer('https://evil.example.com')
        .setSubject('c1')
        .setAudience('https://hub.example.com')
        .setExpirationTime('1h')
        .sign(keypair.privateKey);
      const introspectMock = vi.fn().mockResolvedValue({
        active: true,
        aud: 'https://hub.example.com',
        scope: 'mcp:tools',
      });
      const validator = createTokenValidator(externalCfg, {
        jwksCache: cache,
        introspectToken: introspectMock,
      });

      const result = await validator.validate(badIssToken, 'mcp:tools');

      expect(result.ok).toBe(true);
      if (result.ok) expect(result.method).toBe('introspection');
    });

    it('jwksUri 缺省时回退 `${issuer}/jwks`', async () => {
      const { cache, getKey } = fakeJwksCache();
      const cfg: OAuthConfig = {
        ...externalCfg,
        external: { ...externalCfg.external! },
      };
      delete (cfg.external as { jwksUri?: string }).jwksUri;
      const validator = createTokenValidator(cfg, { jwksCache: cache });
      const token = await signToken();

      const result = await validator.validate(token, 'mcp:tools');

      expect(getKey).toHaveBeenCalledWith('test-kid', 'https://idp.example.com/jwks');
      expect(result.ok).toBe(true);
    });

    it('非 JWT（两段）token 不触碰 JWKS 缓存', async () => {
      const { cache, getKey } = fakeJwksCache();
      const introspectMock = vi.fn().mockResolvedValue({
        active: true,
        aud: 'https://hub.example.com',
        scope: 'mcp:tools',
      });
      const validator = createTokenValidator(externalCfg, {
        jwksCache: cache,
        introspectToken: introspectMock,
      });

      const result = await validator.validate('ab.cd', 'mcp:tools');

      expect(getKey).not.toHaveBeenCalled();
      expect(result.ok).toBe(true);
    });

    it('internal 模式 opaque token：reason=invalid 且不调用 introspect', async () => {
      const internalCfg: OAuthConfig = {
        ...externalCfg,
        mode: 'internal',
        internal: { tokenTtlSeconds: 3600, clients: [] },
      };
      delete (internalCfg as { external?: unknown }).external;
      const introspectMock = vi.fn();
      const validator = createTokenValidator(internalCfg, { introspectToken: introspectMock });

      const result = await validator.validate('opaque-token', 'mcp:tools');

      expect(result).toStrictEqual({ ok: false, reason: 'invalid' });
      expect(introspectMock).not.toHaveBeenCalled();
    });
  });

  // ------------------------------------------------------------------
  // both 模式：JWKS → 内置公钥 → introspection 三级回退
  // ------------------------------------------------------------------
  describe('both 模式三级回退', () => {
    const bothCfg: OAuthConfig = {
      mode: 'both',
      resource: 'https://hub.example.com',
      scopes: ['mcp:tools'],
      internal: {
        issuer: 'https://hub.example.com',
        tokenTtlSeconds: 3600,
        clients: [{ clientId: 'c1', clientSecret: 's3cret', scopes: ['mcp:tools'] }],
      },
      external: {
        issuer: 'https://idp.example.com',
        clientId: 'hub',
        clientSecret: 's',
        jwksUri: 'https://idp.example.com/jwks',
        audience: 'https://hub.example.com',
      },
    };

    let fakeCache: JwksCache;
    let getKey: ReturnType<typeof vi.fn>;

    beforeEach(async () => {
      vi.restoreAllMocks();
      resetCryptoKeys();
      await loadOrCreateSigningKey();
      const getKeyFn = vi.fn(
        (_kid: string | undefined, _jwksUri: string): Promise<CryptoKey | Uint8Array> =>
          Promise.resolve(keypair.publicKey),
      );
      getKey = getKeyFn;
      fakeCache = { getKey: getKeyFn, clear: vi.fn() };
    });

    it('内置 AS 签发的 token：JWKS 验签失败后回退内置公钥验签成功', async () => {
      const { privateKey, kid } = await loadOrCreateSigningKey();
      const token = await new SignJWT({ scope: 'mcp:tools', client_id: 'c1' })
        .setProtectedHeader({ alg: 'RS256', kid })
        .setIssuedAt()
        .setIssuer('https://hub.example.com')
        .setSubject('c1')
        .setAudience('https://hub.example.com')
        .setExpirationTime('1h')
        .sign(privateKey);
      const validator = createTokenValidator(bothCfg, { jwksCache: fakeCache });

      const result = await validator.validate(token, 'mcp:tools');

      expect(getKey).toHaveBeenCalled(); // 先尝试外部 JWKS
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.method).toBe('jwt');
        expect((result.claims as { sub?: string }).sub).toBe('c1');
      }
    });

    it('过期的外部签发 token：expired 结论直接返回，不回退内置公钥', async () => {
      const token = await new SignJWT({ scope: 'mcp:tools' })
        .setProtectedHeader({ alg: 'RS256', kid: 'test-kid' })
        .setIssuedAt()
        .setIssuer('https://idp.example.com')
        .setSubject('c1')
        .setAudience('https://hub.example.com')
        .setExpirationTime(Math.floor(Date.now() / 1000) - 60)
        .sign(keypair.privateKey);
      const validator = createTokenValidator(bothCfg, { jwksCache: fakeCache });

      const result = await validator.validate(token, 'mcp:tools');

      expect(result).toStrictEqual({ ok: false, reason: 'expired' });
    });

    it('双路验签都失败的 JWT：回退 introspection', async () => {
      const introspectMock = vi.fn().mockResolvedValue({
        active: true,
        aud: 'https://hub.example.com',
        scope: 'mcp:tools',
      });
      const validator = createTokenValidator(bothCfg, {
        jwksCache: fakeCache,
        introspectToken: introspectMock,
      });

      const result = await validator.validate('garbage.header.signature', 'mcp:tools');

      expect(introspectMock).toHaveBeenCalledWith('garbage.header.signature');
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.method).toBe('introspection');
    });

    it('opaque token：直接走 introspection', async () => {
      const introspectMock = vi.fn().mockResolvedValue({
        active: true,
        aud: 'https://hub.example.com',
        scope: 'mcp:tools',
      });
      const validator = createTokenValidator(bothCfg, { introspectToken: introspectMock });

      const result = await validator.validate('opaque-token', 'mcp:tools');

      expect(getKey).not.toHaveBeenCalled();
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.method).toBe('introspection');
    });
  });

  // ------------------------------------------------------------------
  // internal 模式本地验签补充（边界与防御分支）
  // ------------------------------------------------------------------
  describe('internal 模式本地验签（补充）', () => {
    const internalResource = 'https://hub.example.com';
    const internalIssuer = 'https://hub.example.com';

    const internalCfg: OAuthConfig = {
      mode: 'internal',
      resource: internalResource,
      scopes: ['mcp:tools'],
      internal: {
        issuer: internalIssuer,
        tokenTtlSeconds: 3600,
        clients: [{ clientId: 'c1', clientSecret: 's3cret', scopes: ['mcp:tools'] }],
      },
    };

    beforeEach(() => {
      vi.restoreAllMocks();
      resetCryptoKeys();
    });

    async function signWithInternalKey(
      header: Record<string, unknown>,
      issuer: string,
    ): Promise<string> {
      const { privateKey } = await loadOrCreateSigningKey();
      return new SignJWT({ scope: 'mcp:tools', client_id: 'c1' })
        .setProtectedHeader({ alg: 'RS256', ...header })
        .setIssuedAt()
        .setIssuer(issuer)
        .setSubject('c1')
        .setAudience(internalResource)
        .setExpirationTime('1h')
        .sign(privateKey);
    }

    it('内置公钥集为空：invalid 并记录告警', async () => {
      const warnSpy = vi.spyOn(logger, 'warn');
      const validator = createTokenValidator(internalCfg);

      const result = await validator.validate('a.b.c', 'mcp:tools');

      expect(result).toStrictEqual({ ok: false, reason: 'invalid' });
      expect(warnSpy).toHaveBeenCalledWith('internal 模式验签：内置公钥集为空（密钥未加载）');
    });

    it('header 非法 JSON：invalid', async () => {
      await loadOrCreateSigningKey();
      const badHeader = Buffer.from('not json', 'utf8').toString('base64url');
      const validator = createTokenValidator(internalCfg);

      const result = await validator.validate(`${badHeader}.x.y`, 'mcp:tools');

      expect(result).toStrictEqual({ ok: false, reason: 'invalid' });
    });

    it('kid 不在公钥集（同一私钥签名）：invalid 并记录 kid 不匹配', async () => {
      const debugSpy = vi.spyOn(logger, 'debug');
      const token = await signWithInternalKey({ kid: 'other-kid' }, internalIssuer);
      const validator = createTokenValidator(internalCfg);

      const result = await validator.validate(token, 'mcp:tools');

      expect(result).toStrictEqual({ ok: false, reason: 'invalid' });
      expect(debugSpy).toHaveBeenCalledWith('internal 模式验签：kid 不匹配', { kid: 'other-kid' });
    });

    it('无 kid 的 token 用第一把公钥验签成功', async () => {
      const token = await signWithInternalKey({}, internalIssuer);
      const validator = createTokenValidator(internalCfg);

      const result = await validator.validate(token, 'mcp:tools');

      expect(result.ok).toBe(true);
      if (result.ok) expect(result.method).toBe('jwt');
    });

    it('internal 无 issuer 配置：iss 用 resource 校验（匹配则通过）', async () => {
      const cfg: OAuthConfig = {
        mode: 'internal',
        resource: internalResource,
        scopes: ['mcp:tools'],
        internal: { tokenTtlSeconds: 3600, clients: [] },
      };
      const { privateKey, kid } = await loadOrCreateSigningKey();
      const token = await new SignJWT({ scope: 'mcp:tools', client_id: 'c1' })
        .setProtectedHeader({ alg: 'RS256', kid })
        .setIssuedAt()
        .setIssuer(internalResource)
        .setSubject('c1')
        .setAudience(internalResource)
        .setExpirationTime('1h')
        .sign(privateKey);
      const validator = createTokenValidator(cfg);

      const result = await validator.validate(token, 'mcp:tools');

      expect(result.ok).toBe(true);
    });

    it('internal 无 issuer 配置：iss 不匹配被拒绝', async () => {
      const cfg: OAuthConfig = {
        mode: 'internal',
        resource: internalResource,
        scopes: ['mcp:tools'],
        internal: { tokenTtlSeconds: 3600, clients: [] },
      };
      const { privateKey, kid } = await loadOrCreateSigningKey();
      const token = await new SignJWT({ scope: 'mcp:tools', client_id: 'c1' })
        .setProtectedHeader({ alg: 'RS256', kid })
        .setIssuedAt()
        .setIssuer('https://evil.example.com')
        .setSubject('c1')
        .setAudience(internalResource)
        .setExpirationTime('1h')
        .sign(privateKey);
      const validator = createTokenValidator(cfg);

      const result = await validator.validate(token, 'mcp:tools');

      expect(result).toStrictEqual({ ok: false, reason: 'invalid' });
    });

    it('config 无 internal 块：iss 仍回退 resource 校验', async () => {
      const cfg: OAuthConfig = {
        mode: 'internal',
        resource: internalResource,
        scopes: ['mcp:tools'],
      };
      const { privateKey, kid } = await loadOrCreateSigningKey();
      const token = await new SignJWT({ scope: 'mcp:tools', client_id: 'c1' })
        .setProtectedHeader({ alg: 'RS256', kid })
        .setIssuedAt()
        .setIssuer(internalResource)
        .setSubject('c1')
        .setAudience(internalResource)
        .setExpirationTime('1h')
        .sign(privateKey);
      const validator = createTokenValidator(cfg);

      const result = await validator.validate(token, 'mcp:tools');

      expect(result.ok).toBe(true);
    });
  });

  // ------------------------------------------------------------------
  // introspection 映射与缓存（fake timers 控制 TTL 与 LRU）
  // ------------------------------------------------------------------
  describe('introspection 映射与缓存', () => {
    const baseTime = new Date('2026-10-01T00:00:00.000Z');

    beforeEach(() => {
      vi.restoreAllMocks();
      vi.useFakeTimers();
      vi.setSystemTime(baseTime);
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    const activeResult = {
      active: true,
      aud: 'https://hub.example.com',
      scope: 'mcp:tools',
      exp: Math.floor(baseTime.getTime() / 1000) + 3600,
      client_id: 'c1',
      sub: 'c1',
    };

    it('aud 为数组且包含 resource：ok + method introspection + claims 透传', async () => {
      const result0 = {
        ...activeResult,
        aud: ['https://other.example.com', 'https://hub.example.com'],
      };
      const introspectMock = vi.fn().mockResolvedValue(result0);
      const validator = createTokenValidator(externalCfg, { introspectToken: introspectMock });

      const result = await validator.validate('opaque-1', 'mcp:tools');

      expect(result).toStrictEqual({ ok: true, claims: result0, method: 'introspection' });
    });

    it('aud 缺失：reason=audience', async () => {
      const introspectMock = vi.fn().mockResolvedValue({ active: true, scope: 'mcp:tools' });
      const validator = createTokenValidator(externalCfg, { introspectToken: introspectMock });

      const result = await validator.validate('opaque-1', 'mcp:tools');

      expect(result).toStrictEqual({ ok: false, reason: 'audience' });
    });

    it('aud 不匹配：reason=audience', async () => {
      const introspectMock = vi.fn().mockResolvedValue({
        ...activeResult,
        aud: 'https://other.example.com',
      });
      const validator = createTokenValidator(externalCfg, { introspectToken: introspectMock });

      const result = await validator.validate('opaque-1', 'mcp:tools');

      expect(result).toStrictEqual({ ok: false, reason: 'audience' });
    });

    it('scope 多值空格分隔：ok', async () => {
      const introspectMock = vi.fn().mockResolvedValue({
        ...activeResult,
        scope: 'mcp:tools mcp:resources',
      });
      const validator = createTokenValidator(externalCfg, { introspectToken: introspectMock });

      const result = await validator.validate('opaque-1', 'mcp:tools');

      expect(result.ok).toBe(true);
    });

    it('scope 缺失：reason=scope', async () => {
      const introspectMock = vi.fn().mockResolvedValue({ ...activeResult, scope: undefined });
      const validator = createTokenValidator(externalCfg, { introspectToken: introspectMock });

      const result = await validator.validate('opaque-1', 'mcp:tools');

      expect(result).toStrictEqual({ ok: false, reason: 'scope' });
    });

    it('scope 不含必需值：reason=scope', async () => {
      const introspectMock = vi.fn().mockResolvedValue({
        ...activeResult,
        scope: 'mcp:resources',
      });
      const validator = createTokenValidator(externalCfg, { introspectToken: introspectMock });

      const result = await validator.validate('opaque-1', 'mcp:tools');

      expect(result).toStrictEqual({ ok: false, reason: 'scope' });
    });

    it('inactive：reason=inactive', async () => {
      const introspectMock = vi.fn().mockResolvedValue({ active: false });
      const validator = createTokenValidator(externalCfg, { introspectToken: introspectMock });

      const result = await validator.validate('opaque-1', 'mcp:tools');

      expect(result).toStrictEqual({ ok: false, reason: 'inactive' });
    });

    it('introspection 路径校验固定 scope mcp:tools（与 validate 参数无关）', async () => {
      const introspectMock = vi.fn().mockResolvedValue(activeResult);
      const validator = createTokenValidator(externalCfg, { introspectToken: introspectMock });

      const result = await validator.validate('opaque-1', 'mcp:other');

      expect(result.ok).toBe(true);
    });

    it('未注入 introspectToken：fail-closed inactive 并告警', async () => {
      const warnSpy = vi.spyOn(logger, 'warn');
      const validator = createTokenValidator(externalCfg);

      const result = await validator.validate('opaque-1', 'mcp:tools');

      expect(result).toStrictEqual({ ok: false, reason: 'inactive' });
      expect(warnSpy).toHaveBeenCalledWith(
        'external 模式 introspectToken 未注入，token 视为 inactive（fail-closed）',
      );
    });

    it('external 无 audience 配置：expected audience 回退 resource', async () => {
      const cfg: OAuthConfig = {
        ...externalCfg,
        external: { ...externalCfg.external! },
      };
      delete (cfg.external as { audience?: string }).audience;
      const introspectMock = vi
        .fn()
        .mockResolvedValue({ ...activeResult, aud: 'https://hub.example.com' });
      const validator = createTokenValidator(cfg, { introspectToken: introspectMock });

      const result = await validator.validate('opaque-1', 'mcp:tools');

      expect(result.ok).toBe(true);
    });

    it('both 无 external 块：audience 校验用 resource', async () => {
      const cfg: OAuthConfig = {
        mode: 'both',
        resource: 'https://hub.example.com',
        scopes: ['mcp:tools'],
        internal: { tokenTtlSeconds: 3600, clients: [] },
      };
      const introspectMock = vi.fn().mockResolvedValue(activeResult);
      const validator = createTokenValidator(cfg, { introspectToken: introspectMock });

      const result = await validator.validate('opaque-1', 'mcp:tools');

      expect(result.ok).toBe(true);
    });

    describe('TTL 缓存', () => {
      it('同一 token 60s 内命中缓存：introspectToken 只调用一次', async () => {
        const introspectMock = vi.fn().mockResolvedValue(activeResult);
        const validator = createTokenValidator(externalCfg, { introspectToken: introspectMock });

        const first = await validator.validate('opaque-1', 'mcp:tools');
        vi.setSystemTime(new Date(baseTime.getTime() + 30_000));
        const second = await validator.validate('opaque-1', 'mcp:tools');

        expect(introspectMock).toHaveBeenCalledTimes(1);
        expect(first).toStrictEqual(second);
      });

      it('59_999ms 仍命中缓存（TTL 严格小于比较）', async () => {
        const introspectMock = vi.fn().mockResolvedValue(activeResult);
        const validator = createTokenValidator(externalCfg, { introspectToken: introspectMock });

        await validator.validate('opaque-1', 'mcp:tools');
        vi.setSystemTime(new Date(baseTime.getTime() + 59_999));
        await validator.validate('opaque-1', 'mcp:tools');

        expect(introspectMock).toHaveBeenCalledTimes(1);
      });

      it('恰好 60_000ms 缓存过期重新 introspect', async () => {
        const introspectMock = vi.fn().mockResolvedValue(activeResult);
        const validator = createTokenValidator(externalCfg, { introspectToken: introspectMock });

        await validator.validate('opaque-1', 'mcp:tools');
        vi.setSystemTime(new Date(baseTime.getTime() + 60_000));
        await validator.validate('opaque-1', 'mcp:tools');

        expect(introspectMock).toHaveBeenCalledTimes(2);
      });
    });

    it('LRU 上界：1000 条缓存后淘汰最早条目', async () => {
      const introspectMock = vi.fn().mockResolvedValue(activeResult);
      const validator = createTokenValidator(externalCfg, { introspectToken: introspectMock });

      for (let i = 0; i <= 1000; i++) {
        const result = await validator.validate(`opaque-${i}`, 'mcp:tools');
        expect(result.ok).toBe(true);
      }
      expect(introspectMock).toHaveBeenCalledTimes(1001);

      // tok-999 仍在缓存中：命中，不新增调用
      await validator.validate('opaque-999', 'mcp:tools');
      expect(introspectMock).toHaveBeenCalledTimes(1001);

      // tok-0 已在插入 opaque-1000 时被淘汰：重新 introspect
      await validator.validate('opaque-0', 'mcp:tools');
      expect(introspectMock).toHaveBeenCalledTimes(1002);
    });
  });
});
