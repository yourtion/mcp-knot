import { describe, expect, it } from 'vitest';

import {
  assessKeyComplexity,
  calculateEntropy,
  generateSecurityRecommendations,
  validateKeyFormat,
} from './key-policy.js';

describe('key-policy', () => {
  describe('assessKeyComplexity（安全属性验证，非输出固化）', () => {
    it('已知弱密钥绝不应被评为 strong', () => {
      const knownWeak = [
        'password',
        'admin',
        '12345678',
        'qwerty',
        'aaaa1111',
        'password123',
        'abc123',
      ];
      for (const weak of knownWeak) {
        expect(assessKeyComplexity(weak), `"${weak}" should not be strong`).not.toBe('strong');
      }
    });

    it('强随机密钥绝不应被评为 weak', () => {
      const knownStrong = ['Xk9$mP2!vQ7#nL4@wR8', 'Zx9!Qp3#Mk7$vB5nYc2D', 'aB3$dE6&gH9*kJ2@mN5'];
      for (const strong of knownStrong) {
        const result = assessKeyComplexity(strong);
        expect(result, `"${strong}" should not be weak`).not.toBe('weak');
      }
    });

    it('评分应单调递增：更长 + 更多字符类型 = 更高复杂度', () => {
      const short = assessKeyComplexity('ab12');
      const medium = assessKeyComplexity('Abc123def456');
      const long = assessKeyComplexity('Abc123def456!@#XYZ');

      // 不是严格排序，但弱→中→强的趋势应成立
      const scoreMap = { weak: 0, medium: 1, strong: 2 };
      expect(scoreMap[short]).toBeLessThanOrEqual(scoreMap[medium]);
      expect(scoreMap[medium]).toBeLessThanOrEqual(scoreMap[long]);
    });
  });

  describe('calculateEntropy', () => {
    it('空字符串熵为 0', () => {
      expect(calculateEntropy('')).toBe(0);
    });

    it('纯数字密钥熵低于混合字符密钥', () => {
      const numEntropy = calculateEntropy('1234567890');
      const mixedEntropy = calculateEntropy('Abc123!@#XyZ');
      expect(mixedEntropy).toBeGreaterThan(numEntropy);
    });

    it('熵随长度增加而增加', () => {
      const short = calculateEntropy('Ab1');
      const long = calculateEntropy('Ab1Ab1Ab1Ab1');
      expect(long).toBeGreaterThan(short);
    });
  });

  describe('validateKeyFormat（规则验证）', () => {
    it('空密钥被拒绝', () => {
      expect(validateKeyFormat('').isValid).toBe(false);
    });

    it('短于 8 字符被拒绝', () => {
      const result = validateKeyFormat('ab1');
      expect(result.isValid).toBe(false);
      expect(result.error).toContain('8');
    });

    it('超过 128 字符被拒绝', () => {
      const result = validateKeyFormat('a'.repeat(129) + '1');
      expect(result.isValid).toBe(false);
      expect(result.error).toContain('128');
    });

    it('纯字母被拒绝（需含数字）', () => {
      const result = validateKeyFormat('onlyletters');
      expect(result.isValid).toBe(false);
    });

    it('纯数字被拒绝（需含字母）', () => {
      const result = validateKeyFormat('12345678');
      expect(result.isValid).toBe(false);
    });

    it('字母+数字的组合被接受', () => {
      expect(validateKeyFormat('validKey123').isValid).toBe(true);
    });

    it('边界值：恰好 8 字符的有效密钥被接受', () => {
      expect(validateKeyFormat('abcd1234').isValid).toBe(true);
    });
  });

  describe('generateSecurityRecommendations', () => {
    it('弱密钥产生多条建议', () => {
      expect(generateSecurityRecommendations('weak').length).toBeGreaterThanOrEqual(3);
    });

    it('缺少大写字母时给出对应建议', () => {
      const recs = generateSecurityRecommendations('lowercase123');
      expect(recs.some((r) => r.includes('大写'))).toBe(true);
    });

    it('缺少特殊字符时给出对应建议', () => {
      const recs = generateSecurityRecommendations('NoSpecial123');
      expect(recs.some((r) => r.includes('特殊字符'))).toBe(true);
    });

    it('不含弱模式的强密钥产生零建议', () => {
      const recs = generateSecurityRecommendations('Zx9!Qp3#Mk7$vB5n');
      expect(recs).toHaveLength(0);
    });
  });

  describe('assessKeyComplexity（评分边界精确断言）', () => {
    it('长度分档：16 字符得 2 分、12 字符得 1 分、不足 12 得 0 分', () => {
      // 16 小写：2 + 1(lower) = 3 → medium；若长度按 >16 判定只剩 1 分 → weak
      expect(assessKeyComplexity('qazwsxedcrfvtgbyh')).toBe('medium');
      // 12 小写+数字：1 + 1 + 1 = 3 → medium；若长度按 >12 判定只剩 2 分 → weak
      expect(assessKeyComplexity('a1b2c3d4e5f6')).toBe('medium');
      // 11 小写无数字：0 + 1 = 1 → weak
      expect(assessKeyComplexity('qazwsxedcrfv')).toBe('weak');
    });

    it('字符类型加分：单一类型小写/大写/数字密钥不升档', () => {
      // 无小写：1(upper) + 1(numbers) = 2 → weak；若把缺失类型误判存在则升为 medium
      expect(assessKeyComplexity('A1B2C3D4E5F6')).toBe('medium');
      // 12 大写+数字+特殊：1 + 1 + 2 + 1(长度) = 5 → medium；任一类型误判再 +1 → strong
      expect(assessKeyComplexity('A1!B2#C3$D4%')).toBe('medium');
      expect(assessKeyComplexity('a1!b2#c3$d4%')).toBe('medium');
      expect(assessKeyComplexity('aA!bB#cC$dD%')).toBe('medium');
      // 12 小写+大写+数字（无特殊）：1+1+1+1 = 4 → medium；若特殊字符误判 → 6 → strong
      expect(assessKeyComplexity('aA1bB2cC3dD4')).toBe('medium');
      // 12 小写+特殊（无数字）：1+1+2 = 4 → medium；若去掉特殊加分只剩 2 → weak
      expect(assessKeyComplexity('q!z&w#e$r%t^y&')).toBe('medium');
    });

    it('三连重复字符扣 1 分', () => {
      // 12 小写+数字（1+1+1）扣 1 → 2 → weak；若不扣分则 3 → medium
      expect(assessKeyComplexity('a1b2ccc3d4e5')).toBe('weak');
      // 双连不算重复：3 → medium；若误判双连扣 1 → 2 → weak
      expect(assessKeyComplexity('aa1bb2cc3dd4')).toBe('medium');
    });

    it('连续序列扣 1 分', () => {
      // 12 小写+数字含 "123"：3 - 1 = 2 → weak；若不扣分则 3 → medium
      expect(assessKeyComplexity('a1b2c123d4e5')).toBe('weak');
    });

    it('常见弱词扣 2 分', () => {
      // lower+numbers+special = 4，扣 2 → 2 → weak
      expect(assessKeyComplexity('password1!')).toBe('weak');
    });

    it('恰好 6 分评为 strong，恰好 3 分评为 medium', () => {
      // 16 长度(2) + lower(1) + upper(1) + special(2) = 6 → strong
      expect(assessKeyComplexity('aA!bB#cC$dD%eE^fF')).toBe('strong');
      // 12 长度(1) + lower(1) + numbers(1) = 3 → medium
      expect(assessKeyComplexity('a1b2c3d4e5f6')).toBe('medium');
    });
  });

  describe('calculateEntropy（精确数值断言）', () => {
    it('按字符集大小计算熵：仅小写 26、仅数字 10、仅特殊 32', () => {
      expect(calculateEntropy('aaaa')).toBe(18.8);
      expect(calculateEntropy('AAAA')).toBe(18.8);
      expect(calculateEntropy('1111')).toBe(13.29);
      expect(calculateEntropy('!!!!')).toBe(20);
    });

    it('四类字符齐全时字符集为 94', () => {
      expect(calculateEntropy('aA1!')).toBe(26.22);
    });

    it('空字符串熵为 0', () => {
      expect(calculateEntropy('')).toBe(0);
    });
  });

  describe('generateSecurityRecommendations（精确建议列表）', () => {
    it('弱密钥产生完整的固定建议序列', () => {
      expect(generateSecurityRecommendations('weak')).toEqual([
        '使用大小写字母、数字和特殊字符的组合',
        '避免使用常见词汇或重复字符',
        '建议使用至少16个字符的长度',
        '增加密钥长度至至少16个字符',
        '添加大写字母',
        '添加数字',
        '添加特殊字符',
      ]);
    });

    it('含连续序列的弱密钥追加避免连续字符建议', () => {
      const recs = generateSecurityRecommendations('abc123');
      expect(recs).toEqual([
        '使用大小写字母、数字和特殊字符的组合',
        '避免使用常见词汇或重复字符',
        '建议使用至少16个字符的长度',
        '增加密钥长度至至少16个字符',
        '添加大写字母',
        '添加特殊字符',
        '避免连续字符',
      ]);
    });

    it('缺少小写字母时建议添加小写字母', () => {
      const recs = generateSecurityRecommendations('LOWERCASE123');
      expect(recs).toContain('添加小写字母');
    });

    it('含三连重复字符时建议避免重复字符', () => {
      const recs = generateSecurityRecommendations('aaa1');
      expect(recs).toContain('避免重复字符');
    });

    it('无数字密钥建议添加数字', () => {
      const recs = generateSecurityRecommendations('abc');
      expect(recs).toContain('添加数字');
    });
  });

  describe('validateKeyFormat（精确错误消息与边界）', () => {
    it('空密钥返回精确错误', () => {
      expect(validateKeyFormat('')).toEqual({ isValid: false, error: '密钥不能为空' });
    });

    it('长度恰为 128 的合法密钥被接受', () => {
      expect(validateKeyFormat('a'.repeat(127) + '1')).toEqual({ isValid: true });
    });

    it('缺字母或缺数字返回精确错误', () => {
      expect(validateKeyFormat('12345678')).toEqual({
        isValid: false,
        error: '密钥必须包含字母和数字',
      });
    });
  });
});
