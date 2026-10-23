/**
 * API工具生成器测试
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiToolGenerator } from './api-tool-generator.js';

import type { ApiToolConfig, JsonSchema, JsonSchemaProperty } from '../types/api-config.js';
import type { McpTool, ValidationResult } from '../types/api-tool.js';

// Mock logger
const loggerMocks = vi.hoisted(() => ({
  info: vi.fn(),
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock('../../utils/logger.js', () => ({
  createLogger: () => loggerMocks,
}));

/**
 * 创建基础ApiToolConfig的工厂函数
 */
function createBaseConfig(overrides: Partial<ApiToolConfig> = {}): ApiToolConfig {
  return {
    id: 'test-tool',
    name: '测试工具',
    description: '基础测试工具描述',
    api: {
      url: 'https://api.example.com/test',
      method: 'GET',
    },
    parameters: {
      type: 'object',
      properties: {},
    },
    response: {},
    ...overrides,
  };
}

/**
 * 创建基础McpTool的工厂函数
 */
function createBaseMcpTool(overrides: Partial<McpTool> = {}): McpTool {
  return {
    name: 'valid-tool',
    description: '有效的工具描述',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    ...overrides,
  };
}

describe('ApiToolGenerator', () => {
  let generator: ApiToolGenerator;

  beforeEach(() => {
    generator = new ApiToolGenerator();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // ========================================================
  // generateMcpTool 测试
  // ========================================================
  describe('generateMcpTool', () => {
    it('Generates valid McpTool from simple config', () => {
      const apiConfig = createBaseConfig();

      const mcpTool = generator.generateMcpTool(apiConfig);

      expect(mcpTool).toBeDefined();
      expect(mcpTool.name).toBe('test-tool');
      expect(mcpTool.description).toContain('基础测试工具描述');
      expect(mcpTool.inputSchema.type).toBe('object');
      expect(mcpTool.inputSchema.properties).toBeDefined();
    });

    it('Converts string property correctly', () => {
      const stringProp: JsonSchemaProperty = {
        type: 'string',
        description: '用户名',
        default: 'guest',
        minLength: 1,
        maxLength: 50,
        pattern: '^[a-z]+$',
      };
      const apiConfig = createBaseConfig({
        parameters: {
          type: 'object',
          properties: {
            username: stringProp,
          },
        },
      });

      const mcpTool = generator.generateMcpTool(apiConfig);

      const usernameProp = mcpTool.inputSchema.properties?.username as JsonSchemaProperty;
      expect(usernameProp).toEqual(stringProp);
      expect(usernameProp.type).toBe('string');
      expect(usernameProp.description).toBe('用户名');
      expect(usernameProp.default).toBe('guest');
      expect(usernameProp.minLength).toBe(1);
      expect(usernameProp.maxLength).toBe(50);
      expect(usernameProp.pattern).toBe('^[a-z]+$');
    });

    it('Converts number property correctly', () => {
      const numberProp: JsonSchemaProperty = {
        type: 'number',
        description: '年龄',
        minimum: 0,
        maximum: 150,
      };
      const apiConfig = createBaseConfig({
        parameters: {
          type: 'object',
          properties: {
            age: numberProp,
          },
        },
      });

      const mcpTool = generator.generateMcpTool(apiConfig);

      const ageProp = mcpTool.inputSchema.properties?.age as JsonSchemaProperty;
      expect(ageProp).toEqual(numberProp);
      expect(ageProp.type).toBe('number');
      expect(ageProp.minimum).toBe(0);
      expect(ageProp.maximum).toBe(150);
    });

    it('Converts boolean property correctly', () => {
      const boolProp: JsonSchemaProperty = {
        type: 'boolean',
        description: '是否启用',
        default: false,
      };
      const apiConfig = createBaseConfig({
        parameters: {
          type: 'object',
          properties: {
            enabled: boolProp,
          },
        },
      });

      const mcpTool = generator.generateMcpTool(apiConfig);

      const enabledProp = mcpTool.inputSchema.properties?.enabled as JsonSchemaProperty;
      expect(enabledProp).toEqual(boolProp);
      expect(enabledProp.type).toBe('boolean');
      expect(enabledProp.default).toBe(false);
    });

    it('Converts array property with items', () => {
      const arrayProp: JsonSchemaProperty = {
        type: 'array',
        description: '标签列表',
        items: {
          type: 'string',
          description: '单个标签',
        },
        minItems: 1,
        maxItems: 10,
      };
      const apiConfig = createBaseConfig({
        parameters: {
          type: 'object',
          properties: {
            tags: arrayProp,
          },
        },
      });

      const mcpTool = generator.generateMcpTool(apiConfig);

      const tagsProp = mcpTool.inputSchema.properties?.tags as JsonSchemaProperty;
      expect(tagsProp.type).toBe('array');
      expect(tagsProp.items).toEqual({ type: 'string', description: '单个标签' });
      expect(tagsProp.minItems).toBe(1);
      expect(tagsProp.maxItems).toBe(10);
    });

    it('Converts nested object property', () => {
      const objectProp: JsonSchemaProperty = {
        type: 'object',
        description: '地址信息',
        properties: {
          city: { type: 'string', description: '城市' },
          zip: { type: 'string', description: '邮编' },
        },
        required: ['city'],
        additionalProperties: false,
      };
      const apiConfig = createBaseConfig({
        parameters: {
          type: 'object',
          properties: {
            address: objectProp,
          },
        },
      });

      const mcpTool = generator.generateMcpTool(apiConfig);

      const addressProp = mcpTool.inputSchema.properties?.address as JsonSchemaProperty;
      expect(addressProp.type).toBe('object');
      expect(addressProp.properties).toEqual({
        city: { type: 'string', description: '城市' },
        zip: { type: 'string', description: '邮编' },
      });
      expect(addressProp.required).toEqual(['city']);
      expect(addressProp.additionalProperties).toBe(false);
    });

    it('Copies required fields', () => {
      const apiConfig = createBaseConfig({
        parameters: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            email: { type: 'string' },
          },
          required: ['name', 'email'],
        },
      });

      const mcpTool = generator.generateMcpTool(apiConfig);

      expect(mcpTool.inputSchema.required).toEqual(['name', 'email']);
    });

    it('Sets additionalProperties from config', () => {
      const apiConfigTrue = createBaseConfig({
        parameters: {
          type: 'object',
          properties: {},
          additionalProperties: true,
        },
      });
      const apiConfigFalse = createBaseConfig({
        parameters: {
          type: 'object',
          properties: {},
          additionalProperties: false,
        },
      });

      const toolTrue = generator.generateMcpTool(apiConfigTrue);
      const toolFalse = generator.generateMcpTool(apiConfigFalse);

      expect(toolTrue.inputSchema.additionalProperties).toBe(true);
      expect(toolFalse.inputSchema.additionalProperties).toBe(false);
    });

    it('Defaults additionalProperties to false when not specified', () => {
      const apiConfig = createBaseConfig({
        parameters: {
          type: 'object',
          properties: {},
        },
      });

      const mcpTool = generator.generateMcpTool(apiConfig);

      expect(mcpTool.inputSchema.additionalProperties).toBe(false);
    });

    it('Includes API endpoint info in description', () => {
      const apiConfig = createBaseConfig({
        api: {
          url: 'https://api.example.com/data',
          method: 'POST',
        },
      });

      const mcpTool = generator.generateMcpTool(apiConfig);

      expect(mcpTool.description).toContain('API端点: POST https://api.example.com/data');
    });

    it('Includes auth type in description when security configured', () => {
      const apiConfig = createBaseConfig({
        security: {
          authentication: {
            type: 'bearer',
            token: 'test-token',
          },
        },
      });

      const mcpTool = generator.generateMcpTool(apiConfig);

      expect(mcpTool.description).toContain('认证方式: BEARER');
    });

    it('Includes cache info in description when cache enabled', () => {
      const apiConfig = createBaseConfig({
        cache: {
          enabled: true,
          ttl: 300,
        },
      });

      const mcpTool = generator.generateMcpTool(apiConfig);

      expect(mcpTool.description).toContain('缓存: 启用 (TTL: 300秒)');
    });

    it('Does not include cache info when cache disabled', () => {
      const apiConfig = createBaseConfig({
        cache: {
          enabled: false,
          ttl: 300,
        },
      });

      const mcpTool = generator.generateMcpTool(apiConfig);

      expect(mcpTool.description).not.toContain('缓存');
    });

    it('Throws on error during generation', () => {
      // Create a config that will cause convertToMcpInputSchema to fail
      // by making properties non-iterable via a getter that throws
      const throwingSchema: JsonSchema = {
        type: 'object',
        get properties(): Record<string, JsonSchemaProperty> {
          throw new Error('Properties access failed');
        },
      };
      const apiConfig = createBaseConfig({
        parameters: throwingSchema,
      });

      expect(() => generator.generateMcpTool(apiConfig)).toThrow(
        "生成工具 'test-tool' 的MCP定义失败: Properties access failed",
      );
    });

    it('Preserves original error as cause when throwing', () => {
      const originalError = new Error('Properties access failed');
      const throwingSchema: JsonSchema = {
        type: 'object',
        get properties(): Record<string, JsonSchemaProperty> {
          throw originalError;
        },
      };
      const apiConfig = createBaseConfig({
        parameters: throwingSchema,
      });

      try {
        generator.generateMcpTool(apiConfig);
        expect.unreachable('Should have thrown');
      } catch (error) {
        const thrownError = error as Error & { context?: { cause?: unknown } };
        // ServiceError stores the original error message in context.cause
        expect(thrownError.context?.cause).toBe(originalError.message);
      }
    });

    it('Converts enum property correctly', () => {
      const enumProp: JsonSchemaProperty = {
        type: 'string',
        description: '颜色',
        enum: ['red', 'green', 'blue'],
      };
      const apiConfig = createBaseConfig({
        parameters: {
          type: 'object',
          properties: {
            color: enumProp,
          },
        },
      });

      const mcpTool = generator.generateMcpTool(apiConfig);

      const colorProp = mcpTool.inputSchema.properties?.color as JsonSchemaProperty;
      expect(colorProp.enum).toEqual(['red', 'green', 'blue']);
    });

    it('Converts format property correctly', () => {
      const formatProp: JsonSchemaProperty = {
        type: 'string',
        description: '邮箱',
        format: 'email',
      };
      const apiConfig = createBaseConfig({
        parameters: {
          type: 'object',
          properties: {
            email: formatProp,
          },
        },
      });

      const mcpTool = generator.generateMcpTool(apiConfig);

      const emailProp = mcpTool.inputSchema.properties?.email as JsonSchemaProperty;
      expect(emailProp.format).toBe('email');
    });

    it('Converts null type property correctly', () => {
      const nullProp: JsonSchemaProperty = {
        type: 'null',
        description: '空值',
      };
      const apiConfig = createBaseConfig({
        parameters: {
          type: 'object',
          properties: {
            nothing: nullProp,
          },
        },
      });

      const mcpTool = generator.generateMcpTool(apiConfig);

      const nothingProp = mcpTool.inputSchema.properties?.nothing as JsonSchemaProperty;
      expect(nothingProp.type).toBe('null');
    });

    it('Handles deeply nested object properties', () => {
      const apiConfig = createBaseConfig({
        parameters: {
          type: 'object',
          properties: {
            level1: {
              type: 'object',
              properties: {
                level2: {
                  type: 'object',
                  properties: {
                    value: { type: 'string', description: '深层值' },
                  },
                },
              },
            },
          },
        },
      });

      const mcpTool = generator.generateMcpTool(apiConfig);

      const level1 = mcpTool.inputSchema.properties?.level1 as JsonSchemaProperty;
      const level2 = level1.properties?.level2 as JsonSchemaProperty;
      const value = level2.properties?.value as JsonSchemaProperty;
      expect(value.type).toBe('string');
      expect(value.description).toBe('深层值');
    });

    it('Handles array of objects correctly', () => {
      const apiConfig = createBaseConfig({
        parameters: {
          type: 'object',
          properties: {
            users: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  name: { type: 'string' },
                  age: { type: 'number' },
                },
                required: ['name'],
              },
            },
          },
        },
      });

      const mcpTool = generator.generateMcpTool(apiConfig);

      const usersProp = mcpTool.inputSchema.properties?.users as JsonSchemaProperty;
      expect(usersProp.type).toBe('array');
      expect(usersProp.items?.type).toBe('object');
      expect(usersProp.items?.properties?.name).toEqual({ type: 'string' });
      expect(usersProp.items?.required).toEqual(['name']);
    });
  });

  // ========================================================
  // validateGeneratedTool 测试
  // ========================================================
  describe('validateGeneratedTool', () => {
    it('Valid tool passes validation', () => {
      const tool = createBaseMcpTool();

      const result = generator.validateGeneratedTool(tool);

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('Valid tool with properties passes validation', () => {
      const tool = createBaseMcpTool({
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: '名称' },
            count: { type: 'number', minimum: 0, maximum: 100 },
          },
          required: ['name'],
          additionalProperties: false,
        },
      });

      const result = generator.validateGeneratedTool(tool);

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('Empty name fails validation', () => {
      const tool = createBaseMcpTool({ name: '' });

      const result = generator.validateGeneratedTool(tool);

      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual({
        path: 'name',
        message: '工具名称不能为空',
        code: 'INVALID_TOOL_NAME',
      });
    });

    it('Whitespace-only name fails validation', () => {
      const tool = createBaseMcpTool({ name: '   ' });

      const result = generator.validateGeneratedTool(tool);

      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual({
        path: 'name',
        message: '工具名称不能为空',
        code: 'INVALID_TOOL_NAME',
      });
    });

    it('Invalid name format (special chars) fails', () => {
      const tool = createBaseMcpTool({ name: 'invalid tool name!' });

      const result = generator.validateGeneratedTool(tool);

      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual({
        path: 'name',
        message: '工具名称只能包含字母、数字、下划线和连字符',
        code: 'INVALID_TOOL_NAME_FORMAT',
      });
    });

    it('Valid name with underscores and hyphens passes', () => {
      const tool = createBaseMcpTool({ name: 'my_valid-tool123' });

      const result = generator.validateGeneratedTool(tool);

      expect(result.valid).toBe(true);
    });

    it('Missing description fails validation', () => {
      const tool = createBaseMcpTool({ description: '' });

      const result = generator.validateGeneratedTool(tool);

      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual({
        path: 'description',
        message: '工具描述不能为空',
        code: 'INVALID_TOOL_DESCRIPTION',
      });
    });

    it('Missing inputSchema causes validation to throw', () => {
      const tool = createBaseMcpTool({
        inputSchema: undefined as unknown as McpTool['inputSchema'],
      });

      // validateGeneratedTool calls validateInputSchema which accesses inputSchema.type
      // without a null guard, so undefined inputSchema throws a TypeError
      expect(() => generator.validateGeneratedTool(tool)).toThrow(TypeError);
    });

    it('inputSchema with wrong type fails', () => {
      const tool = createBaseMcpTool({
        inputSchema: {
          type: 'string' as 'object',
          properties: {},
        },
      });

      const result = generator.validateGeneratedTool(tool);

      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual({
        path: 'inputSchema.type',
        message: 'MCP工具输入schema类型必须为object',
        code: 'INVALID_SCHEMA_TYPE',
      });
    });

    it('Reports required field missing from properties', () => {
      const tool = createBaseMcpTool({
        inputSchema: {
          type: 'object',
          properties: {
            existing: { type: 'string' },
          },
          required: ['existing', 'missing'],
          additionalProperties: false,
        },
      });

      const result = generator.validateGeneratedTool(tool);

      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual({
        path: 'inputSchema.required',
        message: "必需字段 'missing' 在properties中未定义",
        code: 'MISSING_REQUIRED_PROPERTY',
      });
    });

    it('Reports multiple required fields missing from properties', () => {
      const tool = createBaseMcpTool({
        inputSchema: {
          type: 'object',
          properties: {},
          required: ['field1', 'field2'],
          additionalProperties: false,
        },
      });

      const result = generator.validateGeneratedTool(tool);

      expect(result.valid).toBe(false);
      expect(result.errors).toHaveLength(2);
      expect(result.errors).toContainEqual({
        path: 'inputSchema.required',
        message: "必需字段 'field1' 在properties中未定义",
        code: 'MISSING_REQUIRED_PROPERTY',
      });
      expect(result.errors).toContainEqual({
        path: 'inputSchema.required',
        message: "必需字段 'field2' 在properties中未定义",
        code: 'MISSING_REQUIRED_PROPERTY',
      });
    });

    it('Invalid property type reported', () => {
      const tool = createBaseMcpTool({
        inputSchema: {
          type: 'object',
          properties: {
            badProp: { type: 'invalid' as 'string' },
          },
          additionalProperties: false,
        },
      });

      const result = generator.validateGeneratedTool(tool);

      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual({
        path: 'inputSchema.properties.badProp',
        message: '无效的属性类型: invalid',
        code: 'INVALID_PROPERTY_TYPE',
      });
    });

    it('Number range validation (min > max)', () => {
      const tool = createBaseMcpTool({
        inputSchema: {
          type: 'object',
          properties: {
            count: {
              type: 'number',
              minimum: 100,
              maximum: 50,
            },
          },
          additionalProperties: false,
        },
      });

      const result = generator.validateGeneratedTool(tool);

      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual({
        path: 'inputSchema.properties.count',
        message: '最小值不能大于最大值',
        code: 'INVALID_NUMBER_RANGE',
      });
    });

    it('Number range passes when min <= max', () => {
      const tool = createBaseMcpTool({
        inputSchema: {
          type: 'object',
          properties: {
            count: {
              type: 'number',
              minimum: 0,
              maximum: 100,
            },
          },
          additionalProperties: false,
        },
      });

      const result = generator.validateGeneratedTool(tool);

      expect(result.valid).toBe(true);
    });

    it('Number validation skipped when only minimum is set', () => {
      const tool = createBaseMcpTool({
        inputSchema: {
          type: 'object',
          properties: {
            count: {
              type: 'number',
              minimum: 50,
            },
          },
          additionalProperties: false,
        },
      });

      const result = generator.validateGeneratedTool(tool);

      expect(result.valid).toBe(true);
    });

    it('String length validation (minLength > maxLength)', () => {
      const tool = createBaseMcpTool({
        inputSchema: {
          type: 'object',
          properties: {
            name: {
              type: 'string',
              minLength: 100,
              maxLength: 10,
            },
          },
          additionalProperties: false,
        },
      });

      const result = generator.validateGeneratedTool(tool);

      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual({
        path: 'inputSchema.properties.name',
        message: '最小长度不能大于最大长度',
        code: 'INVALID_STRING_LENGTH_RANGE',
      });
    });

    it('String length passes when minLength <= maxLength', () => {
      const tool = createBaseMcpTool({
        inputSchema: {
          type: 'object',
          properties: {
            name: {
              type: 'string',
              minLength: 1,
              maxLength: 100,
            },
          },
          additionalProperties: false,
        },
      });

      const result = generator.validateGeneratedTool(tool);

      expect(result.valid).toBe(true);
    });

    it('Array size validation (minItems > maxItems)', () => {
      const tool = createBaseMcpTool({
        inputSchema: {
          type: 'object',
          properties: {
            items: {
              type: 'array',
              minItems: 10,
              maxItems: 3,
              items: { type: 'string' },
            },
          },
          additionalProperties: false,
        },
      });

      const result = generator.validateGeneratedTool(tool);

      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual({
        path: 'inputSchema.properties.items',
        message: '最小项目数不能大于最大项目数',
        code: 'INVALID_ARRAY_SIZE_RANGE',
      });
    });

    it('Array size passes when minItems <= maxItems', () => {
      const tool = createBaseMcpTool({
        inputSchema: {
          type: 'object',
          properties: {
            items: {
              type: 'array',
              minItems: 1,
              maxItems: 10,
              items: { type: 'string' },
            },
          },
          additionalProperties: false,
        },
      });

      const result = generator.validateGeneratedTool(tool);

      expect(result.valid).toBe(true);
    });

    it('Nested object validation', () => {
      const tool = createBaseMcpTool({
        inputSchema: {
          type: 'object',
          properties: {
            nested: {
              type: 'object',
              properties: {
                deepProp: { type: 'invalid' as 'string' },
              },
            },
          },
          additionalProperties: false,
        },
      });

      const result = generator.validateGeneratedTool(tool);

      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual({
        path: 'inputSchema.properties.nested.properties.deepProp',
        message: '无效的属性类型: invalid',
        code: 'INVALID_PROPERTY_TYPE',
      });
    });

    it('Nested array items validation', () => {
      const tool = createBaseMcpTool({
        inputSchema: {
          type: 'object',
          properties: {
            tags: {
              type: 'array',
              items: {
                type: 'invalid' as 'string',
              },
            },
          },
          additionalProperties: false,
        },
      });

      const result = generator.validateGeneratedTool(tool);

      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual({
        path: 'inputSchema.properties.tags.items',
        message: '无效的属性类型: invalid',
        code: 'INVALID_PROPERTY_TYPE',
      });
    });

    it('Deeply nested object validation reports errors at correct path', () => {
      const tool = createBaseMcpTool({
        inputSchema: {
          type: 'object',
          properties: {
            level1: {
              type: 'object',
              properties: {
                level2: {
                  type: 'array',
                  items: {
                    type: 'badtype' as 'string',
                  },
                },
              },
            },
          },
          additionalProperties: false,
        },
      });

      const result = generator.validateGeneratedTool(tool);

      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual({
        path: 'inputSchema.properties.level1.properties.level2.items',
        message: '无效的属性类型: badtype',
        code: 'INVALID_PROPERTY_TYPE',
      });
    });

    it('Collects multiple errors from different properties', () => {
      const tool = createBaseMcpTool({
        name: '',
        description: '',
        inputSchema: {
          type: 'string' as 'object',
          properties: {},
        },
      });

      const result = generator.validateGeneratedTool(tool);

      expect(result.valid).toBe(false);
      // Should have at least: empty name, empty description, wrong schema type
      expect(result.errors.length).toBeGreaterThanOrEqual(3);
    });

    it('Returns valid tool with no properties', () => {
      const tool = createBaseMcpTool({
        inputSchema: {
          type: 'object',
          additionalProperties: false,
        },
      });

      const result = generator.validateGeneratedTool(tool);

      expect(result.valid).toBe(true);
    });
  });

  // ========================================================
  // generateAllTools 测试
  // ========================================================
  describe('generateAllTools', () => {
    it('Generates all valid tools', () => {
      const configs: ApiToolConfig[] = [
        createBaseConfig({
          id: 'tool-1',
          name: '工具1',
          description: '第一个工具',
        }),
        createBaseConfig({
          id: 'tool-2',
          name: '工具2',
          description: '第二个工具',
        }),
        createBaseConfig({
          id: 'tool-3',
          name: '工具3',
          description: '第三个工具',
        }),
      ];

      const tools = generator.generateAllTools(configs);

      expect(tools).toHaveLength(3);
      expect(tools[0].name).toBe('tool-1');
      expect(tools[1].name).toBe('tool-2');
      expect(tools[2].name).toBe('tool-3');
    });

    it('Skips invalid tools (still returns valid ones)', () => {
      const configs: ApiToolConfig[] = [
        createBaseConfig({
          id: 'valid-tool',
          description: '有效工具',
        }),
        createBaseConfig({
          id: '', // Invalid: empty id becomes empty name in McpTool
          description: '无效工具',
        }),
        createBaseConfig({
          id: 'another-valid',
          description: '另一个有效工具',
        }),
      ];

      const tools = generator.generateAllTools(configs);

      expect(tools).toHaveLength(2);
      expect(tools[0].name).toBe('valid-tool');
      expect(tools[1].name).toBe('another-valid');
    });

    it('Returns empty array for empty input', () => {
      const tools = generator.generateAllTools([]);

      expect(tools).toEqual([]);
    });

    it('Handles all-failed batch', () => {
      const configs: ApiToolConfig[] = [
        createBaseConfig({
          id: '',
          description: '空ID工具',
        }),
        createBaseConfig({
          id: 'bad name!',
          description: '无效名称工具',
        }),
      ];

      const tools = generator.generateAllTools(configs);

      expect(tools).toHaveLength(0);
    });

    it('Handles config that throws during generation', () => {
      const throwingSchema: JsonSchema = {
        type: 'object',
        get properties(): Record<string, JsonSchemaProperty> {
          throw new Error('Schema error');
        },
      };
      const configs: ApiToolConfig[] = [
        createBaseConfig({
          id: 'throwing-tool',
          parameters: throwingSchema,
        }),
        createBaseConfig({
          id: 'valid-tool',
          description: '有效工具',
        }),
      ];

      const tools = generator.generateAllTools(configs);

      // throwing-tool should be skipped, valid-tool should succeed
      expect(tools).toHaveLength(1);
      expect(tools[0].name).toBe('valid-tool');
    });

    it('Preserves tool order from configs', () => {
      const configs: ApiToolConfig[] = [
        createBaseConfig({ id: 'alpha', description: 'Alpha' }),
        createBaseConfig({ id: 'beta', description: 'Beta' }),
        createBaseConfig({ id: 'gamma', description: 'Gamma' }),
      ];

      const tools = generator.generateAllTools(configs);

      const names = tools.map((t) => t.name);
      expect(names).toEqual(['alpha', 'beta', 'gamma']);
    });

    it('Each generated tool includes correct API endpoint info', () => {
      const configs: ApiToolConfig[] = [
        createBaseConfig({
          id: 'get-tool',
          api: { url: 'https://api.example.com/get', method: 'GET' },
        }),
        createBaseConfig({
          id: 'post-tool',
          api: { url: 'https://api.example.com/post', method: 'POST' },
        }),
      ];

      const tools = generator.generateAllTools(configs);

      expect(tools[0].description).toContain('GET https://api.example.com/get');
      expect(tools[1].description).toContain('POST https://api.example.com/post');
    });

    it('Validates each tool after generation', () => {
      // Create a config that generates a tool with valid name
      // but the tool validation should still be invoked
      const validConfig = createBaseConfig({
        id: 'my_valid-tool',
        description: '有效工具',
        parameters: {
          type: 'object',
          properties: {
            param1: { type: 'string' },
          },
          required: ['param1'],
        },
      });

      const tools = generator.generateAllTools([validConfig]);

      expect(tools).toHaveLength(1);
      expect(tools[0].inputSchema.required).toEqual(['param1']);
    });
  });

  // ========================================================
  // generateMcpTool + validateGeneratedTool 集成
  // ========================================================
  describe('integration: generateMcpTool + validateGeneratedTool', () => {
    it('Generated tool from valid config passes validation', () => {
      const apiConfig = createBaseConfig({
        id: 'integration-test',
        description: '集成测试工具',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: '查询' },
            limit: { type: 'number', minimum: 1, maximum: 100 },
          },
          required: ['query'],
        },
      });

      const tool = generator.generateMcpTool(apiConfig);
      const validation: ValidationResult = generator.validateGeneratedTool(tool);

      expect(validation.valid).toBe(true);
      expect(validation.errors).toHaveLength(0);
    });

    it('Generated tool from config with enum passes validation', () => {
      const apiConfig = createBaseConfig({
        id: 'enum-tool',
        parameters: {
          type: 'object',
          properties: {
            status: {
              type: 'string',
              enum: ['active', 'inactive'],
            },
          },
        },
      });

      const tool = generator.generateMcpTool(apiConfig);
      const validation = generator.validateGeneratedTool(tool);

      expect(validation.valid).toBe(true);
    });

    it('Tool properties are deep copies not references', () => {
      const originalProp: JsonSchemaProperty = {
        type: 'string',
        description: '原始描述',
        enum: ['a', 'b'],
      };
      const apiConfig = createBaseConfig({
        parameters: {
          type: 'object',
          properties: {
            field: originalProp,
          },
        },
      });

      const tool = generator.generateMcpTool(apiConfig);

      // Modify the returned enum
      const toolProp = tool.inputSchema.properties?.field as JsonSchemaProperty;
      toolProp.enum?.push('c');

      // Original should not be affected
      expect(originalProp.enum).toEqual(['a', 'b']);
    });
  });

  // ========================================================
  // 补强：schema 转换边界与默认值
  // ========================================================
  describe('schema 转换边界', () => {
    it('parameters 无 properties 字段 → 输出空 properties，不报错', () => {
      const apiConfig = createBaseConfig({
        parameters: { type: 'object' },
      });

      const mcpTool = generator.generateMcpTool(apiConfig);

      expect(mcpTool.inputSchema.properties).toEqual({});
      expect(mcpTool.inputSchema.required).toBeUndefined();
    });

    it('required 为空数组 → 不设置 required 字段', () => {
      const apiConfig = createBaseConfig({
        parameters: {
          type: 'object',
          properties: { name: { type: 'string' } },
          required: [],
        },
      });

      const mcpTool = generator.generateMcpTool(apiConfig);

      expect(mcpTool.inputSchema.required).toBeUndefined();
    });

    it('极简属性只保留 type，不引入未定义的可选字段', () => {
      const apiConfig = createBaseConfig({
        parameters: {
          type: 'object',
          properties: {
            bare: { type: 'string' },
          },
        },
      });

      const mcpTool = generator.generateMcpTool(apiConfig);

      expect(mcpTool.inputSchema.properties?.bare).toStrictEqual({ type: 'string' });
    });

    it('非 array/object 类型的属性不吞并 items/properties/required/additionalProperties', () => {
      const apiConfig = createBaseConfig({
        parameters: {
          type: 'object',
          properties: {
            mixed: {
              type: 'string',
              items: { type: 'number' },
              properties: { inner: { type: 'number' } },
              required: ['inner'],
              additionalProperties: true,
            },
          },
        },
      });

      const mcpTool = generator.generateMcpTool(apiConfig);

      expect(mcpTool.inputSchema.properties?.mixed).toStrictEqual({ type: 'string' });
    });

    it('描述按固定格式拼接 API 信息块', () => {
      const apiConfig = createBaseConfig();

      const mcpTool = generator.generateMcpTool(apiConfig);

      expect(mcpTool.description).toBe(
        '基础测试工具描述\n\nAPI端点: GET https://api.example.com/test',
      );
    });

    it('生成成功日志记录 hasParameters 标志（有/无参数两种情况）', () => {
      generator.generateMcpTool(createBaseConfig());
      expect(loggerMocks.debug).toHaveBeenCalledWith('MCP工具定义生成成功', {
        context: {
          toolId: 'test-tool',
          toolName: 'test-tool',
          hasParameters: false,
        },
      });

      vi.clearAllMocks();
      generator.generateMcpTool(
        createBaseConfig({
          parameters: {
            type: 'object',
            properties: { q: { type: 'string' } },
          },
        }),
      );
      expect(loggerMocks.debug).toHaveBeenCalledWith('MCP工具定义生成成功', {
        context: {
          toolId: 'test-tool',
          toolName: 'test-tool',
          hasParameters: true,
        },
      });
    });
  });

  // ========================================================
  // 补强：validateGeneratedTool 类型与边界
  // ========================================================
  describe('validateGeneratedTool 边界', () => {
    it('name 为非字符串（数字）→ 返回校验错误而非抛 TypeError', () => {
      const tool = createBaseMcpTool({ name: 123 as unknown as string });

      const result = generator.validateGeneratedTool(tool);

      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual({
        path: 'name',
        message: '工具名称不能为空',
        code: 'INVALID_TOOL_NAME',
      });
    });

    it('description 为非字符串 → 返回校验错误', () => {
      const tool = createBaseMcpTool({ description: 42 as unknown as string });

      const result = generator.validateGeneratedTool(tool);

      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual({
        path: 'description',
        message: '工具描述不能为空',
        code: 'INVALID_TOOL_DESCRIPTION',
      });
    });

    it('所有合法属性类型均通过校验', () => {
      const tool = createBaseMcpTool({
        inputSchema: {
          type: 'object',
          properties: {
            s: { type: 'string' },
            n: { type: 'number' },
            b: { type: 'boolean' },
            o: { type: 'object' },
            a: { type: 'array' },
            x: { type: 'null' },
          },
          additionalProperties: false,
        },
      });

      const result = generator.validateGeneratedTool(tool);

      expect(result.valid).toBe(true);
      expect(result.errors).toEqual([]);
    });

    it('required 引用的字段缺失且 properties 未定义 → 报缺失而非抛错', () => {
      const tool = createBaseMcpTool({
        inputSchema: {
          type: 'object',
          required: ['field'],
        } as McpTool['inputSchema'],
      });

      const result = generator.validateGeneratedTool(tool);

      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual({
        path: 'inputSchema.required',
        message: "必需字段 'field' 在properties中未定义",
        code: 'MISSING_REQUIRED_PROPERTY',
      });
    });

    it('number 边界：minimum === maximum 合法', () => {
      const result = generator.validateGeneratedTool(
        createBaseMcpTool({
          inputSchema: {
            type: 'object',
            properties: { count: { type: 'number', minimum: 10, maximum: 10 } },
            additionalProperties: false,
          },
        }),
      );
      expect(result.valid).toBe(true);
    });

    it('string 边界：minLength === maxLength 合法', () => {
      const result = generator.validateGeneratedTool(
        createBaseMcpTool({
          inputSchema: {
            type: 'object',
            properties: { code: { type: 'string', minLength: 4, maxLength: 4 } },
            additionalProperties: false,
          },
        }),
      );
      expect(result.valid).toBe(true);
    });

    it('array 边界：minItems === maxItems 合法', () => {
      const result = generator.validateGeneratedTool(
        createBaseMcpTool({
          inputSchema: {
            type: 'object',
            properties: { tags: { type: 'array', minItems: 2, maxItems: 2 } },
            additionalProperties: false,
          },
        }),
      );
      expect(result.valid).toBe(true);
    });

    it('约束不跨类型误报：非 number 属性带数值范围仍合法', () => {
      const result = generator.validateGeneratedTool(
        createBaseMcpTool({
          inputSchema: {
            type: 'object',
            properties: {
              s: { type: 'string', minimum: 100, maximum: 1 },
              b: { type: 'boolean', minLength: 100, maxLength: 1 },
              o: { type: 'object', minItems: 100, maxItems: 1 },
            },
            additionalProperties: false,
          },
        }),
      );
      expect(result.valid).toBe(true);
    });

    it('非 array 属性不递归校验 items；非 object 属性不递归校验子 properties', () => {
      const result = generator.validateGeneratedTool(
        createBaseMcpTool({
          inputSchema: {
            type: 'object',
            properties: {
              s1: { type: 'string', items: { type: 'not-a-type' } },
              s2: { type: 'string', properties: { bad: { type: 'not-a-type' } } },
            },
            additionalProperties: false,
          },
        }),
      );
      expect(result.valid).toBe(true);
      expect(result.errors).toEqual([]);
    });
  });

  // ========================================================
  // 补强：generateAllTools 日志与错误收集
  // ========================================================
  describe('generateAllTools 日志与错误收集', () => {
    it('全部成功 → 记录批量开始/完成日志，不触发失败告警', () => {
      const configs = [
        createBaseConfig({ id: 'a', description: 'A' }),
        createBaseConfig({ id: 'b', description: 'B' }),
      ];

      const tools = generator.generateAllTools(configs);

      expect(tools).toHaveLength(2);
      expect(loggerMocks.info).toHaveBeenCalledWith('批量生成MCP工具', {
        context: { configCount: 2 },
      });
      expect(loggerMocks.info).toHaveBeenCalledWith('批量工具生成完成', {
        context: { successCount: 2, errorCount: 0, totalCount: 2 },
      });
      expect(loggerMocks.warn).not.toHaveBeenCalled();
    });

    it('部分验证失败 → warn 错误明细包含具体校验消息', () => {
      const configs = [
        createBaseConfig({ id: 'bad name!', description: '无效名称' }),
        createBaseConfig({ id: 'good-tool', description: '有效' }),
      ];

      const tools = generator.generateAllTools(configs);

      expect(tools).toHaveLength(1);
      expect(loggerMocks.warn).toHaveBeenCalledWith('部分工具生成失败', {
        context: {
          errors: [
            {
              configId: 'bad name!',
              error: expect.stringContaining('工具名称只能包含字母、数字、下划线和连字符'),
            },
          ],
        },
      });
    });

    it('生成阶段抛错的配置 → 错误记入明细，不中断批次', () => {
      const throwingSchema: JsonSchema = {
        type: 'object',
        get properties(): Record<string, JsonSchemaProperty> {
          throw new Error('Schema error');
        },
      };
      const configs = [createBaseConfig({ id: 'throwing-tool', parameters: throwingSchema })];

      const tools = generator.generateAllTools(configs);

      expect(tools).toHaveLength(0);
      expect(loggerMocks.warn).toHaveBeenCalledWith('部分工具生成失败', {
        context: {
          errors: [{ configId: 'throwing-tool', error: expect.stringContaining('Schema error') }],
        },
      });
    });
  });
});
