/**
 * zod-schema-converter 转换逻辑测试
 * 通过生成的 zod schema 的 safeParse 行为验证转换正确性
 */
import { describe, expect, it } from 'vitest';

import { convertToZodSchema } from './zod-schema-converter.js';

describe('convertToZodSchema', () => {
  describe('非法输入', () => {
    it('null 入参返回空对象', () => {
      expect(convertToZodSchema(null)).toEqual({});
    });

    it('undefined 入参返回空对象', () => {
      expect(convertToZodSchema(undefined)).toEqual({});
    });

    it('字符串入参返回空对象', () => {
      expect(convertToZodSchema('not-a-schema')).toEqual({});
    });

    it('数字入参返回空对象', () => {
      expect(convertToZodSchema(42)).toEqual({});
    });

    it('缺少 properties 的对象返回空对象', () => {
      expect(convertToZodSchema({ required: ['name'] })).toEqual({});
    });

    it('properties 为空对象时返回空对象', () => {
      expect(convertToZodSchema({ properties: {} })).toEqual({});
    });
  });

  describe('基本类型转换', () => {
    it('string 类型接受字符串并拒绝数字', () => {
      const schema = convertToZodSchema({
        properties: { name: { type: 'string' } },
        required: ['name'],
      });
      expect(schema.name!.safeParse('hello').success).toBe(true);
      expect(schema.name!.safeParse(123).success).toBe(false);
    });

    it('number 类型接受数字并拒绝字符串', () => {
      const schema = convertToZodSchema({
        properties: { port: { type: 'number' } },
        required: ['port'],
      });
      expect(schema.port!.safeParse(8080).success).toBe(true);
      expect(schema.port!.safeParse(3.14).success).toBe(true);
      expect(schema.port!.safeParse('8080').success).toBe(false);
    });

    it('boolean 类型接受布尔值并拒绝其他类型', () => {
      const schema = convertToZodSchema({
        properties: { enabled: { type: 'boolean' } },
        required: ['enabled'],
      });
      expect(schema.enabled!.safeParse(true).success).toBe(true);
      expect(schema.enabled!.safeParse(false).success).toBe(true);
      expect(schema.enabled!.safeParse('true').success).toBe(false);
    });

    it('object 类型只接受对象', () => {
      const schema = convertToZodSchema({
        properties: { config: { type: 'object' } },
        required: ['config'],
      });
      expect(schema.config!.safeParse({ any: 'thing' }).success).toBe(true);
      expect(schema.config!.safeParse('string').success).toBe(false);
      expect(schema.config!.safeParse([1, 2]).success).toBe(false);
    });

    it('array 类型只接受数组', () => {
      const schema = convertToZodSchema({
        properties: { items: { type: 'array' } },
        required: ['items'],
      });
      expect(schema.items!.safeParse([1, 'a', null]).success).toBe(true);
      expect(schema.items!.safeParse('not-array').success).toBe(false);
      expect(schema.items!.safeParse({}).success).toBe(false);
    });

    it('未知类型回退为 unknown（接受任意值）', () => {
      const schema = convertToZodSchema({
        properties: { anything: { type: 'complex' as never } },
        required: ['anything'],
      });
      expect(schema.anything!.safeParse('text').success).toBe(true);
      expect(schema.anything!.safeParse(123).success).toBe(true);
      expect(schema.anything!.safeParse({ a: 1 }).success).toBe(true);
    });
  });

  describe('描述字段', () => {
    it('description 会写入生成的 schema', () => {
      const schema = convertToZodSchema({
        properties: { color: { type: 'string', description: '颜色值' } },
        // 必填属性不会被 .optional() 包装，描述可直接从 schema 读取
        required: ['color'],
      });
      expect(schema.color!.description).toBe('颜色值');
    });

    it('无 description 时不设置描述', () => {
      const schema = convertToZodSchema({
        properties: { color: { type: 'string' } },
      });
      expect(schema.color!.description).toBeUndefined();
    });
  });

  describe('枚举字段', () => {
    it('enum 限定取值范围', () => {
      const schema = convertToZodSchema({
        properties: { level: { type: 'string', enum: ['low', 'high'] } },
        required: ['level'],
      });
      expect(schema.level!.safeParse('low').success).toBe(true);
      expect(schema.level!.safeParse('high').success).toBe(true);
      expect(schema.level!.safeParse('middle').success).toBe(false);
    });

    it('空 enum 数组不启用枚举（退回基本类型）', () => {
      const schema = convertToZodSchema({
        properties: { level: { type: 'string', enum: [] } },
        required: ['level'],
      });
      // 空枚举仍按 string 校验
      expect(schema.level!.safeParse('any-value').success).toBe(true);
    });
  });

  describe('可选性', () => {
    it('出现在 required 中的属性为必填', () => {
      const schema = convertToZodSchema({
        properties: { name: { type: 'string' } },
        required: ['name'],
      });
      expect(schema.name!.safeParse(undefined).success).toBe(false);
    });

    it('不在 required 中的属性为可选', () => {
      const schema = convertToZodSchema({
        properties: { name: { type: 'string' }, age: { type: 'number' } },
        required: ['name'],
      });
      expect(schema.age!.safeParse(undefined).success).toBe(true);
    });

    it('缺少 required 字段时所有属性均为可选', () => {
      const schema = convertToZodSchema({
        properties: { name: { type: 'string' } },
      });
      expect(schema.name!.safeParse(undefined).success).toBe(true);
    });

    it('required 数组为空时所有属性均为可选', () => {
      const schema = convertToZodSchema({
        properties: { name: { type: 'string' } },
        required: [],
      });
      expect(schema.name!.safeParse(undefined).success).toBe(true);
    });
  });

  describe('多属性组合', () => {
    it('保留所有属性名并分别转换', () => {
      const schema = convertToZodSchema({
        properties: {
          name: { type: 'string' },
          count: { type: 'number' },
          tags: { type: 'array' },
        },
        required: ['name'],
      });
      expect(Object.keys(schema).sort()).toEqual(['count', 'name', 'tags']);
      expect(schema.name!.safeParse('x').success).toBe(true);
      expect(schema.count!.safeParse(1).success).toBe(true);
      expect(schema.tags!.safeParse([]).success).toBe(true);
    });
  });
});
