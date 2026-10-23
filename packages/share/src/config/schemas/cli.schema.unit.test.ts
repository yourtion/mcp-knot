import { describe, expect, it } from 'vitest';

import {
  CliConfigSchema,
  CliLoggingSchema,
  CliServerConfigSchema,
  CliTransportSchema,
} from './cli.schema.js';

describe('CliServerConfigSchema', () => {
  const valid = {
    command: 'npx',
    args: ['-y', 'server'],
    env: { KEY: 'value' },
    cwd: '/tmp',
    disabled: true,
    timeout: 5000,
  };

  it('接受完整配置并原样保留', () => {
    expect(CliServerConfigSchema.parse(valid)).toEqual(valid);
  });

  it('command 为必填', () => {
    expect(CliServerConfigSchema.safeParse({ args: [] }).success).toBe(false);
  });

  it('command 为空字符串时报「命令不能为空」', () => {
    const result = CliServerConfigSchema.safeParse({ command: '' });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toBe('命令不能为空');
  });

  it('timeout 必须为正数', () => {
    expect(CliServerConfigSchema.safeParse({ command: 'x', timeout: 0 }).success).toBe(false);
    expect(CliServerConfigSchema.safeParse({ command: 'x', timeout: -1 }).success).toBe(false);
    expect(CliServerConfigSchema.parse({ command: 'x', timeout: 1 }).timeout).toBe(1);
  });

  it('args 必须是字符串数组', () => {
    expect(CliServerConfigSchema.safeParse({ command: 'x', args: [1] }).success).toBe(false);
  });

  it('env 的值必须是字符串', () => {
    expect(CliServerConfigSchema.safeParse({ command: 'x', env: { A: 1 } }).success).toBe(false);
  });
});

describe('CliLoggingSchema', () => {
  it('缺省时 level 默认 info', () => {
    expect(CliLoggingSchema.parse({})).toEqual({ level: 'info' });
  });

  it.each(['debug', 'info', 'warn', 'error'] as const)('接受级别 %s', (level) => {
    expect(CliLoggingSchema.parse({ level }).level).toBe(level);
  });

  it('拒绝非法级别', () => {
    expect(CliLoggingSchema.safeParse({ level: 'verbose' }).success).toBe(false);
  });

  it('file 可选且原样保留', () => {
    expect(CliLoggingSchema.parse({ level: 'warn', file: '/tmp/log' })).toEqual({
      level: 'warn',
      file: '/tmp/log',
    });
  });
});

describe('CliTransportSchema', () => {
  it('缺省时 type 默认 stdio', () => {
    expect(CliTransportSchema.parse({})).toEqual({ type: 'stdio' });
  });

  it('只接受 stdio', () => {
    expect(CliTransportSchema.safeParse({ type: 'sse' }).success).toBe(false);
  });
});

describe('CliConfigSchema', () => {
  const validServer = { command: 'node', args: ['server.js'] };

  it('servers 为空对象时报「至少需要配置一个服务器」', () => {
    const result = CliConfigSchema.safeParse({ servers: {} });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toBe('至少需要配置一个服务器');
  });

  it('servers 缺失时校验失败', () => {
    expect(CliConfigSchema.safeParse({}).success).toBe(false);
  });

  it('省略 logging/transport 时应用默认值', () => {
    const parsed = CliConfigSchema.parse({ servers: { srv1: validServer } });
    expect(parsed.servers.srv1).toEqual(validServer);
    expect(parsed.logging).toEqual({ level: 'info' });
    expect(parsed.transport).toEqual({ type: 'stdio' });
  });

  it('显式提供的 logging/transport 原样保留', () => {
    const parsed = CliConfigSchema.parse({
      servers: { srv1: validServer },
      logging: { level: 'debug', file: '/tmp/x.log' },
      transport: { type: 'stdio' },
    });
    expect(parsed.logging).toEqual({ level: 'debug', file: '/tmp/x.log' });
  });

  it('servers 内部条目非法时报出具体路径与消息', () => {
    const result = CliConfigSchema.safeParse({ servers: { srv1: { command: '' } } });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toBe('命令不能为空');
  });
});
