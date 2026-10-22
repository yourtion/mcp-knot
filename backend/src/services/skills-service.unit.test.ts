/**
 * skills-service 单测（变异覆盖批次）
 *
 * getSkillRepository 是模块级单例：同 directory（CONFIG_PATH 派生）复用实例，
 * directory 变化时重建。mock SkillRepository 以断言构造次数与 directory 参数。
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const { instances } = vi.hoisted(() => ({ instances: [] as Array<{ directory: string }> }));

vi.mock('@mcp-core/mcp-knot-core/skills', () => ({
  SkillRepository: class {
    directory: string;
    constructor(directory: string) {
      this.directory = directory;
      instances.push(this);
    }
  },
}));

describe('getSkillRepository', () => {
  const origConfigPath = process.env.CONFIG_PATH;

  beforeEach(() => {
    vi.resetModules();
    instances.length = 0;
    delete process.env.CONFIG_PATH;
  });

  afterAll(() => {
    if (origConfigPath !== undefined) process.env.CONFIG_PATH = origConfigPath;
    else delete process.env.CONFIG_PATH;
  });

  it('同 directory 连续调用复用同一实例（只构造一次）', async () => {
    process.env.CONFIG_PATH = '/tmp/skills-root-a';
    const mod = await import('./skills-service.js');
    const r1 = mod.getSkillRepository();
    const r2 = mod.getSkillRepository();
    expect(r1).toBe(r2);
    expect(instances).toHaveLength(1);
    expect(r1.directory).toBe('/tmp/skills-root-a/.skills');
  });

  it('directory 变化（CONFIG_PATH 切换）时重建实例', async () => {
    process.env.CONFIG_PATH = '/tmp/skills-root-a';
    const mod = await import('./skills-service.js');
    const r1 = mod.getSkillRepository();

    process.env.CONFIG_PATH = '/tmp/skills-root-b';
    const r2 = mod.getSkillRepository();

    expect(r2).not.toBe(r1);
    expect(instances).toHaveLength(2);
    expect(r2.directory).toBe('/tmp/skills-root-b/.skills');
  });

  it('未设置 CONFIG_PATH 时默认使用 cwd/config/.skills', async () => {
    const mod = await import('./skills-service.js');
    const r = mod.getSkillRepository();
    const expected = `${process.cwd()}/config/.skills`;
    expect(r.directory).toBe(expected);
  });

  it('CONFIG_PATH 清除后回到默认 directory 也会重建', async () => {
    process.env.CONFIG_PATH = '/tmp/skills-root-a';
    const mod = await import('./skills-service.js');
    mod.getSkillRepository(); // 以自定义 directory 建立单例

    delete process.env.CONFIG_PATH;
    const r2 = mod.getSkillRepository();
    expect(r2.directory).toBe(`${process.cwd()}/config/.skills`);
    expect(instances).toHaveLength(2);
  });

  it('CONFIG_PATH 为空字符串时按未设置处理（回退默认目录）', async () => {
    process.env.CONFIG_PATH = '';
    const mod = await import('./skills-service.js');
    const r = mod.getSkillRepository();
    expect(r.directory).toBe(`${process.cwd()}/config/.skills`);
  });

  it('导出跨调用保持稳定引用（不因重复 import 重置单例）', async () => {
    process.env.CONFIG_PATH = '/tmp/skills-root-a';
    const mod1 = await import('./skills-service.js');
    const r1 = mod1.getSkillRepository();
    // 同一模块图内的再次 import 拿到同一实例
    const mod2 = await import('./skills-service.js');
    expect(mod2.getSkillRepository()).toBe(r1);
    expect(instances).toHaveLength(1);
  });
});
