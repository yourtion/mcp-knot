import { describe, expect, it } from 'vitest';

import { McpConfigSchema } from './mcp.schema.js';

describe('McpConfigSchema', () => {
  it('servers 为空对象时报「至少需要配置一个MCP服务器」', () => {
    const result = McpConfigSchema.safeParse({ servers: {} });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toBe('至少需要配置一个MCP服务器');
  });

  it('servers 缺失或顶层非对象时校验失败', () => {
    expect(McpConfigSchema.safeParse({}).success).toBe(false);
    expect(McpConfigSchema.safeParse('nope').success).toBe(false);
  });

  it('接受 stdio 与 http 服务器并存并原样保留', () => {
    const config = {
      servers: {
        local: { type: 'stdio', command: 'node', args: ['s.js'] },
        remote: { type: 'streaming', url: 'https://example.com/mcp' },
      },
    };
    const parsed = McpConfigSchema.parse(config);
    expect(parsed).toEqual(config);
    expect(Object.keys(parsed.servers)).toEqual(['local', 'remote']);
  });

  it('服务器条目非法时报具体条目路径', () => {
    const result = McpConfigSchema.safeParse({
      servers: { bad: { type: 'stdio' } },
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(['servers', 'bad']);
  });
});
