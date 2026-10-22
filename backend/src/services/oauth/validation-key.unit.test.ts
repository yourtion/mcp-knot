import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { encryptValidationKey } from '../../api/groups/crypto.js';
import { verifyValidationKey } from './validation-key.js';

// Mock logger：validation-key 的 catch 分支会调用 logger.warn
const loggerMock = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));
vi.mock('../../utils/logger.js', () => ({ logger: loggerMock }));

describe('validation-key', () => {
  const origSecret = process.env.VALIDATION_KEY_SECRET;
  beforeAll(() => {
    process.env.VALIDATION_KEY_SECRET = 'a'.repeat(32) + 'extra-padding-for-safety';
  });
  afterAll(() => {
    if (origSecret !== undefined) process.env.VALIDATION_KEY_SECRET = origSecret;
    else delete process.env.VALIDATION_KEY_SECRET;
  });

  it('正确 key 通过', () => {
    const plain = 'mySecretKey123';
    const encrypted = encryptValidationKey(plain);
    expect(verifyValidationKey(plain, encrypted)).toBe(true);
  });

  it('错误 key 拒绝（等长但内容不同，走 timingSafeEqual 路径）', () => {
    const plain = 'mySecretKey123';
    const encrypted = encryptValidationKey(plain);
    expect(verifyValidationKey('mySecretKey124', encrypted)).toBe(false);
  });

  it('常量时间比较（不等长直接 false，不抛错）', () => {
    const encrypted = encryptValidationKey('mySecretKey123');
    expect(verifyValidationKey('short', encrypted)).toBe(false);
  });

  it('长度不同的错误 key 不走 catch 分支（logger.warn 不被调用）', () => {
    loggerMock.warn.mockClear();
    const encrypted = encryptValidationKey('mySecretKey123');
    // 长度不等提前 return false，不应触发解密失败的 warn
    expect(verifyValidationKey('a-much-longer-wrong-key', encrypted)).toBe(false);
    expect(loggerMock.warn).not.toHaveBeenCalled();
  });

  it('解密失败（非法密文）返回 false 并记录 warn', () => {
    loggerMock.warn.mockClear();
    expect(verifyValidationKey('anything', 'not-a-valid-ciphertext')).toBe(false);
    expect(loggerMock.warn).toHaveBeenCalledTimes(1);
    expect(loggerMock.warn).toHaveBeenCalledWith(
      'validationKey 解密失败',
      expect.objectContaining({ error: expect.any(String) }),
    );
  });
});
