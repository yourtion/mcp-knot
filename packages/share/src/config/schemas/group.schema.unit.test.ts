import { describe, it, expect } from 'vitest';

import { GroupConfigSchema, GroupSchema } from './group.schema.js';

describe('GroupSchema - cacheHints (P4)', () => {
  it('应接受带 cacheHints 的合法配置', () => {
    const valid = {
      id: 'g1',
      name: 'Group 1',
      servers: ['srv1'],
      tools: [],
      cacheHints: {
        toolsListTtlMs: 120000,
        toolsListCacheScope: 'private',
      },
    };
    const parsed = GroupSchema.parse(valid);
    expect(parsed.cacheHints).toEqual({
      toolsListTtlMs: 120000,
      toolsListCacheScope: 'private',
    });
  });

  it('cacheHints 可选，不填也能通过', () => {
    const parsed = GroupSchema.parse({
      id: 'g1',
      name: 'Group 1',
      servers: ['srv1'],
      tools: [],
    });
    expect(parsed.cacheHints).toBeUndefined();
  });

  it('toolsListTtlMs 拒绝负数', () => {
    const result = GroupSchema.safeParse({
      id: 'g1',
      name: 'G1',
      servers: ['s1'],
      tools: [],
      cacheHints: { toolsListTtlMs: -100 },
    });
    expect(result.success).toBe(false);
  });

  it('toolsListCacheScope 拒绝非法枚举值', () => {
    const result = GroupSchema.safeParse({
      id: 'g1',
      name: 'G1',
      servers: ['s1'],
      tools: [],
      cacheHints: { toolsListCacheScope: 'shared' },
    });
    expect(result.success).toBe(false);
  });

  it('toolsListTtlMs 必须为非负整数', () => {
    const result = GroupSchema.safeParse({
      id: 'g1',
      name: 'G1',
      servers: ['s1'],
      tools: [],
      cacheHints: { toolsListTtlMs: 1.5 },
    });
    expect(result.success).toBe(false);
  });
});

describe('GroupSchema 必填字段与错误消息', () => {
  const valid = { id: 'g1', name: 'G1', servers: ['s1'], tools: ['t1'] };

  it('解析结果保留 tools/servers 等字段', () => {
    const parsed = GroupSchema.parse(valid);
    expect(parsed).toEqual(valid);
  });

  it('id/name 为空时报中文错误消息', () => {
    const id = GroupSchema.safeParse({ ...valid, id: '' });
    expect(id.error?.issues[0]?.message).toBe('组ID不能为空');

    const name = GroupSchema.safeParse({ ...valid, name: '' });
    expect(name.error?.issues[0]?.message).toBe('组名称不能为空');
  });

  it('servers 中的服务器名为空时报「服务器名称不能为空」', () => {
    const result = GroupSchema.safeParse({ ...valid, servers: [''] });
    expect(result.error?.issues[0]?.message).toBe('服务器名称不能为空');
  });

  it('servers 与 skills 同时为空时报 refine 错误且指向 servers 路径', () => {
    const result = GroupSchema.safeParse({ ...valid, servers: [] });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(['servers']);
    expect(result.error?.issues[0]?.message).toBe('每个组至少需要包含一个服务器或已发布技能');
  });

  it('toolFilter 与 validation 可选块原样保留', () => {
    const toolFilter = { include: ['t1'], exclude: ['t2'], patterns: ['^tool\\..*'] };
    const validation = {
      enabled: true,
      validationKey: 'key',
      createdAt: '2024-01-01T00:00:00Z',
      lastUpdated: '2024-01-02T00:00:00Z',
    };
    const parsed = GroupSchema.parse({ ...valid, toolFilter, validation });
    expect(parsed.toolFilter).toEqual(toolFilter);
    expect(parsed.validation).toEqual(validation);
  });

  it('GroupConfigSchema 是组名到组的映射', () => {
    const parsed = GroupConfigSchema.parse({ g1: valid, g2: { ...valid, id: 'g2' } });
    expect(Object.keys(parsed)).toEqual(['g1', 'g2']);
    expect(parsed.g2?.id).toBe('g2');
  });
});
