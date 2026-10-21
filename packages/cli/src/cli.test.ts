/**
 * CLI 参数解析测试。
 *
 * 聚焦 Task 10 新增的协议兼容层启动 flag：
 *   --no-legacy-inbound     → CliOptions.noLegacyInbound
 *   --modern-only-upstream  → CliOptions.modernOnlyUpstream
 *
 * 注意：cli.ts 作为入口会在加载时经 isMainEntry 守卫启动 main()，
 * 被本文件 import 时守卫不成立，不会触发真实启动，可安全单元测试 parseArgs。
 */

import { describe, expect, it, vi } from 'vitest';

const startupProbe = vi.hoisted(() => ({ attempted: false }));

vi.mock('./config/cli-config-manager.js', () => ({
  CliConfigManager: class {
    loadConfig(): Promise<never> {
      startupProbe.attempted = true;
      // Unexpected startup must be reported by the assertion below, before it
      // can read real config, start a server, or exit the Vitest worker.
      return new Promise<never>(() => {});
    }
  },
}));

import { parseArgs } from './cli';

describe('CLI 模块导入', () => {
  it('仅导入模块不会启动服务', () => {
    expect(startupProbe.attempted).toBe(false);
  });
});

describe('parseArgs - 协议兼容层 flag', () => {
  it('默认不设置 noLegacyInbound / modernOnlyUpstream', () => {
    const opts = parseArgs([]);
    expect(opts.noLegacyInbound).toBeUndefined();
    expect(opts.modernOnlyUpstream).toBeUndefined();
  });

  it('解析 --no-legacy-inbound', () => {
    const opts = parseArgs(['--no-legacy-inbound']);
    expect(opts.noLegacyInbound).toBe(true);
  });

  it('解析 --modern-only-upstream', () => {
    const opts = parseArgs(['--modern-only-upstream']);
    expect(opts.modernOnlyUpstream).toBe(true);
  });

  it('两个 flag 可同时生效且不互相干扰', () => {
    const opts = parseArgs(['--no-legacy-inbound', '--modern-only-upstream']);
    expect(opts.noLegacyInbound).toBe(true);
    expect(opts.modernOnlyUpstream).toBe(true);
  });

  it('flag 与既有选项（如 --verbose）可组合', () => {
    const opts = parseArgs(['-v', '--no-legacy-inbound']);
    expect(opts.verbose).toBe(true);
    expect(opts.noLegacyInbound).toBe(true);
  });
});
