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

describe('parseArgs - 默认值', () => {
  it('无参数时应返回全部默认选项', () => {
    const opts = parseArgs([]);

    expect(opts.configPath).toBe('./mcp_server.json');
    expect(opts.verbose).toBe(false);
    expect(opts.help).toBe(false);
    expect(opts.version).toBe(false);
    expect(opts.generateConfig).toBe(false);
    expect(opts.templateType).toBe('basic');
    expect(opts.validateConfig).toBe(false);
    expect(opts.listTemplates).toBe(false);
    expect(opts.listPresets).toBe(false);
    expect(opts.init).toBe(false);
    expect(opts.initAll).toBe(false);
    expect(opts.overwrite).toBe(false);
    expect(opts.noLegacyInbound).toBeUndefined();
    expect(opts.modernOnlyUpstream).toBeUndefined();
  });
});

describe('parseArgs - 布尔开关', () => {
  it.each([
    ['-h', 'help'],
    ['--help', 'help'],
    ['-v', 'verbose'],
    ['--verbose', 'verbose'],
    ['--version', 'version'],
    ['--generate-config', 'generateConfig'],
    ['--validate', 'validateConfig'],
    ['--list-templates', 'listTemplates'],
    ['--list-presets', 'listPresets'],
    ['--init', 'init'],
    ['--init-all', 'initAll'],
    ['--overwrite', 'overwrite'],
  ] as const)('%s 应打开 %s 且不影响其他开关', (flag, field) => {
    const opts = parseArgs([flag]);

    expect(opts[field]).toBe(true);
    const otherKeys = [
      'help',
      'verbose',
      'version',
      'generateConfig',
      'validateConfig',
      'listTemplates',
      'listPresets',
      'init',
      'initAll',
      'overwrite',
    ].filter((key) => key !== field);
    for (const key of otherKeys) {
      expect(opts[key as keyof typeof opts]).toBe(false);
    }
    expect(opts.configPath).toBe('./mcp_server.json');
  });
});

describe('parseArgs - --config', () => {
  it('-c 与 --config 均可指定配置路径', () => {
    expect(parseArgs(['-c', 'a.json']).configPath).toBe('a.json');
    expect(parseArgs(['--config', 'b.json']).configPath).toBe('b.json');
  });

  it('-c 缺少值时应抛出错误', () => {
    expect(() => parseArgs(['-c'])).toThrow('--config 选项需要指定配置文件路径');
  });

  it('--config 缺少值时应抛出错误', () => {
    expect(() => parseArgs(['--config'])).toThrow('--config 选项需要指定配置文件路径');
  });

  it('值应取其后的参数而非当前 flag', () => {
    const opts = parseArgs(['-c', 'real.json', 'other.json']);
    expect(opts.configPath).toBe('real.json');
  });
});

describe('parseArgs - --template', () => {
  it.each(['basic', 'advanced', 'development', 'production'] as const)(
    '应接受合法模板类型 %s',
    (type) => {
      expect(parseArgs(['--template', type]).templateType).toBe(type);
    },
  );

  it('非法模板类型应抛出带类型的错误', () => {
    expect(() => parseArgs(['--template', 'foo'])).toThrow('无效的模板类型: foo');
  });

  it('缺少值时应抛出错误', () => {
    expect(() => parseArgs(['--template'])).toThrow('--template 选项需要指定模板类型');
  });
});

describe('parseArgs - 位置参数', () => {
  it('非选项参数应作为配置文件路径', () => {
    expect(parseArgs(['config.json']).configPath).toBe('config.json');
  });

  it('以 - 开头的未知参数不应被当作路径', () => {
    expect(parseArgs(['-x']).configPath).toBe('./mcp_server.json');
    expect(parseArgs(['--']).configPath).toBe('./mcp_server.json');
  });

  it('已通过 -c 指定路径时忽略后续位置参数', () => {
    const opts = parseArgs(['-c', 'a.json', 'b.json']);
    expect(opts.configPath).toBe('a.json');
  });

  it('结尾连字符的参数仍是合法路径（按前缀判断）', () => {
    expect(parseArgs(['my-dir-']).configPath).toBe('my-dir-');
  });
});
