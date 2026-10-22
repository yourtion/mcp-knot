import { ListSkillsPayloadSchema, SkillRepository } from '@mcp-core/mcp-knot-core/skills';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { Hono } from 'hono';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TestContext, useTestContext } from '../../../../test/context/test-context.js';
import { getAllConfig, resetConfigInstances, saveConfig } from '../../utils/config.js';
import { groupsApi } from '../groups/index.js';
import {
  createGroupMcpHandler,
  invalidateAllGroupMcpServices,
} from '../mcp/mcp-handler-factory.js';
import { skillsApi } from './index.js';

import type { AuthContext } from '../../types/auth.js';
import type { SkillImportResult } from '@mcp-core/mcp-knot-core/skills';

const core = vi.hoisted(() => ({
  getAllTools: vi.fn(async () => []),
  getServerTools: vi.fn(async () => []),
  getServerConnections: vi.fn(() => new Map()),
  getServiceStatus: vi.fn(() => new Map()),
}));
vi.mock('../../services/service-registry.js', () => ({
  getCoreServiceManager: async () => core,
  reloadCoreServiceManager: async () => {
    const factory = await import('../mcp/mcp-handler-factory.js');
    await factory.invalidateAllGroupMcpServices();
    return core;
  },
}));

describe('Skills management and formal Group publication', () => {
  let temp: string;
  let root: string;
  let app: Hono;
  let clientId = 0;

  beforeEach(async () => {
    const originalConfigPath = process.env.CONFIG_PATH;
    temp = await mkdtemp(join(tmpdir(), 'skills-group-api-'));
    const directory = temp;
    const context = useTestContext();
    context.register('temporary-directory', () => rm(directory, { recursive: true, force: true }));
    context.register('config-instances', resetConfigInstances);
    context.register('config-environment', () => {
      if (originalConfigPath === undefined) delete process.env.CONFIG_PATH;
      else process.env.CONFIG_PATH = originalConfigPath;
    });
    context.register('group-handlers', invalidateAllGroupMcpServices);
    process.env.CONFIG_PATH = temp;
    resetConfigInstances();
    root = join(temp, 'source', 'grill-me');
    await mkdir(root, { recursive: true });
    await writeFile(
      join(root, 'SKILL.md'),
      '---\nname: grill-me\ndescription: Ask about designs.\n---\nOriginal content.',
    );
    await saveConfig('mcp_server.json', { servers: {} });
    await saveConfig('system.json', {} as never);
    app = new Hono();
    app.use('*', async (context, next) => {
      const role = context.req.header('x-test-role');
      if (role)
        context.set('auth', { user: { id: 'test', username: 'tester', role } } as AuthContext);
      await next();
    });
    app.route('/api/skills', skillsApi);
    app.route('/api/groups', groupsApi);
  });
  afterEach(async () => {
    await TestContext.resetCurrent();
  });

  function request(path: string, method: string, body?: unknown, role = 'admin') {
    return app.request(path, {
      method,
      headers: { 'content-type': 'application/json', 'x-test-role': role },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
  }
  async function imported(): Promise<SkillImportResult> {
    expect(
      (
        await request('/api/skills/sources', 'POST', {
          id: 'team',
          type: 'local',
          directory: join(temp, 'source'),
          skills: ['grill-me'],
        })
      ).status,
    ).toBe(201);
    const response = await request('/api/skills/sources/team/sync', 'POST');
    expect(response.status).toBe(200);
    return (await response.json()).data as SkillImportResult;
  }
  async function connect(groupId: string) {
    const handler = await createGroupMcpHandler(groupId);
    const client = new Client(
      { name: 'group-skills-test', version: '1' },
      {
        capabilities: { extensions: { 'io.modelcontextprotocol/skills': {} } },
        versionNegotiation: { mode: { pin: '2026-07-28' } },
      },
    );
    useTestContext().register(`client:${++clientId}`, () => client.close());
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`http://group.test/${groupId}/mcp`), {
        fetch: (input, init) => handler.fetch(new Request(input, init)),
      }),
    );
    return client;
  }
  async function list(client: Client) {
    return client.request({ method: 'skills/list', params: {} }, ListSkillsPayloadSchema);
  }

  it('publishes selected immutable revisions via Group CRUD and the cached production handler', async () => {
    const first = await imported();
    const created = await request('/api/groups', 'POST', {
      id: 'design',
      name: 'Design',
      servers: [],
      tools: [],
      skills: { include: first.selections },
    });
    expect(created.status).toBe(200);
    expect((await created.json()).data.skills.include).toEqual(first.selections);
    expect((await getAllConfig()).groups.design.skills?.include).toEqual(first.selections);
    const client = await connect('design');
    expect((await list(client)).skills).toEqual(first.skills);
    expect(await client.readResource({ uri: first.skills[0].uri })).toMatchObject({
      contents: [{ text: expect.stringContaining('Original content.') }],
    });
    expect((await request('/api/groups/design', 'GET')).status).toBe(200);
    expect((await (await request('/api/groups/design', 'GET')).json()).data.skills.include).toEqual(
      first.selections,
    );

    await writeFile(
      join(root, 'SKILL.md'),
      '---\nname: grill-me\ndescription: Updated design.\n---\nUpdated content.',
    );
    const next = (await (await request('/api/skills/sources/team/update', 'POST')).json())
      .data as SkillImportResult;
    expect(next.revision).not.toBe(first.revision);
    expect((await list(client)).skills).toEqual(first.skills);
    const historyResponse = await request('/api/skills/sources/team/revisions', 'GET');
    expect(historyResponse.status).toBe(200);
    expect(historyResponse.headers.get('Cache-Control')).toBe('private, no-store');
    const history = (await historyResponse.json()).data as SkillImportResult[];
    expect(history).toHaveLength(2);
    expect(history).toEqual(expect.arrayContaining([first, next]));
    expect(
      (await (await request(`/api/skills/sources/team/revisions/${first.revision}`, 'GET')).json())
        .data,
    ).toEqual(first);
    const published = await request('/api/groups/design', 'PUT', {
      skills: { include: next.selections },
    });
    expect(published.status).toBe(200);
    const refreshed = await connect('design');
    expect((await list(refreshed)).skills).toEqual(next.skills);
    await expect(refreshed.readResource({ uri: first.skills[0].uri })).rejects.toMatchObject({
      code: -32602,
    });
    const restarted = new SkillRepository(join(temp, '.skills'));
    expect(
      (await restarted.catalog({ include: first.selections }, 'rollback')).get(first.skills[0].uri),
    ).toEqual(first.skills[0]);
    const rollback = await request('/api/groups/design', 'PUT', {
      skills: { include: history.find((item) => item.revision === first.revision)!.selections },
    });
    expect(rollback.status).toBe(200);
    const rolledBack = await connect('design');
    expect((await list(rolledBack)).skills).toEqual(first.skills);
    expect(await rolledBack.readResource({ uri: first.skills[0].uri })).toMatchObject({
      contents: [{ text: expect.stringContaining('Original content.') }],
    });
    await expect(rolledBack.readResource({ uri: next.skills[0].uri })).rejects.toMatchObject({
      code: -32602,
    });
    expect((await restarted.latest('team'))?.revision).toBe(next.revision);
  });

  it('reports missing history and protects version reads with administrator authorization', async () => {
    const first = await imported();
    expect((await request('/api/skills/sources/missing/revisions', 'GET')).status).toBe(404);
    expect(
      (await request(`/api/skills/sources/team/revisions/${'0'.repeat(64)}`, 'GET')).status,
    ).toBe(404);
    expect((await request('/api/skills/sources/team/revisions/invalid', 'GET')).status).toBe(400);
    for (const role of ['', 'user']) {
      expect(
        (await request('/api/skills/sources/team/revisions', 'GET', undefined, role)).status,
      ).toBe(403);
      expect(
        (
          await request(
            `/api/skills/sources/team/revisions/${first.revision}`,
            'GET',
            undefined,
            role,
          )
        ).status,
      ).toBe(403);
    }
    await request('/api/skills/sources', 'POST', {
      id: 'pending',
      type: 'local',
      directory: join(temp, 'source'),
      skills: ['grill-me'],
    });
    expect(
      (await (await request('/api/skills/sources/pending/revisions', 'GET')).json()).data,
    ).toEqual([]);
  });

  it('does not expose imported skills in another Group or an unselected view', async () => {
    const first = await imported();
    await request('/api/groups', 'POST', {
      id: 'empty',
      name: 'Empty view',
      servers: ['unconnected-server'],
      tools: [],
      skills: { include: [] },
    });
    const client = await connect('empty');
    expect((await list(client)).skills).toEqual([]);
    await expect(client.readResource({ uri: first.skills[0].uri })).rejects.toMatchObject({
      code: -32602,
    });
  });

  it('rejects missing revision references before saving Group config', async () => {
    const first = await imported();
    const response = await request('/api/groups', 'POST', {
      id: 'bad',
      name: 'Bad',
      servers: [],
      tools: [],
      skills: { include: [{ ...first.selections[0], revision: '0'.repeat(64) }] },
    });
    expect(response.status).toBe(400);
    expect((await getAllConfig()).groups.bad).toBeUndefined();
  });

  it('restricts source management to administrators and rejects shell command input', async () => {
    for (const role of ['', 'user'])
      expect((await request('/api/skills/sources', 'GET', undefined, role)).status).toBe(403);
    expect(
      (
        await request('/api/skills/sources', 'POST', {
          id: 'cli',
          command: 'npx skills@latest add mattpocock/skills --skill=grill-me; whoami',
        })
      ).status,
    ).toBe(400);
    const response = await request('/api/skills/sources', 'POST', {
      id: 'cli',
      command: 'npx skills@latest add mattpocock/skills --skill=grill-me',
    });
    expect(response.status).toBe(201);
    expect((await response.json()).data).toMatchObject({
      id: 'cli',
      type: 'skills-cli',
      repository: 'mattpocock/skills',
      skills: ['grill-me'],
    });
  });
});
