import { beforeEach, describe, expect, it, vi } from 'vitest';

const cryptoMock = vi.hoisted(() => ({
  encryptValidationKey: vi.fn((key: string) => `enc(${key})`),
  decryptValidationKey: vi.fn((key: string) => key.replace(/^enc\(/, '').replace(/\)$/, '')),
  generateValidationKey: vi.fn(() => 'aaa111'),
}));

vi.mock('./crypto.js', () => cryptoMock);

const configMock = vi.hoisted(() => ({
  getAllConfig: vi.fn(),
  saveConfig: vi.fn(),
}));

vi.mock('../../utils/config.js', () => configMock);

import { ValidationKeyServiceError } from './validation-key-service.js';
import {
  createValidationKey,
  deleteValidationKey,
  generateGroupValidationKey,
  getValidationKey,
  validateKey,
} from './validation-key-service.js';

const VALID_KEY = 'abcd1234';

function baseConfig(groups: Record<string, unknown>): void {
  configMock.getAllConfig.mockResolvedValue({
    mcps: { servers: {} },
    groups,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  configMock.saveConfig.mockResolvedValue(undefined);
});

describe('createValidationKey', () => {
  it('校验通过后写入加密密钥并返回摘要', async () => {
    const createdAt = '2026-01-01T00:00:00.000Z';
    baseConfig({
      team: { servers: [], validation: { enabled: false, createdAt } },
    });
    vi.setSystemTime(new Date('2026-02-01T00:00:00Z'));

    const data = await createValidationKey('team', {
      validationKey: VALID_KEY,
      enabled: true,
    });

    expect(cryptoMock.encryptValidationKey).toHaveBeenCalledWith(VALID_KEY);
    expect(configMock.saveConfig).toHaveBeenCalledWith('group.json', {
      team: {
        servers: [],
        validation: {
          enabled: true,
          validationKey: `enc(${VALID_KEY})`,
          createdAt, // 已有 createdAt 被保留
          lastUpdated: '2026-02-01T00:00:00.000Z',
        },
      },
    });
    expect(data).toEqual({
      groupId: 'team',
      validation: {
        enabled: true,
        hasKey: true,
        createdAt,
        lastUpdated: '2026-02-01T00:00:00.000Z',
      },
    });
    vi.useRealTimers();
  });

  it('未显式传 enabled 时默认启用', async () => {
    baseConfig({ team: { servers: [] } });

    const data = await createValidationKey('team', { validationKey: VALID_KEY });

    expect(data.validation.enabled).toBe(true);
  });

  it('enabled=false 时保存为停用', async () => {
    baseConfig({ team: { servers: [] } });

    const data = await createValidationKey('team', {
      validationKey: VALID_KEY,
      enabled: false,
    });

    expect(data.validation.enabled).toBe(false);
    expect(configMock.saveConfig).toHaveBeenCalledWith(
      'group.json',
      expect.objectContaining({
        team: expect.objectContaining({
          validation: expect.objectContaining({ enabled: false }),
        }),
      }),
    );
  });

  it.each([
    ['非法组 ID', 'bad id', VALID_KEY, 'INVALID_GROUP_ID'],
    ['密钥为空', 'team', '', 'INVALID_VALIDATION_KEY'],
    ['密钥过短', 'team', 'ab1', 'INVALID_VALIDATION_KEY'],
    ['密钥缺数字', 'team', 'abcdefgh', 'INVALID_VALIDATION_KEY'],
    ['组不存在', 'missing', VALID_KEY, 'GROUP_NOT_FOUND'],
  ])('%s 时抛 %s', async (_name, groupId, key, code) => {
    baseConfig({ team: { servers: [] } });

    await expect(
      createValidationKey(groupId as string, { validationKey: key as string }),
    ).rejects.toMatchObject({ code, status: code === 'GROUP_NOT_FOUND' ? 404 : 400 });
    expect(configMock.saveConfig).not.toHaveBeenCalled();
  });
});

describe('getValidationKey', () => {
  it('返回启用状态与密钥存在性', async () => {
    baseConfig({
      team: {
        servers: [],
        validation: {
          enabled: true,
          validationKey: 'enc(x)',
          createdAt: '2026-01-01T00:00:00.000Z',
          lastUpdated: '2026-01-02T00:00:00.000Z',
        },
      },
    });

    const data = await getValidationKey('team');

    expect(data).toEqual({
      groupId: 'team',
      validation: {
        enabled: true,
        hasKey: true,
        createdAt: '2026-01-01T00:00:00.000Z',
        lastUpdated: '2026-01-02T00:00:00.000Z',
      },
    });
  });

  it('未配置验证的组返回默认停用状态', async () => {
    baseConfig({ team: { servers: [] } });

    const data = await getValidationKey('team');

    expect(data).toEqual({
      groupId: 'team',
      validation: { enabled: false, hasKey: false, createdAt: undefined, lastUpdated: undefined },
    });
  });

  it('非法组 ID 与不存在的组分别抛错', async () => {
    await expect(getValidationKey('bad id')).rejects.toMatchObject({
      code: 'INVALID_GROUP_ID',
    });

    baseConfig({});
    await expect(getValidationKey('missing')).rejects.toMatchObject({
      code: 'GROUP_NOT_FOUND',
    });
  });
});

describe('validateKey', () => {
  it('未启用验证时直接放行', async () => {
    baseConfig({ team: { servers: [] } });

    const data = await validateKey('team', 'whatever');

    expect(data).toEqual({
      groupId: 'team',
      valid: true,
      reason: 'VALIDATION_DISABLED',
      message: '组未启用验证',
    });
  });

  it('启用但未设置密钥时拒绝', async () => {
    baseConfig({ team: { servers: [], validation: { enabled: true } } });

    const data = await validateKey('team', 'whatever');

    expect(data).toEqual({
      groupId: 'team',
      valid: false,
      reason: 'NO_KEY_SET',
      message: '组未设置验证密钥',
    });
  });

  it('密钥匹配时验证通过', async () => {
    baseConfig({
      team: { servers: [], validation: { enabled: true, validationKey: `enc(${VALID_KEY})` } },
    });

    const data = await validateKey('team', VALID_KEY);

    expect(data).toEqual({
      groupId: 'team',
      valid: true,
      reason: 'KEY_VALID',
      message: '验证密钥正确',
    });
  });

  it('密钥不匹配时拒绝', async () => {
    baseConfig({
      team: { servers: [], validation: { enabled: true, validationKey: `enc(${VALID_KEY})` } },
    });

    const data = await validateKey('team', 'wrong-key-1');

    expect(data).toEqual({
      groupId: 'team',
      valid: false,
      reason: 'INVALID_KEY',
      message: '验证密钥不正确',
    });
  });

  it('解密失败时返回 DECRYPTION_ERROR', async () => {
    baseConfig({
      team: { servers: [], validation: { enabled: true, validationKey: 'enc(broken)' } },
    });
    // decryptValidationKey 为同步函数，验证错误分支需同步抛出
    cryptoMock.decryptValidationKey.mockImplementationOnce(() => {
      throw new Error('解密失败');
    });

    const data = await validateKey('team', VALID_KEY);

    expect(data).toEqual({
      groupId: 'team',
      valid: false,
      reason: 'DECRYPTION_ERROR',
      message: '密钥验证过程出错',
    });
  });

  it('未提供密钥时抛 VALIDATION_ERROR', async () => {
    baseConfig({ team: { servers: [] } });

    await expect(validateKey('team', undefined)).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      status: 400,
      message: '验证密钥不能为空',
    });
  });

  it('非法组 ID 抛 INVALID_GROUP_ID', async () => {
    await expect(validateKey('bad id', 'key')).rejects.toMatchObject({
      code: 'INVALID_GROUP_ID',
    });
  });
});

describe('deleteValidationKey', () => {
  it('删除验证配置并保存', async () => {
    baseConfig({
      team: { servers: [], tools: ['t'], validation: { enabled: true, validationKey: 'enc(x)' } },
    });

    const data = await deleteValidationKey('team');

    expect(configMock.saveConfig).toHaveBeenCalledWith('group.json', {
      team: { servers: [], tools: ['t'] },
    });
    expect(data).toEqual({
      groupId: 'team',
      validation: { enabled: false, hasKey: false },
      deleted: true,
    });
  });

  it('非法组 ID 与不存在的组分别抛错', async () => {
    await expect(deleteValidationKey('bad id')).rejects.toMatchObject({
      code: 'INVALID_GROUP_ID',
    });

    baseConfig({});
    await expect(deleteValidationKey('missing')).rejects.toMatchObject({
      code: 'GROUP_NOT_FOUND',
    });
  });
});

describe('generateGroupValidationKey', () => {
  it('生成随机密钥、加密保存并给出安全评估', async () => {
    const createdAt = '2026-01-01T00:00:00.000Z';
    baseConfig({ team: { servers: [], validation: { enabled: false, createdAt } } });
    vi.setSystemTime(new Date('2026-02-01T00:00:00Z'));

    const data = await generateGroupValidationKey('team');

    // crypto mock 固定返回 'aaa111'
    expect(data.validationKey).toBe('aaa111');
    expect(data.validation).toEqual({
      enabled: true,
      hasKey: true,
      createdAt,
      lastUpdated: '2026-02-01T00:00:00.000Z',
    });
    expect(cryptoMock.encryptValidationKey).toHaveBeenCalledWith('aaa111');
    expect(configMock.saveConfig).toHaveBeenCalledWith('group.json', {
      team: {
        servers: [],
        validation: {
          enabled: true,
          validationKey: 'enc(aaa111)',
          createdAt,
          lastUpdated: '2026-02-01T00:00:00.000Z',
        },
      },
    });
    expect(data.security.keyLength).toBe(6);
    expect(typeof data.security.entropy).toBe('number');
    expect(Array.isArray(data.security.recommendations)).toBe(true);
    // 'aaa111' 复杂度弱且长度 < 16，两条警告都应出现
    expect(data.warnings).toEqual([
      '密钥强度较弱，建议使用更复杂的密钥',
      '密钥长度较短，建议至少16个字符',
    ]);
    vi.useRealTimers();
  });

  it('非法组 ID 与不存在的组分别抛错', async () => {
    await expect(generateGroupValidationKey('bad id')).rejects.toMatchObject({
      code: 'INVALID_GROUP_ID',
    });

    baseConfig({});
    await expect(generateGroupValidationKey('missing')).rejects.toMatchObject({
      code: 'GROUP_NOT_FOUND',
    });
  });
});
