import { SkillRepository, SkillsShMarketProvider } from '@mcp-core/mcp-knot-core/skills';
import { Hono } from 'hono';
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TestContext, useTestContext } from '../../../../test/context/test-context.js';
import { SkillMarketService } from '../../services/skill-market-service.js';
import { getAllConfig, resetConfigInstances, saveConfig } from '../../utils/config.js';
import { createSkillsApi } from './index.js';

import type { AuthContext } from '../../types/auth.js';

const raw = {
  id: 'mattpocock/skills/grill-me',
  name: 'grill-me',
  source: 'mattpocock/skills',
  installs: 100,
};
describe('market search management API', () => {
  let temp: string;
  let source: string;
  let repository: SkillRepository;
  beforeEach(async () => {
    const previousConfigPath = process.env.CONFIG_PATH;
    temp = await mkdtemp(join(tmpdir(), 'skills-market-api-'));
    const directory = temp;
    const context = useTestContext();
    context.register('temporary-directory', () => rm(directory, { recursive: true, force: true }));
    context.register('config-instances', resetConfigInstances);
    context.register('config-environment', () => {
      if (previousConfigPath === undefined) delete process.env.CONFIG_PATH;
      else process.env.CONFIG_PATH = previousConfigPath;
    });
    process.env.CONFIG_PATH = temp;
    resetConfigInstances();
    source = join(temp, 'source', 'grill-me');
    await mkdir(source, { recursive: true });
    await writeFile(
      join(source, 'SKILL.md'),
      '---\nname: grill-me\ndescription: Ask about a design.\n---\nOriginal.',
    );
    repository = new SkillRepository(join(temp, '.skills'), async (_command, args) => {
      if (args.includes('clone')) await cp(join(temp, 'source'), args.at(-1)!, { recursive: true });
      return args.includes('rev-parse') ? 'a'.repeat(40) : '';
    });
    await saveConfig('group.json', {});
  });
  afterEach(async () => {
    await TestContext.resetCurrent();
  });
  function app(fetcher: typeof fetch) {
    const provider = new SkillsShMarketProvider({ fetch: fetcher });
    const service = new SkillMarketService(
      provider,
      repository,
      async () => (await getAllConfig()).groups,
    );
    const hono = new Hono();
    hono.use('*', async (context, next) => {
      const role = context.req.header('x-test-role');
      if (role)
        context.set('auth', { user: { id: 'test', username: 'test', role } } as AuthContext);
      await next();
    });
    hono.route('/api/skills', createSkillsApi({ market: service }));
    return hono;
  }
  const request = (hono: Hono, path = '/api/skills/market/search?q=grill-me', role = 'admin') =>
    hono.request(path, { headers: { 'x-test-role': role } });

  it('adds fresh local import/publication state to cached search metadata, with no automatic import', async () => {
    const fetcher = vi.fn(async () => Response.json({ skills: [raw] }));
    const hono = app(fetcher);
    const initial = await request(hono);
    expect(initial.status).toBe(200);
    expect(initial.headers.get('Cache-Control')).toBe('private, no-store');
    const item = (await initial.json()).data.items[0];
    expect(item.local).toMatchObject({ imported: false, published: false });
    expect(await repository.listSources()).toEqual([]);
    expect(item.importOptions.git).toMatchObject({
      repository: 'https://github.com/mattpocock/skills.git',
      skills: ['grill-me'],
    });

    const registered = await hono.request('/api/skills/sources', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-test-role': 'admin' },
      body: JSON.stringify({ id: 'team', ...item.importOptions.git }),
    });
    expect(registered.status).toBe(201);
    const imported = await repository.sync('team');
    await saveConfig('group.json', {
      design: {
        id: 'design',
        name: 'Design',
        servers: [],
        tools: [],
        skills: { include: imported.selections },
      },
    });
    await writeFile(
      join(source, 'SKILL.md'),
      '---\nname: grill-me\ndescription: Ask about a new design.\n---\nUpdated.',
    );
    const next = await repository.sync('team');
    const searched = await request(hono);
    const data = (await searched.json()).data;
    expect(data.cached).toBe(true);
    expect(data.items[0].local.imports[0].revision).toBe(next.revision);
    expect(data.items[0].local.publishedIn[0]).toMatchObject({
      groupId: 'design',
      revision: imported.revision,
    });
    expect(data.items[0].local).toMatchObject({ imported: true, published: true });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect((await getAllConfig()).groups.design.skills?.include).toEqual(imported.selections);
  });

  it('restricts searches to administrators before contacting the market', async () => {
    const fetcher = vi.fn(async () => Response.json({ skills: [raw] }));
    const hono = app(fetcher);
    for (const role of ['', 'user'])
      expect((await request(hono, undefined, role)).status).toBe(403);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('returns structured query, rate-limit and upstream errors with Retry-After', async () => {
    const fetcher = vi.fn(
      async () => new Response(null, { status: 429, headers: { 'Retry-After': '20' } }),
    );
    const hono = app(fetcher);
    expect((await request(hono, '/api/skills/market/search?q=x')).status).toBe(400);
    expect(fetcher).not.toHaveBeenCalled();
    const limited = await request(hono);
    expect(limited.status).toBe(429);
    expect(limited.headers.get('Retry-After')).toBe('20');
    expect((await limited.json()).error.code).toBe('MARKET_RATE_LIMITED');
    const failed = await request(app(vi.fn(async () => new Response(null, { status: 503 }))));
    expect(failed.status).toBe(503);
    expect((await failed.json()).error.code).toBe('MARKET_UNAVAILABLE');
  });

  it('matches GitHub identities without confusing another owner or an unproven local copy', async () => {
    await repository.saveSource({
      id: 'local-copy',
      type: 'local',
      directory: join(temp, 'source'),
      skills: ['grill-me'],
    });
    await repository.sync('local-copy');
    await repository.saveSource({
      id: 'unrelated',
      type: 'git',
      repository: 'https://github.com/other/skills.git',
      skills: ['grill-me'],
    });
    await repository.sync('unrelated');
    const response = await request(app(vi.fn(async () => Response.json({ skills: [raw] }))));
    expect((await response.json()).data.items[0].local).toMatchObject({
      imported: false,
      published: false,
      imports: [],
    });
  });
});
