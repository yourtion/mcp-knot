/**
 * 参数验证器测试
 */

import { describe, expect, it } from 'vitest';

import { ParameterValidatorImpl } from './parameter-validator.js';

import type { JsonSchema } from '../types/api-config.js';

describe('ParameterValidatorImpl', () => {
  const validator = new ParameterValidatorImpl();

  describe('validate', () => {
    it('应该验证简单的字符串参数', () => {
      const schema: JsonSchema = {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: '用户名',
          },
        },
        required: ['name'],
      };

      const parameters = { name: 'Alice' };
      const result = validator.validate(parameters, schema);

      expect(result.valid).toBe(true);
      expect(result.errors).toEqual([]);
      expect(result.data).toEqual({ name: 'Alice' });
    });

    it('应该验证数字参数', () => {
      const schema: JsonSchema = {
        type: 'object',
        properties: {
          age: {
            type: 'number',
            minimum: 0,
            maximum: 150,
          },
        },
        required: ['age'],
      };

      const parameters = { age: 25 };
      const result = validator.validate(parameters, schema);

      expect(result.valid).toBe(true);
      expect(result.errors).toEqual([]);
      expect(result.data).toEqual({ age: 25 });
    });

    it('应该验证布尔参数', () => {
      const schema: JsonSchema = {
        type: 'object',
        properties: {
          active: {
            type: 'boolean',
          },
        },
      };

      const parameters = { active: true };
      const result = validator.validate(parameters, schema);

      expect(result.valid).toBe(true);
      expect(result.errors).toEqual([]);
      expect(result.data).toEqual({ active: true });
    });

    it('应该验证数组参数', () => {
      const schema: JsonSchema = {
        type: 'object',
        properties: {
          tags: {
            type: 'array',
            items: {
              type: 'string',
            },
            minItems: 1,
            maxItems: 5,
          },
        },
      };

      const parameters = { tags: ['tag1', 'tag2'] };
      const result = validator.validate(parameters, schema);

      expect(result.valid).toBe(true);
      expect(result.errors).toEqual([]);
      expect(result.data).toEqual({ tags: ['tag1', 'tag2'] });
    });

    it('应该验证嵌套对象参数', () => {
      const schema: JsonSchema = {
        type: 'object',
        properties: {
          user: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              age: { type: 'number' },
            },
            required: ['name'],
          },
        },
      };

      const parameters = {
        user: {
          name: 'Bob',
          age: 30,
        },
      };
      const result = validator.validate(parameters, schema);

      expect(result.valid).toBe(true);
      expect(result.errors).toEqual([]);
      expect(result.data).toEqual(parameters);
    });

    it('应该拒绝非对象参数', () => {
      const schema: JsonSchema = {
        type: 'object',
        properties: {},
      };

      const result = validator.validate('not an object', schema);

      expect(result.valid).toBe(false);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].code).toBe('INVALID_TYPE');
      expect(result.errors[0].path).toBe('root');
    });

    it('应该检查必需字段', () => {
      const schema: JsonSchema = {
        type: 'object',
        properties: {
          name: { type: 'string' },
          email: { type: 'string' },
        },
        required: ['name', 'email'],
      };

      const parameters = { name: 'Alice' };
      const result = validator.validate(parameters, schema);

      expect(result.valid).toBe(false);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].code).toBe('REQUIRED_FIELD_MISSING');
      expect(result.errors[0].path).toBe('email');
    });

    it('应该应用默认值', () => {
      const schema: JsonSchema = {
        type: 'object',
        properties: {
          name: { type: 'string' },
          active: { type: 'boolean', default: true },
          count: { type: 'number', default: 0 },
        },
        required: ['name'],
      };

      const parameters = { name: 'Alice' };
      const result = validator.validate(parameters, schema);

      expect(result.valid).toBe(true);
      expect(result.data).toEqual({
        name: 'Alice',
        active: true,
        count: 0,
      });
    });

    it('应该处理额外属性', () => {
      const schema: JsonSchema = {
        type: 'object',
        properties: {
          name: { type: 'string' },
        },
        additionalProperties: false,
      };

      const parameters = { name: 'Alice', extra: 'value' };
      const result = validator.validate(parameters, schema);

      expect(result.valid).toBe(false);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].code).toBe('ADDITIONAL_PROPERTY_NOT_ALLOWED');
      expect(result.errors[0].path).toBe('extra');
    });

    it('应该移除额外属性（当选项启用时）', () => {
      const schema: JsonSchema = {
        type: 'object',
        properties: {
          name: { type: 'string' },
        },
      };

      const parameters = { name: 'Alice', extra: 'value' };
      const result = validator.validate(parameters, schema, {
        removeAdditionalProperties: true,
      });

      expect(result.valid).toBe(true);
      expect(result.data).toEqual({ name: 'Alice' });
    });

    it('strict 选项应拒绝额外属性', () => {
      const schema: JsonSchema = {
        type: 'object',
        properties: {
          name: { type: 'string' },
        },
      };

      const result = validator.validate({ name: 'Alice', extra: 1 }, schema, { strict: true });

      expect(result.valid).toBe(false);
      expect(result.errors[0].code).toBe('ADDITIONAL_PROPERTY_NOT_ALLOWED');
      expect(result.errors[0].path).toBe('extra');
      expect(result.errors[0].message).toBe('不允许的额外属性: extra');
    });

    it('applyDefaults 关闭时不应填充默认值', () => {
      const schema: JsonSchema = {
        type: 'object',
        properties: {
          name: { type: 'string' },
          count: { type: 'number', default: 42 },
        },
      };

      const result = validator.validate({ name: 'Alice' }, schema, { applyDefaults: false });

      expect(result.valid).toBe(true);
      expect(result.data).toEqual({ name: 'Alice' });
    });

    it('null 参数应返回 INVALID_TYPE 且不包含 data', () => {
      const schema: JsonSchema = { type: 'object', properties: {} };
      const result = validator.validate(null, schema);

      expect(result.valid).toBe(false);
      expect(result.errors).toEqual([
        { path: 'root', message: '参数必须是一个对象', code: 'INVALID_TYPE' },
      ]);
      expect(result.data).toBeUndefined();
    });

    it('非必需字段的 null 值应返回 NULL_NOT_ALLOWED', () => {
      const schema: JsonSchema = {
        type: 'object',
        properties: {
          name: { type: 'string' },
        },
      };

      const result = validator.validate({ name: null }, schema);

      expect(result.valid).toBe(false);
      expect(result.errors).toEqual([
        { path: 'name', message: "字段 'name' 不能为null", code: 'NULL_NOT_ALLOWED' },
      ]);
    });

    it('type 为 null 时应允许 null 值', () => {
      const schema: JsonSchema = {
        type: 'object',
        properties: {
          value: { type: 'null' },
        },
      };

      const result = validator.validate({ value: null }, schema);

      expect(result.valid).toBe(true);
      expect(result.errors).toEqual([]);
    });

    it('undefined 值且非必需时不应报错', () => {
      const schema: JsonSchema = {
        type: 'object',
        properties: {
          name: { type: 'string' },
        },
      };

      const result = validator.validate({ name: undefined }, schema);

      expect(result.valid).toBe(true);
      expect(result.errors).toEqual([]);
    });

    it('必需字段缺失的错误信息应包含字段名', () => {
      const schema: JsonSchema = {
        type: 'object',
        properties: { email: { type: 'string' } },
        required: ['email'],
      };

      const result = validator.validate({}, schema);

      expect(result.errors[0].message).toBe("必需字段 'email' 缺失或为空");
    });

    it('类型不匹配的错误信息应包含期望与实际类型', () => {
      const schema: JsonSchema = {
        type: 'object',
        properties: { age: { type: 'number' } },
      };

      const result = validator.validate({ age: 'thirty' }, schema);

      expect(result.errors[0].message).toBe("字段 'age' 期望类型为 number，实际类型为 string");
    });

    it('数组值应被识别为 array 类型而非 object', () => {
      const schema: JsonSchema = {
        type: 'object',
        properties: { tags: { type: 'array', items: { type: 'string' } } },
      };

      const result = validator.validate({ tags: 'not-array' }, schema);

      expect(result.valid).toBe(false);
      expect(result.errors[0].code).toBe('TYPE_MISMATCH');
      expect(result.errors[0].message).toBe("字段 'tags' 期望类型为 array，实际类型为 string");
    });
  });

  describe('字符串验证', () => {
    it('应该验证字符串长度', () => {
      const schema: JsonSchema = {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            minLength: 2,
            maxLength: 10,
          },
        },
      };

      // 太短
      let result = validator.validate({ name: 'A' }, schema);
      expect(result.valid).toBe(false);
      expect(result.errors[0].code).toBe('MIN_LENGTH_VIOLATION');

      // 太长
      result = validator.validate({ name: 'This is too long' }, schema);
      expect(result.valid).toBe(false);
      expect(result.errors[0].code).toBe('MAX_LENGTH_VIOLATION');

      // 正确长度
      result = validator.validate({ name: 'Alice' }, schema);
      expect(result.valid).toBe(true);
    });

    it('应该验证字符串模式', () => {
      const schema: JsonSchema = {
        type: 'object',
        properties: {
          code: {
            type: 'string',
            pattern: '^[A-Z]{2}\\d{3}$',
          },
        },
      };

      // 无效模式
      let result = validator.validate({ code: 'abc123' }, schema);
      expect(result.valid).toBe(false);
      expect(result.errors[0].code).toBe('PATTERN_MISMATCH');
      expect(result.errors[0].message).toBe("字段 'code' 不匹配模式 ^[A-Z]{2}\\d{3}$");

      // 有效模式
      result = validator.validate({ code: 'AB123' }, schema);
      expect(result.valid).toBe(true);
    });

    it('无效的正则表达式模式应返回 INVALID_PATTERN', () => {
      const schema: JsonSchema = {
        type: 'object',
        properties: {
          code: { type: 'string', pattern: '[invalid' },
        },
      };

      const result = validator.validate({ code: 'anything' }, schema);

      expect(result.valid).toBe(false);
      expect(result.errors[0].code).toBe('INVALID_PATTERN');
      expect(result.errors[0].message).toBe("字段 'code' 的正则表达式模式无效");
    });

    it('长度边界值应通过验证', () => {
      const schema: JsonSchema = {
        type: 'object',
        properties: { name: { type: 'string', minLength: 2, maxLength: 4 } },
      };

      expect(validator.validate({ name: 'ab' }, schema).valid).toBe(true);
      expect(validator.validate({ name: 'abcd' }, schema).valid).toBe(true);
      expect(validator.validate({ name: 'a' }, schema).errors[0].message).toBe(
        "字段 'name' 长度不能少于 2 个字符",
      );
      expect(validator.validate({ name: 'abcde' }, schema).errors[0].message).toBe(
        "字段 'name' 长度不能超过 4 个字符",
      );
    });

    it('应该验证邮箱格式', () => {
      const schema: JsonSchema = {
        type: 'object',
        properties: {
          email: {
            type: 'string',
            format: 'email',
          },
        },
      };

      // 无效邮箱
      let result = validator.validate({ email: 'invalid-email' }, schema);
      expect(result.valid).toBe(false);
      expect(result.errors[0].code).toBe('INVALID_EMAIL_FORMAT');
      expect(result.errors[0].message).toBe("字段 'email' 不是有效的邮箱地址");

      // 缺少顶级域段的邮箱同样无效
      result = validator.validate({ email: 'user@domain' }, schema);
      expect(result.valid).toBe(false);
      expect(result.errors[0].code).toBe('INVALID_EMAIL_FORMAT');

      // 有效邮箱
      result = validator.validate({ email: 'user@example.com' }, schema);
      expect(result.valid).toBe(true);
    });

    it('应该验证URL格式', () => {
      const schema: JsonSchema = {
        type: 'object',
        properties: {
          website: {
            type: 'string',
            format: 'url',
          },
        },
      };

      // 无效URL
      let result = validator.validate({ website: 'not-a-url' }, schema);
      expect(result.valid).toBe(false);
      expect(result.errors[0].code).toBe('INVALID_URL_FORMAT');
      expect(result.errors[0].message).toBe("字段 'website' 不是有效的URL");

      // 有效URL
      result = validator.validate({ website: 'https://example.com' }, schema);
      expect(result.valid).toBe(true);
    });

    it('uri 与 url 格式应等效验证', () => {
      const schema: JsonSchema = {
        type: 'object',
        properties: { endpoint: { type: 'string', format: 'uri' } },
      };

      expect(validator.validate({ endpoint: 'ftp://files.example.com' }, schema).valid).toBe(true);
      expect(validator.validate({ endpoint: 'no-schema-host' }, schema).errors[0].code).toBe(
        'INVALID_URL_FORMAT',
      );
    });

    it('应该验证日期格式', () => {
      const schema: JsonSchema = {
        type: 'object',
        properties: {
          birthDate: {
            type: 'string',
            format: 'date',
          },
        },
      };

      // 无效日期
      let result = validator.validate({ birthDate: '2023-13-01' }, schema);
      expect(result.valid).toBe(false);
      expect(result.errors[0].code).toBe('INVALID_DATE_FORMAT');
      expect(result.errors[0].message).toBe("字段 'birthDate' 不是有效的日期格式 (YYYY-MM-DD)");

      // 有效日期
      result = validator.validate({ birthDate: '2023-12-01' }, schema);
      expect(result.valid).toBe(true);
    });

    it('不符合 YYYY-MM-DD 格式的日期应无效', () => {
      const schema: JsonSchema = {
        type: 'object',
        properties: { d: { type: 'string', format: 'date' } },
      };

      expect(validator.validate({ d: '2023/12/01' }, schema).errors[0].code).toBe(
        'INVALID_DATE_FORMAT',
      );
      expect(validator.validate({ d: '2023-12-1' }, schema).errors[0].code).toBe(
        'INVALID_DATE_FORMAT',
      );
    });

    it('被解析器自动修正的日期应无效', () => {
      const schema: JsonSchema = {
        type: 'object',
        properties: { d: { type: 'string', format: 'date' } },
      };

      // 2023-02-30 会被 Date 自动修正为 2023-03-02，应判定为无效
      const result = validator.validate({ d: '2023-02-30' }, schema);

      expect(result.valid).toBe(false);
      expect(result.errors[0].code).toBe('INVALID_DATE_FORMAT');
    });

    it('应该验证 ISO 8601 日期时间格式', () => {
      const schema: JsonSchema = {
        type: 'object',
        properties: { at: { type: 'string', format: 'date-time' } },
      };

      const valid = validator.validate({ at: '2023-12-01T10:30:00.000Z' }, schema);
      expect(valid.valid).toBe(true);

      const invalid = validator.validate({ at: '2023-12-01 10:30:00' }, schema);
      expect(invalid.valid).toBe(false);
      expect(invalid.errors[0].code).toBe('INVALID_DATETIME_FORMAT');
      expect(invalid.errors[0].message).toBe("字段 'at' 不是有效的日期时间格式 (ISO 8601)");
    });
  });

  describe('数字验证', () => {
    it('应该验证数字范围', () => {
      const schema: JsonSchema = {
        type: 'object',
        properties: {
          score: {
            type: 'number',
            minimum: 0,
            maximum: 100,
          },
        },
      };

      // 小于最小值
      let result = validator.validate({ score: -1 }, schema);
      expect(result.valid).toBe(false);
      expect(result.errors[0].code).toBe('MINIMUM_VIOLATION');
      expect(result.errors[0].message).toBe("字段 'score' 的值不能小于 0");

      // 大于最大值
      result = validator.validate({ score: 101 }, schema);
      expect(result.valid).toBe(false);
      expect(result.errors[0].code).toBe('MAXIMUM_VIOLATION');
      expect(result.errors[0].message).toBe("字段 'score' 的值不能大于 100");

      // 在范围内
      result = validator.validate({ score: 85 }, schema);
      expect(result.valid).toBe(true);
    });

    it('边界值应通过验证', () => {
      const schema: JsonSchema = {
        type: 'object',
        properties: { score: { type: 'number', minimum: 0, maximum: 100 } },
      };

      expect(validator.validate({ score: 0 }, schema).valid).toBe(true);
      expect(validator.validate({ score: 100 }, schema).valid).toBe(true);
    });
  });

  describe('数组验证', () => {
    it('应该验证数组长度', () => {
      const schema: JsonSchema = {
        type: 'object',
        properties: {
          items: {
            type: 'array',
            items: { type: 'string' },
            minItems: 1,
            maxItems: 3,
          },
        },
      };

      // 太少元素
      let result = validator.validate({ items: [] }, schema);
      expect(result.valid).toBe(false);
      expect(result.errors[0].code).toBe('MIN_ITEMS_VIOLATION');

      // 太多元素
      result = validator.validate({ items: ['a', 'b', 'c', 'd'] }, schema);
      expect(result.valid).toBe(false);
      expect(result.errors[0].code).toBe('MAX_ITEMS_VIOLATION');

      // 正确数量
      result = validator.validate({ items: ['a', 'b'] }, schema);
      expect(result.valid).toBe(true);
    });

    it('应该验证数组元素类型', () => {
      const schema: JsonSchema = {
        type: 'object',
        properties: {
          numbers: {
            type: 'array',
            items: { type: 'number' },
          },
        },
      };

      // 错误的元素类型
      const result = validator.validate({ numbers: [1, 'two', 3] }, schema);
      expect(result.valid).toBe(false);
      expect(result.errors[0].code).toBe('TYPE_MISMATCH');
      expect(result.errors[0].path).toBe('numbers[1]');
    });

    it('数组长度边界值应通过验证', () => {
      const schema: JsonSchema = {
        type: 'object',
        properties: {
          items: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 3 },
        },
      };

      expect(validator.validate({ items: ['a'] }, schema).valid).toBe(true);
      expect(validator.validate({ items: ['a', 'b', 'c'] }, schema).valid).toBe(true);
      expect(validator.validate({ items: [] }, schema).errors[0].message).toBe(
        "数组 'items' 的元素数量不能少于 1",
      );
      expect(validator.validate({ items: ['a', 'b', 'c', 'd'] }, schema).errors[0].message).toBe(
        "数组 'items' 的元素数量不能超过 3",
      );
    });

    it('应该验证数组元素的字符串约束', () => {
      const schema: JsonSchema = {
        type: 'object',
        properties: {
          tags: { type: 'array', items: { type: 'string', minLength: 2 } },
        },
      };

      const result = validator.validate({ tags: ['ok', 'x'] }, schema);

      expect(result.valid).toBe(false);
      expect(result.errors[0].code).toBe('MIN_LENGTH_VIOLATION');
      expect(result.errors[0].path).toBe('tags[1]');
    });
  });

  describe('嵌套对象验证', () => {
    it('应该验证嵌套对象属性的类型', () => {
      const schema: JsonSchema = {
        type: 'object',
        properties: {
          user: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              age: { type: 'number' },
            },
          },
        },
      };

      const result = validator.validate({ user: { name: 'Bob', age: 'thirty' } }, schema);

      expect(result.valid).toBe(false);
      expect(result.errors).toEqual([
        {
          path: 'user.age',
          message: "字段 'user.age' 期望类型为 number，实际类型为 string",
          code: 'TYPE_MISMATCH',
        },
      ]);
    });

    it('应该检查嵌套对象的必需属性', () => {
      const schema: JsonSchema = {
        type: 'object',
        properties: {
          user: {
            type: 'object',
            properties: { name: { type: 'string' } },
            required: ['name'],
          },
        },
      };

      const result = validator.validate({ user: {} }, schema);

      expect(result.valid).toBe(false);
      expect(result.errors).toEqual([
        {
          path: 'user.name',
          message: "对象 'user' 缺少必需属性 'name'",
          code: 'REQUIRED_PROPERTY_MISSING',
        },
      ]);
    });

    it('嵌套对象 null 必需属性应同时报null与缺失错误', () => {
      const schema: JsonSchema = {
        type: 'object',
        properties: {
          user: {
            type: 'object',
            properties: { name: { type: 'string' } },
            required: ['name'],
          },
        },
      };

      const result = validator.validate({ user: { name: null } }, schema);

      expect(result.valid).toBe(false);
      expect(result.errors).toHaveLength(2);
      expect(result.errors[0].code).toBe('NULL_NOT_ALLOWED');
      expect(result.errors[1].code).toBe('REQUIRED_PROPERTY_MISSING');
      expect(result.errors[1].path).toBe('user.name');
    });

    it('嵌套对象禁用额外属性时应报错', () => {
      const schema: JsonSchema = {
        type: 'object',
        properties: {
          user: {
            type: 'object',
            properties: { name: { type: 'string' } },
            additionalProperties: false,
          },
        },
      };

      const result = validator.validate({ user: { name: 'Bob', extra: 1 } }, schema);

      expect(result.valid).toBe(false);
      expect(result.errors).toEqual([
        {
          path: 'user.extra',
          message: "对象 'user' 不允许额外属性 'extra'",
          code: 'ADDITIONAL_PROPERTY_NOT_ALLOWED',
        },
      ]);
    });

    it('嵌套对象未定义 properties 时不验证属性', () => {
      const schema: JsonSchema = {
        type: 'object',
        properties: {
          meta: { type: 'object' },
        },
      };

      const result = validator.validate({ meta: { anything: 'goes' } }, schema);

      expect(result.valid).toBe(true);
      expect(result.errors).toEqual([]);
    });
  });

  describe('枚举验证', () => {
    it('应该验证枚举值', () => {
      const schema: JsonSchema = {
        type: 'object',
        properties: {
          status: {
            type: 'string',
            enum: ['active', 'inactive', 'pending'],
          },
        },
      };

      // 无效枚举值
      let result = validator.validate({ status: 'unknown' }, schema);
      expect(result.valid).toBe(false);
      expect(result.errors[0].code).toBe('ENUM_VALIDATION_FAILED');
      expect(result.errors[0].message).toBe(
        "字段 'status' 的值必须是以下之一: active, inactive, pending",
      );

      // 有效枚举值
      result = validator.validate({ status: 'active' }, schema);
      expect(result.valid).toBe(true);
    });

    it('应该支持非字符串枚举值', () => {
      const schema: JsonSchema = {
        type: 'object',
        properties: {
          level: { type: 'number', enum: [1, 2, 3] },
        },
      };

      expect(validator.validate({ level: 2 }, schema).valid).toBe(true);
      expect(validator.validate({ level: 5 }, schema).errors[0].code).toBe(
        'ENUM_VALIDATION_FAILED',
      );
    });
  });

  describe('类型验证', () => {
    it('应该验证类型不匹配', () => {
      const schema: JsonSchema = {
        type: 'object',
        properties: {
          name: { type: 'string' },
          age: { type: 'number' },
          active: { type: 'boolean' },
        },
      };

      const parameters = {
        name: 123, // 应该是字符串
        age: 'thirty', // 应该是数字
        active: 'yes', // 应该是布尔值
      };

      const result = validator.validate(parameters, schema);

      expect(result.valid).toBe(false);
      expect(result.errors).toHaveLength(3);
      expect(result.errors.every((e) => e.code === 'TYPE_MISMATCH')).toBe(true);
    });
  });

  describe('applyDefaults', () => {
    it('应该应用默认值', () => {
      const schema: JsonSchema = {
        type: 'object',
        properties: {
          name: { type: 'string' },
          active: { type: 'boolean', default: true },
          count: { type: 'number', default: 0 },
          tags: { type: 'array', default: [] },
        },
      };

      const parameters = { name: 'Alice' };
      const result = validator.applyDefaults(parameters, schema);

      expect(result).toEqual({
        name: 'Alice',
        active: true,
        count: 0,
        tags: [],
      });
    });

    it('不应该覆盖已存在的值', () => {
      const schema: JsonSchema = {
        type: 'object',
        properties: {
          active: { type: 'boolean', default: true },
          count: { type: 'number', default: 0 },
        },
      };

      const parameters = { active: false, count: 5 };
      const result = validator.applyDefaults(parameters, schema);

      expect(result).toEqual({
        active: false,
        count: 5,
      });
    });
  });

  describe('checkRequiredFields', () => {
    it('应该检查必需字段', () => {
      const schema: JsonSchema = {
        type: 'object',
        properties: {
          name: { type: 'string' },
          email: { type: 'string' },
          age: { type: 'number' },
        },
        required: ['name', 'email'],
      };

      const parameters = { name: 'Alice' };
      const errors = validator.checkRequiredFields(parameters, schema);

      expect(errors).toHaveLength(1);
      expect(errors[0].code).toBe('REQUIRED_FIELD_MISSING');
      expect(errors[0].path).toBe('email');
    });

    it('应该处理null值作为缺失字段', () => {
      const schema: JsonSchema = {
        type: 'object',
        properties: {
          name: { type: 'string' },
        },
        required: ['name'],
      };

      const parameters = { name: null };
      const errors = validator.checkRequiredFields(parameters, schema);

      expect(errors).toHaveLength(1);
      expect(errors[0].code).toBe('REQUIRED_FIELD_MISSING');
    });
  });
});
