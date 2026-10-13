import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

/** Public-repository smoke test, writes only into --directory. No production config required. */
import {
  SkillRepository,
  ListSkillsPayloadSchema,
  skillSourceFromCommand,
} from '../../packages/core/src/skills/index.js';
import { GroupMcpService } from '../src/api/mcp/group-service.js';
import { resetConfigInstances, saveConfig } from '../src/utils/config.js';

import type { McpServiceManagerInterface } from '@mcp-core/mcp-knot-core';

const { values } = parseArgs({
  options: { directory: { type: 'string' }, type: { type: 'string', default: 'git' } },
});
if (!values.directory || !['git', 'skills-cli'].includes(values.type!))
  throw new Error('Usage: --directory <temporary-config-directory> --type git|skills-cli');
const directory = resolve(values.directory);
process.env.CONFIG_PATH = directory;
resetConfigInstances();
await mkdir(directory, { recursive: true });
const repository = new SkillRepository(join(directory, '.skills'));
const sourceId = values.type === 'git' ? 'matt-git' : 'matt-cli';
await repository.saveSource(
  values.type === 'git'
    ? {
        id: sourceId,
        type: 'git',
        repository: 'https://github.com/mattpocock/skills.git',
        skills: ['grill-me'],
      }
    : skillSourceFromCommand(sourceId, 'npx skills@latest add mattpocock/skills --skill=grill-me'),
);
const first = await repository.sync(sourceId);
const updated = await repository.sync(sourceId, 'update');
const restarted = new SkillRepository(join(directory, '.skills'), async () => {
  throw new Error('Published reads must be offline');
});
const catalog = await restarted.catalog({ include: first.selections }, 'verification');
assert.deepEqual(catalog.get(first.skills[0].uri), first.skills[0]);
await saveConfig('group.json', {
  verification: {
    id: 'verification',
    name: 'Skills verification',
    servers: [],
    tools: [],
    skills: { include: first.selections },
  },
});
const core = {
  getAllTools: async () => [],
  getServerTools: async () => [],
  getServerConnections: () => new Map(),
  getServiceStatus: () => new Map(),
} as unknown as McpServiceManagerInterface;
const group = new GroupMcpService('verification', core);
await group.initialize();
const handler = createMcpHandler(() => group.getMcpServer(), {
  legacy: 'reject',
  responseMode: 'json',
});
const client = new Client(
  { name: 'skills-source-smoke', version: '1' },
  {
    capabilities: { extensions: { 'io.modelcontextprotocol/skills': {} } },
    versionNegotiation: { mode: { pin: '2026-07-28' } },
  },
);
try {
  await client.connect(
    new StreamableHTTPClientTransport(new URL('http://validation.test/verification/mcp'), {
      fetch: (input, init) => handler.fetch(new Request(input, init)),
    }),
  );
  const result = await client.request(
    { method: 'skills/list', params: {} },
    ListSkillsPayloadSchema,
  );
  assert.deepEqual(result.skills, first.skills);
  const resources = result.skills[0].resources;
  assert.ok(Array.isArray(resources), 'Expected complete manifest');
  for (const file of resources) {
    const response = await client.readResource({ uri: file.uri });
    assert.ok(response.contents.length === 1);
    const content = response.contents[0];
    const bytes =
      'text' in content ? Buffer.from(content.text) : Buffer.from(content.blob, 'base64');
    assert.equal(bytes.length, file.size);
    assert.equal(`sha256:${createHash('sha256').update(bytes).digest('hex')}`, file.digest);
  }
  process.stdout.write(
    JSON.stringify(
      {
        type: values.type,
        sourceId,
        revision: first.revision,
        updateRevision: updated.revision,
        changed: first.revision !== updated.revision,
        provenance: first.provenance,
        skills: first.skills.map((skill) => ({
          uri: skill.uri,
          name: skill.frontmatter.name,
          files: skill.resources.length,
        })),
        restoredOffline: true,
        groupProtocol: 'passed',
      },
      null,
      2,
    ) + '\n',
  );
} finally {
  await client.close();
  await handler.close();
  await group.shutdown();
}
