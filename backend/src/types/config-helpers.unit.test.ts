/**
 * 配置类型辅助工具测试
 */
import { describe, expect, it } from 'vitest';

import { toMcpServerConfig } from './config-helpers.js';

import type { GroupConfig, McpConfig } from '@mcp-core/mcp-knot-share/config';

describe('toMcpServerConfig', () => {
  it('将 mcps.servers 与 groups 映射为 McpServerConfig', () => {
    const servers: McpConfig['servers'] = {
      server1: { type: 'stdio', command: 'node', args: ['a.js'] },
    };
    const groups: GroupConfig = {
      default: { id: 'default', name: 'Default', servers: ['server1'], tools: [] },
    };

    const result = toMcpServerConfig({ mcps: { servers }, groups });

    expect(result.servers).toBe(servers);
    expect(result.groups).toBe(groups);
  });

  it('空配置映射为空结构', () => {
    const result = toMcpServerConfig({ mcps: { servers: {} }, groups: {} });

    expect(result.servers).toEqual({});
    expect(result.groups).toEqual({});
  });
});
