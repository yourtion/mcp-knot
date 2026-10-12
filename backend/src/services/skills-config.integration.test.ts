import { ListSkillsPayloadSchema } from '@mcp-core/mcp-knot-core/skills';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TestContext, useTestContext } from '../../../test/context/test-context.js';
import {
  createGroupMcpHandler,
  invalidateAllGroupMcpServices,
} from '../api/mcp/mcp-handler-factory.js';
import { getAllConfig, resetConfigInstances, saveConfig } from '../utils/config.js';
import { ConfigService } from './config_service.js';
import { getSkillRepository } from './skills-service.js';

import type { SkillImportResult } from '@mcp-core/mcp-knot-core/skills';
import type { GroupConfig } from '@mcp-core/mcp-knot-share';

vi.mock('./service-registry.js', () => ({
  getCoreServiceManager: async () => ({
    getAllTools: async () => [],
    getServerTools: async () => [],
    getServerConnections: () => new Map(),
    getServiceStatus: () => new Map(),
  }),
}));

describe('bulk Group configuration and skill publication', () => {
  let directory: string;
  let skillPath: string;
  let service: ConfigService;
  let first: SkillImportResult;
  let second: SkillImportResult;
  let clientId = 0;

  function groups(imported: SkillImportResult): GroupConfig {
    return {
      design: {
        id: 'design',
        name: 'Design',
        servers: [],
        tools: [],
        skills: { include: structuredClone(imported.selections) },
      },
    };
  }

  beforeEach(async () => {
    const originalConfigPath = process.env.CONFIG_PATH;
    directory = await mkdtemp(join(tmpdir(), 'skills-config-'));
    const temporaryDirectory = directory;
    const context = useTestContext();
    context.register('temporary-directory', () =>
      rm(temporaryDirectory, { recursive: true, force: true }),
    );
    context.register('config-instances', resetConfigInstances);
    context.register('config-environment', () => {
      if (originalConfigPath === undefined) delete process.env.CONFIG_PATH;
      else process.env.CONFIG_PATH = originalConfigPath;
    });
    context.register('group-handlers', invalidateAllGroupMcpServices);
    process.env.CONFIG_PATH = directory;
    resetConfigInstances();
    await saveConfig('mcp_server.json', { servers: {} });
    await saveConfig('system.json', {} as never);
    skillPath = join(directory, 'source', 'review-design', 'SKILL.md');
    await mkdir(join(directory, 'source', 'review-design'), { recursive: true });
    const contents = '---\nname: review-design\ndescription: Review designs.\n---\nOriginal.';
    await writeFile(skillPath, contents);
    const repository = getSkillRepository();
    await repository.saveSource({
      id: 'team',
      type: 'local',
      directory: join(directory, 'source'),
      skills: ['review-design'],
    });
    first = await repository.sync('team');
    await writeFile(skillPath, `${contents} Updated.`);
    second = await repository.sync('team');
    await saveConfig('group.json', groups(first));
    service = new ConfigService();
  });

  afterEach(async () => {
    await TestContext.resetCurrent();
  });

  async function connect() {
    const handler = await createGroupMcpHandler('design');
    const client = new Client(
      { name: 'bulk-skills-test', version: '1' },
      {
        capabilities: { extensions: { 'io.modelcontextprotocol/skills': {} } },
        versionNegotiation: { mode: { pin: '2026-07-28' } },
      },
    );
    useTestContext().register(`client:${++clientId}`, () => client.close());
    await client.connect(
      new StreamableHTTPClientTransport(new URL('http://group.test/design/mcp'), {
        fetch: (input, init) => handler.fetch(new Request(input, init)),
      }),
    );
    return { handler, client };
  }

  async function list(client: Client) {
    return client.request({ method: 'skills/list', params: {} }, ListSkillsPayloadSchema);
  }

  it('rebuilds cached handlers after bulk update and restore, with fixed revisions', async () => {
    const backup = await service.createBackup('Original selection', ['groups']);
    const initial = await connect();
    expect((await list(initial.client)).skills).toEqual(first.skills);
    await service.updateConfig('groups', groups(second));
    const updated = await connect();
    expect(updated.handler).not.toBe(initial.handler);
    expect((await list(updated.client)).skills).toEqual(second.skills);
    await expect(updated.client.readResource({ uri: first.skills[0].uri })).rejects.toMatchObject({
      code: -32602,
    });
    await service.restoreFromBackup(backup, ['groups']);
    const restored = await connect();
    expect(restored.handler).not.toBe(updated.handler);
    expect((await list(restored.client)).skills).toEqual(first.skills);
    await expect(restored.client.readResource({ uri: second.skills[0].uri })).rejects.toMatchObject(
      {
        code: -32602,
      },
    );
  });

  it('rejects invalid bulk references without replacing the active config or handler', async () => {
    const initial = await connect();
    const invalid = groups(first);
    invalid.design.skills!.include[0] = {
      ...first.selections[0],
      revision: '0'.repeat(64),
    };
    await expect(service.updateConfig('groups', invalid)).rejects.toThrow();
    expect((await getAllConfig()).groups).toEqual(groups(first));
    expect(await createGroupMcpHandler('design')).toBe(initial.handler);
    expect((await list(initial.client)).skills).toEqual(first.skills);
  });

  it('revalidates backup references before restoring any configuration', async () => {
    const backup = await service.createBackup('Original selection', ['system', 'groups']);
    const file = (await readdir(join(directory, '.backups'))).find((name) =>
      name.includes(backup),
    )!;
    const path = join(directory, '.backups', file);
    const stored = JSON.parse(await readFile(path, 'utf8'));
    stored.configs.system = { overwritten: true };
    stored.configs.groups.design.skills.include[0].revision = '0'.repeat(64);
    await writeFile(path, JSON.stringify(stored));
    const initial = await connect();
    await expect(service.restoreFromBackup(backup)).rejects.toThrow();
    expect((await getAllConfig()).system).toEqual({});
    expect((await getAllConfig()).groups).toEqual(groups(first));
    expect(await createGroupMcpHandler('design')).toBe(initial.handler);
    expect((await list(initial.client)).skills).toEqual(first.skills);
  });

  it('preserves the existing publication for unrelated configuration saves', async () => {
    const initial = await connect();
    const backup = await service.createBackup('System settings', ['system']);
    await service.updateConfig('system', { marker: 'updated' });
    await service.restoreFromBackup(backup, ['system']);
    expect(await createGroupMcpHandler('design')).toBe(initial.handler);
    expect((await list(initial.client)).skills).toEqual(first.skills);
  });
});
