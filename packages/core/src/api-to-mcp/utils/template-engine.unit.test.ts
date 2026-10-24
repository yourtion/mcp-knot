/**
 * 模板引擎测试
 */

import { describe, expect, it } from 'vitest';

import { TemplateEngineImpl } from './template-engine.js';

import type { TemplateContext } from '../types/template.js';

describe('TemplateEngineImpl', () => {
  const templateEngine = new TemplateEngineImpl();

  describe('render', () => {
    it('应该正确替换简单的数据变量', () => {
      const template = 'Hello {{data.name}}!';
      const context: TemplateContext = {
        data: { name: 'World' },
        env: {},
      };

      const result = templateEngine.render(template, context);

      expect(result.success).toBe(true);
      expect(result.result).toBe('Hello World!');
      expect(result.usedVariables).toEqual(['data.name']);
      expect(result.error).toBeUndefined();
    });

    it('应该正确替换嵌套对象属性', () => {
      const template = 'User: {{data.user.name}}, Age: {{data.user.age}}';
      const context: TemplateContext = {
        data: {
          user: {
            name: 'Alice',
            age: 30,
          },
        },
        env: {},
      };

      const result = templateEngine.render(template, context);

      expect(result.success).toBe(true);
      expect(result.result).toBe('User: Alice, Age: 30');
      expect(result.usedVariables).toEqual(['data.user.name', 'data.user.age']);
    });

    it('应该正确替换环境变量', () => {
      const template = 'API Key: {{env.API_KEY}}';
      const context: TemplateContext = {
        data: {},
        env: { API_KEY: 'secret-key-123' },
      };

      const result = templateEngine.render(template, context);

      expect(result.success).toBe(true);
      expect(result.result).toBe('API Key: secret-key-123');
      expect(result.usedVariables).toEqual(['env.API_KEY']);
    });

    it('应该处理多个相同变量', () => {
      const template = '{{data.name}} says hello to {{data.name}}';
      const context: TemplateContext = {
        data: { name: 'Bob' },
        env: {},
      };

      const result = templateEngine.render(template, context);

      expect(result.success).toBe(true);
      expect(result.result).toBe('Bob says hello to Bob');
      expect(result.usedVariables).toEqual(['data.name', 'data.name']);
    });

    it('应该处理不存在的变量', () => {
      const template = 'Hello {{data.missing}}!';
      const context: TemplateContext = {
        data: {},
        env: {},
      };

      const result = templateEngine.render(template, context);

      expect(result.success).toBe(false);
      expect(result.result).toBe('Hello {{data.missing}}!');
      expect(result.error).toBe('未找到变量: data.missing');
      expect(result.usedVariables).toEqual(['data.missing']);
    });

    it('应该处理深层嵌套的不存在属性', () => {
      const template = 'Value: {{data.user.profile.avatar}}';
      const context: TemplateContext = {
        data: {
          user: {
            name: 'Alice',
          },
        },
        env: {},
      };

      const result = templateEngine.render(template, context);

      expect(result.success).toBe(false);
      expect(result.result).toBe('Value: {{data.user.profile.avatar}}');
      expect(result.error).toBe('未找到变量: data.user.profile.avatar');
    });

    it('应该处理null和undefined值', () => {
      const template = 'Null: {{data.nullValue}}, Undefined: {{data.undefinedValue}}';
      const context: TemplateContext = {
        data: {
          nullValue: null,
          undefinedValue: undefined,
        },
        env: {},
      };

      const result = templateEngine.render(template, context);

      expect(result.success).toBe(false);
      expect(result.result).toBe('Null: null, Undefined: {{data.undefinedValue}}');
      expect(result.error).toBe('未找到变量: data.undefinedValue');
    });

    it('应该将非字符串值转换为字符串', () => {
      const template = 'Number: {{data.count}}, Boolean: {{data.active}}';
      const context: TemplateContext = {
        data: {
          count: 42,
          active: true,
        },
        env: {},
      };

      const result = templateEngine.render(template, context);

      expect(result.success).toBe(true);
      expect(result.result).toBe('Number: 42, Boolean: true');
    });

    it('应该处理空模板', () => {
      const template = '';
      const context: TemplateContext = {
        data: {},
        env: {},
      };

      const result = templateEngine.render(template, context);

      expect(result.success).toBe(true);
      expect(result.result).toBe('');
      expect(result.usedVariables).toEqual([]);
    });

    it('应该处理没有变量的模板', () => {
      const template = 'This is a static template';
      const context: TemplateContext = {
        data: {},
        env: {},
      };

      const result = templateEngine.render(template, context);

      expect(result.success).toBe(true);
      expect(result.result).toBe('This is a static template');
      expect(result.usedVariables).toEqual([]);
    });

    it('应该对占位符内的空白做 trim 后解析变量', () => {
      const result = templateEngine.render('Hello {{ data.name }}!', {
        data: { name: 'World' },
        env: {},
      });

      expect(result.success).toBe(true);
      expect(result.result).toBe('Hello World!');
      expect(result.usedVariables).toEqual(['data.name']);
    });

    it('缺少命名空间前缀的变量应渲染失败', () => {
      const result = templateEngine.render('{{data}}', { data: { a: 1 }, env: {} });

      expect(result.success).toBe(false);
      expect(result.error).toBe('未找到变量: data');
      expect(result.result).toBe('{{data}}');
    });

    it('未知命名空间应渲染失败', () => {
      const result = templateEngine.render('{{invalid.variable}}', { data: {}, env: {} });

      expect(result.success).toBe(false);
      expect(result.error).toBe('未找到变量: invalid.variable');
    });

    it('路径中途遇到原始类型应渲染失败', () => {
      const result = templateEngine.render('{{data.user.name}}', {
        data: { user: 'Alice' },
        env: {},
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe('未找到变量: data.user.name');
    });

    it('原始字符串的内置属性不应被解析为变量', () => {
      const result = templateEngine.render('{{data.s.length}}', { data: { s: 'str' }, env: {} });

      expect(result.success).toBe(false);
      expect(result.error).toBe('未找到变量: data.s.length');
    });

    it('路径中途遇到 null 应渲染失败而不是抛错', () => {
      const result = templateEngine.render('{{data.a.b}}', { data: { a: null }, env: {} });

      expect(result.success).toBe(false);
      expect(result.error).toBe('未找到变量: data.a.b');
    });

    it('变量值转字符串抛出 Error 时应返回该错误消息', () => {
      const poisoned = {
        toString: () => {
          throw new Error('boom');
        },
      };
      const result = templateEngine.render('{{data.a}}', { data: { a: poisoned }, env: {} });

      expect(result.success).toBe(false);
      expect(result.error).toBe('boom');
    });

    it('变量值转字符串抛出非 Error 时应返回兜底消息', () => {
      const poisoned = {
        toString: () => {
          // 抛出非 Error 对象（String 包装对象）以覆盖非 Error 分支
          throw new String('字符串错误');
        },
      };
      const result = templateEngine.render('{{data.a}}', { data: { a: poisoned }, env: {} });

      expect(result.success).toBe(false);
      expect(result.error).toBe('模板渲染失败');
    });
  });

  describe('validateTemplate', () => {
    it('应该验证有效的模板', () => {
      const template = 'Hello {{data.name}} from {{env.LOCATION}}!';
      const result = templateEngine.validateTemplate(template);

      expect(result.valid).toBe(true);
      expect(result.errors).toEqual([]);
    });

    it('应该验证嵌套属性访问', () => {
      const template = 'User: {{data.user.profile.name}}';
      const result = templateEngine.validateTemplate(template);

      expect(result.valid).toBe(true);
      expect(result.errors).toEqual([]);
    });

    it('应该拒绝无效的命名空间', () => {
      const template = 'Invalid: {{invalid.variable}}';
      const result = templateEngine.validateTemplate(template);

      expect(result.valid).toBe(false);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].code).toBe('INVALID_VARIABLE_PATH');
      expect(result.errors[0].path).toBe('invalid.variable');
      expect(result.errors[0].message).toBe('无效的变量路径: invalid.variable');
    });

    it('非字符串模板应返回 TEMPLATE_SYNTAX_ERROR', () => {
      const result = templateEngine.validateTemplate(null as unknown as string);

      expect(result.valid).toBe(false);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].path).toBe('template');
      expect(result.errors[0].code).toBe('TEMPLATE_SYNTAX_ERROR');
      expect(result.errors[0].message).toBeTypeOf('string');
      expect(result.errors[0].message).not.toBe('');
    });

    it('提取变量抛出非 Error 时应返回兜底消息', () => {
      const fakeTemplate = {
        matchAll: () => {
          // 抛出非 Error 对象（String 包装对象）以覆盖非 Error 分支
          throw new String('不是 Error');
        },
      };
      const result = templateEngine.validateTemplate(fakeTemplate as unknown as string);

      expect(result.valid).toBe(false);
      expect(result.errors[0].code).toBe('TEMPLATE_SYNTAX_ERROR');
      expect(result.errors[0].message).toBe('模板语法错误');
    });

    it('应该拒绝无效的属性名', () => {
      const template = 'Invalid: {{data.123invalid}}';
      const result = templateEngine.validateTemplate(template);

      expect(result.valid).toBe(false);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].code).toBe('INVALID_VARIABLE_PATH');
    });

    it('应该拒绝缺少属性的变量', () => {
      const template = 'Invalid: {{data}}';
      const result = templateEngine.validateTemplate(template);

      expect(result.valid).toBe(false);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].code).toBe('INVALID_VARIABLE_PATH');
    });

    it('应该处理包含特殊字符的属性名', () => {
      const template = 'Invalid: {{data.prop-with-dash}}';
      const result = templateEngine.validateTemplate(template);

      expect(result.valid).toBe(false);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].code).toBe('INVALID_VARIABLE_PATH');
    });

    it('应该允许下划线在属性名中', () => {
      const template = 'Valid: {{data.prop_with_underscore}}';
      const result = templateEngine.validateTemplate(template);

      expect(result.valid).toBe(true);
      expect(result.errors).toEqual([]);
    });
  });

  describe('extractVariables', () => {
    it('应该提取所有变量', () => {
      const template = 'Hello {{data.name}} from {{env.LOCATION}} at {{data.time}}!';
      const variables = templateEngine.extractVariables(template);

      expect(variables).toHaveLength(3);
      expect(variables[0]).toEqual({
        name: 'data.name',
        path: 'data.name',
        required: true,
      });
      expect(variables[1]).toEqual({
        name: 'env.LOCATION',
        path: 'env.LOCATION',
        required: true,
      });
      expect(variables[2]).toEqual({
        name: 'data.time',
        path: 'data.time',
        required: true,
      });
    });

    it('应该处理重复的变量', () => {
      const template = '{{data.name}} and {{data.name}} again';
      const variables = templateEngine.extractVariables(template);

      expect(variables).toHaveLength(2);
      expect(variables[0].name).toBe('data.name');
      expect(variables[1].name).toBe('data.name');
    });

    it('应该处理没有变量的模板', () => {
      const template = 'No variables here';
      const variables = templateEngine.extractVariables(template);

      expect(variables).toEqual([]);
    });

    it('应该处理空模板', () => {
      const template = '';
      const variables = templateEngine.extractVariables(template);

      expect(variables).toEqual([]);
    });

    it('应该处理嵌套属性', () => {
      const template = 'Deep: {{data.user.profile.settings.theme}}';
      const variables = templateEngine.extractVariables(template);

      expect(variables).toHaveLength(1);
      expect(variables[0]).toEqual({
        name: 'data.user.profile.settings.theme',
        path: 'data.user.profile.settings.theme',
        required: true,
      });
    });

    it('应该忽略格式错误的占位符', () => {
      const template = 'Valid: {{data.name}} Invalid: {data.name} {{data.name';
      const variables = templateEngine.extractVariables(template);

      expect(variables).toHaveLength(1);
      expect(variables[0].name).toBe('data.name');
    });

    it('应该 trim 占位符内的空白', () => {
      const variables = templateEngine.extractVariables('Hello {{ data.name }}!');

      expect(variables).toHaveLength(1);
      expect(variables[0]).toEqual({
        name: 'data.name',
        path: 'data.name',
        required: true,
      });
    });
  });
});
