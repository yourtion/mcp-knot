import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock logger：validator 的日志分支（unknown type / 缺参告警 / 校验异常）需断言
const loggerMock = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));
vi.mock('../utils/logger.js', () => ({ logger: loggerMock }));

import { validateArgumentType, validateToolArgsWithSchema } from './tool-arg-validator.js';

import type { Tool } from '../types/mcp-knot.js';

// 构造带 schema 的 Tool 对象
function makeTool(schema: Record<string, unknown>): Tool {
  return {
    name: 'test-tool',
    serverId: 'test-server',
    inputSchema: schema,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('validateArgumentType', () => {
  describe('类型匹配时通过', () => {
    const validCases: Array<{ type: string; value: unknown }> = [
      { type: 'string', value: 'hello' },
      { type: 'number', value: 42 },
      { type: 'number', value: 3.14 },
      { type: 'integer', value: 7 },
      { type: 'boolean', value: true },
      { type: 'boolean', value: false },
      { type: 'array', value: [1, 2, 3] },
      { type: 'object', value: { key: 'val' } },
    ];

    for (const { type, value } of validCases) {
      it(`${type} 类型正确值通过`, () => {
        const result = validateArgumentType('arg', value, { type });
        expect(result.isValid).toBe(true);
      });
    }
  });

  describe('类型不匹配时拒绝', () => {
    const invalidCases: Array<{ type: string; value: unknown; expectedActual: string }> = [
      { type: 'string', value: 42, expectedActual: 'number' },
      { type: 'string', value: true, expectedActual: 'boolean' },
      { type: 'number', value: 'not a number', expectedActual: 'string' },
      { type: 'number', value: true, expectedActual: 'boolean' },
      { type: 'integer', value: 3.14, expectedActual: 'number' },
      { type: 'integer', value: '7', expectedActual: 'string' },
      { type: 'boolean', value: 'true', expectedActual: 'string' },
      { type: 'boolean', value: 1, expectedActual: 'number' },
      { type: 'array', value: 'not array', expectedActual: 'string' },
      { type: 'array', value: { 0: 'a' }, expectedActual: 'object' },
      { type: 'object', value: null, expectedActual: 'object' },
      { type: 'object', value: [1, 2], expectedActual: 'object' },
      { type: 'object', value: 'string', expectedActual: 'string' },
    ];

    for (const { type, value, expectedActual } of invalidCases) {
      it(`${type} 拒绝 ${expectedActual} 值`, () => {
        const result = validateArgumentType('arg', value, { type });
        expect(result.isValid).toBe(false);
        expect(result.error).toContain('arg');
        expect(result.error).toContain(expectedActual);
      });
    }
  });

  it('NaN 不被接受为 number', () => {
    const result = validateArgumentType('arg', NaN, { type: 'number' });
    expect(result.isValid).toBe(false);
  });

  it('schema 中没有 type 字段时允许任何值', () => {
    expect(validateArgumentType('arg', 'anything', {}).isValid).toBe(true);
    expect(validateArgumentType('arg', 42, { description: 'no type' }).isValid).toBe(true);
  });

  it('schema 中没有 type 字段时提前返回（不走 default 分支、不记日志）', () => {
    expect(validateArgumentType('arg', 'anything', {}).isValid).toBe(true);
    expect(loggerMock.debug).not.toHaveBeenCalled();
  });

  it('未知类型允许通过（default 分支记录 debug 日志与上下文）', () => {
    const result = validateArgumentType('arg', 'value', { type: 'custom-unknown-type' });
    expect(result.isValid).toBe(true);
    expect(loggerMock.debug).toHaveBeenCalledWith('Unknown type in schema, allowing', {
      argName: 'arg',
      expectedType: 'custom-unknown-type',
    });
  });
});

describe('validateToolArgsWithSchema', () => {
  it('入口记录 debug 日志（工具名、参数与 schema）', () => {
    const tool = makeTool({ properties: {} });
    validateToolArgsWithSchema(tool, { a: 1 });
    expect(loggerMock.debug).toHaveBeenCalledWith('Validating tool arguments with schema', {
      toolName: 'test-tool',
      args: { a: 1 },
      schema: { properties: {} },
    });
  });

  describe('无 schema 时', () => {
    it('inputSchema 为空对象时允许所有参数', () => {
      const tool = makeTool({});
      expect(validateToolArgsWithSchema(tool, { anything: 1 }).isValid).toBe(true);
    });

    it('inputSchema 为 null 时允许所有参数', () => {
      const tool = makeTool(null as unknown as Record<string, unknown>);
      expect(validateToolArgsWithSchema(tool, { anything: 1 }).isValid).toBe(true);
    });

    it('inputSchema 为非对象真值（字符串）时允许所有参数并记录 debug', () => {
      const tool = makeTool('not-an-object' as unknown as Record<string, unknown>);
      const result = validateToolArgsWithSchema(tool, { anything: 1 });
      expect(result.isValid).toBe(true);
      expect(loggerMock.debug).toHaveBeenCalledWith('No schema provided, allowing all arguments', {
        toolName: 'test-tool',
      });
    });
  });

  describe('必填字段校验', () => {
    const tool = makeTool({
      type: 'object',
      properties: {
        name: { type: 'string' },
        count: { type: 'number' },
      },
      required: ['name', 'count'],
    });

    it('所有必填字段提供时通过', () => {
      expect(validateToolArgsWithSchema(tool, { name: 'test', count: 1 }).isValid).toBe(true);
    });

    it('缺少必填字段时拒绝', () => {
      const result = validateToolArgsWithSchema(tool, { name: 'test' });
      expect(result.isValid).toBe(false);
      expect(result.error).toContain('count');
      expect(result.error).toContain('Missing required');
    });

    it('必填字段为 null 时拒绝', () => {
      const result = validateToolArgsWithSchema(tool, { name: null, count: 1 });
      expect(result.isValid).toBe(false);
      expect(result.error).toContain('null');
    });

    it('必填字段为 undefined 时拒绝', () => {
      const result = validateToolArgsWithSchema(tool, { name: undefined, count: 1 });
      expect(result.isValid).toBe(false);
      expect(result.error).toContain('undefined');
    });

    it('required 为非数组真值（字符串）时不做必填校验', () => {
      const strRequiredTool = makeTool({
        type: 'object',
        properties: { name: { type: 'string' } },
        required: 'name' as unknown as string[],
      });
      // required 非数组 → 跳过必填检查（缺 name 也通过）
      expect(validateToolArgsWithSchema(strRequiredTool, {}).isValid).toBe(true);
    });

    it('缺少必填字段时记录 warn 日志（含已提供的参数键）', () => {
      validateToolArgsWithSchema(tool, { count: 1 });
      expect(loggerMock.warn).toHaveBeenCalledWith('Missing required argument', {
        toolName: 'test-tool',
        requiredField: 'name',
        providedArgs: ['count'],
      });
    });

    it('必填字段为 null 时记录 warn 日志', () => {
      validateToolArgsWithSchema(tool, { name: null, count: 1 });
      expect(loggerMock.warn).toHaveBeenCalledWith('Required argument is null/undefined', {
        toolName: 'test-tool',
        requiredField: 'name',
      });
    });
  });

  describe('类型校验', () => {
    const tool = makeTool({
      type: 'object',
      properties: {
        name: { type: 'string' },
        count: { type: 'number' },
      },
    });

    it('类型正确时通过', () => {
      expect(validateToolArgsWithSchema(tool, { name: 'ok', count: 5 }).isValid).toBe(true);
    });

    it('类型错误时拒绝并指出字段名', () => {
      const result = validateToolArgsWithSchema(tool, { name: 123 });
      expect(result.isValid).toBe(false);
      expect(result.error).toContain('name');
      expect(result.error).toContain('string');
    });

    it('类型错误时记录 warn 日志（含期望类型与错误信息）', () => {
      validateToolArgsWithSchema(tool, { name: 123 });
      expect(loggerMock.warn).toHaveBeenCalledWith(
        'Argument type validation failed',
        expect.objectContaining({
          toolName: 'test-tool',
          argName: 'name',
          expectedType: 'string',
        }),
      );
    });

    it('未在 properties 中声明的参数不校验类型（自由通过，无内部异常）', () => {
      expect(validateToolArgsWithSchema(tool, { extra: true }).isValid).toBe(true);
      // 未声明属性不应触发校验异常（logger.error 不被调用）
      expect(loggerMock.error).not.toHaveBeenCalled();
    });

    it('properties 缺失时跳过类型校验且不产生内部异常', () => {
      const noPropsTool = makeTool({ type: 'object', required: [] });
      expect(validateToolArgsWithSchema(noPropsTool, { a: 1 }).isValid).toBe(true);
      expect(loggerMock.error).not.toHaveBeenCalled();
    });
  });

  describe('additionalProperties: false', () => {
    const tool = makeTool({
      type: 'object',
      properties: {
        name: { type: 'string' },
      },
      additionalProperties: false,
    });

    it('只传声明过的属性时通过', () => {
      expect(validateToolArgsWithSchema(tool, { name: 'ok' }).isValid).toBe(true);
    });

    it('传了额外属性时拒绝并列出多余的属性名', () => {
      const result = validateToolArgsWithSchema(tool, { name: 'ok', extra: 1 });
      expect(result.isValid).toBe(false);
      expect(result.error).toContain('extra');
      expect(result.error).toContain('Additional properties');
    });

    it('传了额外属性时记录 warn 日志（含多余属性与允许属性列表）', () => {
      validateToolArgsWithSchema(tool, { name: 'ok', extra: 1 });
      expect(loggerMock.warn).toHaveBeenCalledWith('Additional properties provided', {
        toolName: 'test-tool',
        extraProps: ['extra'],
        allowedProps: ['name'],
      });
    });

    it('额外属性为空对象时不拒绝（additionalProperties 默认允许）', () => {
      const allowTool = makeTool({
        type: 'object',
        properties: { name: { type: 'string' } },
        // additionalProperties 未设置
      });
      expect(validateToolArgsWithSchema(allowTool, { name: 'ok', extra: 1 }).isValid).toBe(true);
    });
  });

  describe('综合场景', () => {
    it('完整有效调用通过所有校验', () => {
      const tool = makeTool({
        type: 'object',
        properties: {
          query: { type: 'string' },
          limit: { type: 'integer' },
          filters: { type: 'object' },
        },
        required: ['query'],
        additionalProperties: false,
      });

      const result = validateToolArgsWithSchema(tool, {
        query: 'search term',
        limit: 10,
        filters: { status: 'active' },
      });
      expect(result.isValid).toBe(true);
      // 校验通过时记录 success debug 日志
      expect(loggerMock.debug).toHaveBeenCalledWith('Tool arguments validation passed', {
        toolName: 'test-tool',
      });
    });

    it('同时违反多条规则时报告第一个遇到的错误', () => {
      const tool = makeTool({
        type: 'object',
        properties: {
          a: { type: 'string' },
        },
        required: ['a', 'b'],
        additionalProperties: false,
      });

      // 缺少必填 a 和 b，且传了额外字段 c
      const result = validateToolArgsWithSchema(tool, { c: 1 });
      expect(result.isValid).toBe(false);
      // required 检查按声明顺序，先报 a 缺失
      expect(result.error).toContain('a');
      expect(result.error).toContain('Missing required');
    });
  });

  describe('校验异常容错', () => {
    it('args 为 null 时内部异常被吞掉并放行（记录 error 日志）', () => {
      const tool = makeTool({
        type: 'object',
        properties: { name: { type: 'string' } },
        required: ['name'],
      });
      // `'name' in null` 抛 TypeError → catch → 放行执行
      const result = validateToolArgsWithSchema(tool, null as unknown as Record<string, unknown>);
      expect(result.isValid).toBe(true);
      expect(loggerMock.error).toHaveBeenCalledWith(
        'Error during schema validation',
        expect.any(Error),
        { toolName: 'test-tool', args: null },
      );
    });
  });
});
