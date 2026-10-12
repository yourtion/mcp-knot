import {
  GetSkillPayloadSchema,
  GetSkillResultSchema,
  ListSkillsPayloadSchema,
  ListSkillsResultSchema,
  loadLocalSkillSnapshot,
  registerSkills,
  SkillCatalog,
  SKILLS_EXTENSION,
} from '@mcp-core/mcp-knot-core/skills';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod/v4';

import type { SkillSnapshot } from '@mcp-core/mcp-knot-core/skills';
import type { ChildProcess } from 'node:child_process';

const fixture = fileURLToPath(
  new URL('../../../../packages/core/src/skills/__fixtures__/review-code', import.meta.url),
);
const stdioScript = fileURLToPath(
  new URL('../../../scripts/skills-validation.ts', import.meta.url),
);
const repository = fileURLToPath(new URL('../../../../', import.meta.url));
const clients: Client[] = [];
const processes: ChildProcess[] = [];
const temporaryDirectories: string[] = [];

function makeClient(skills = true, legacy = false): Client {
  const client = new Client(
    { name: 'skills-conformance-client', version: '1.0.0' },
    {
      capabilities: skills ? { extensions: { [SKILLS_EXTENSION]: {} } } : {},
      versionNegotiation: { mode: legacy ? 'legacy' : { pin: '2026-07-28' } },
    },
  );
  clients.push(client);
  return client;
}

function buildServer(catalog: SkillCatalog): McpServer {
  const server = new McpServer({ name: 'skills-protocol-fixture', version: '1.0.0' });
  server.registerTool(
    'echo',
    { inputSchema: z.object({ message: z.string() }) },
    async ({ message }) => ({
      content: [{ type: 'text', text: message }],
    }),
  );
  server.registerResource(
    'hub_version',
    'hub://version',
    { mimeType: 'application/json' },
    async () => ({
      contents: [{ uri: 'hub://version', text: '{"phase":0}', mimeType: 'application/json' }],
    }),
  );
  registerSkills(server, catalog, 1);
  return server;
}

async function connectHttp(
  catalog: SkillCatalog,
  client = makeClient(),
  legacy: 'reject' | 'stateless' = 'reject',
  onResult?: (method: string, result: unknown) => void,
) {
  const handler = createMcpHandler(() => buildServer(catalog), { responseMode: 'json', legacy });
  const transport = new StreamableHTTPClientTransport(new URL('http://skills.test/mcp'), {
    fetch: async (input, init) => {
      const request = new Request(input, init);
      const method =
        request.method === 'POST' ? ((await request.clone().json()).method as string) : undefined;
      const response = await handler.fetch(request);
      if (
        onResult &&
        method &&
        response.headers.get('content-type')?.includes('application/json')
      ) {
        const body = await response.text();
        onResult(method, (JSON.parse(body) as { result?: unknown }).result);
        return new Response(body, { status: response.status, headers: response.headers });
      }
      return response;
    },
  });
  await client.connect(transport);
  return client;
}

async function list(client: Client, cursor?: string) {
  return client.request(
    { method: 'skills/list', params: cursor ? { cursor } : {} },
    ListSkillsPayloadSchema,
  );
}

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  await Promise.all(
    processes.splice(0).map(async (child) => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = once(child, 'exit');
      const timeout = setTimeout(() => child.kill('SIGKILL'), 3000);
      child.kill('SIGTERM');
      try {
        await exited;
      } finally {
        clearTimeout(timeout);
      }
    }),
  );
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('SEP-2640 through real MCP SDK serving and client transports', () => {
  let first: SkillSnapshot;
  let second: SkillSnapshot;
  beforeAll(async () => {
    first = await loadLocalSkillSnapshot(fixture, 'team-a');
    second = await loadLocalSkillSnapshot(fixture, 'team-b');
  });

  it('HTTP discovers the extension, preserves complete envelopes and pages whole manifests', async () => {
    const wire = new Map<string, unknown>();
    const client = await connectHttp(
      new SkillCatalog([first, second]),
      makeClient(),
      'reject',
      (method, result) => wire.set(method, result),
    );
    expect(client.getProtocolEra()).toBe('modern');
    expect(client.getServerCapabilities()).toMatchObject({
      resources: {},
      extensions: { [SKILLS_EXTENSION]: {} },
    });
    expect(client.getServerCapabilities()?.extensions?.[SKILLS_EXTENSION]).not.toHaveProperty(
      'directoryRead',
    );
    const get = await client.request(
      { method: 'skills/get', params: { uri: second.entry.uri } },
      GetSkillPayloadSchema,
    );
    expect(get).toMatchObject({
      ttlMs: 60_000,
      cacheScope: 'private',
      skill: second.entry,
    });
    expect(GetSkillResultSchema.parse(wire.get('skills/get'))).toMatchObject({
      resultType: 'complete',
      skill: second.entry,
    });
    const page = await list(client);
    expect(page).toMatchObject({ ttlMs: 60_000, cacheScope: 'private' });
    expect(ListSkillsResultSchema.parse(wire.get('skills/list'))).toMatchObject({
      resultType: 'complete',
      skills: [first.entry],
    });
    expect(page.skills).toEqual([first.entry]);
    expect(page.nextCursor).toBeTruthy();
    const next = await list(client, page.nextCursor);
    expect(next.skills).toEqual([second.entry]);
    expect(next.nextCursor).toBeUndefined();
  });

  it('HTTP reads every file with matching size/hash and leaves tools and Hub resources available', async () => {
    const client = await connectHttp(new SkillCatalog([first]));
    for (const resource of first.entry.resources) {
      const result = await client.readResource({ uri: resource.uri });
      const content = result.contents[0];
      const bytes =
        'text' in content ? Buffer.from(content.text) : Buffer.from(content.blob, 'base64');
      expect(bytes.length).toBe(resource.size);
      expect(`sha256:${createHash('sha256').update(bytes).digest('hex')}`).toBe(resource.digest);
    }
    const resources = await client.listResources();
    expect(resources.resources.map((resource) => resource.uri)).toEqual(
      expect.arrayContaining(['hub://version', ...first.entry.resources.map((file) => file.uri)]),
    );
    expect((await client.listTools()).tools.map((tool) => tool.name)).toContain('echo');
    expect(
      await client.callTool({ name: 'echo', arguments: { message: 'still available' } }),
    ).toMatchObject({ content: [{ text: 'still available' }] });
    expect(await client.readResource({ uri: 'hub://version' })).toMatchObject({
      contents: [{ text: '{"phase":0}' }],
    });
  });

  it('preserves special frontmatter keys across HTTP wire validation and SDK decoding', async () => {
    const temp = await mkdtemp(join(tmpdir(), 'mcp-skills-frontmatter-'));
    temporaryDirectories.push(temp);
    const directory = join(temp, 'review-code');
    await cp(fixture, directory, { recursive: true });
    const path = join(directory, 'SKILL.md');
    await writeFile(
      path,
      (await readFile(path, 'utf8')).replace(
        'license: MIT',
        'license: MIT\n__proto__: { note: original }\nconstructor: original',
      ),
    );
    const snapshot = await loadLocalSkillSnapshot(directory);
    const wire = new Map<string, unknown>();
    const client = await connectHttp(
      new SkillCatalog([snapshot]),
      makeClient(),
      'reject',
      (method, result) => wire.set(method, result),
    );
    const page = await list(client);
    const expected = JSON.parse('{"__proto__":{"note":"original"},"constructor":"original"}');
    expect(page.skills[0].frontmatter).toMatchObject(expected);
    expect(
      ListSkillsResultSchema.parse(wire.get('skills/list')).skills[0].frontmatter,
    ).toMatchObject(expected);
    const result = await client.request(
      { method: 'skills/get', params: { uri: snapshot.entry.uri } },
      GetSkillPayloadSchema,
    );
    expect(result.skill.frontmatter).toMatchObject(expected);
    expect(Object.getPrototypeOf(result.skill.frontmatter)).toBe(Object.prototype);
  });

  it('HTTP returns -32602 for unknown/non-SKILL URIs, files outside the view, traversal and malformed cursors', async () => {
    const client = await connectHttp(new SkillCatalog([first], 'group-a'));
    for (const uri of [
      second.entry.uri,
      'skill://unknown/SKILL.md',
      first.entry.resources[1].uri,
    ]) {
      await expect(
        client.request({ method: 'skills/get', params: { uri } }, GetSkillPayloadSchema),
      ).rejects.toMatchObject({ code: -32602 });
    }
    for (const uri of [
      second.entry.uri,
      new URL('../../secret.txt', first.entry.uri).href,
      `${first.entry.uri}/missing`,
    ]) {
      await expect(client.readResource({ uri })).rejects.toMatchObject({ code: -32602 });
    }
    await expect(list(client, 'malformed')).rejects.toMatchObject({ code: -32602 });
    await expect(
      client.request({ method: 'skills/get', params: {} }, GetSkillPayloadSchema),
    ).rejects.toMatchObject({ code: -32602 });
  });

  it('supports an empty skill view and a client that only uses ordinary tools/resources', async () => {
    const empty = await connectHttp(new SkillCatalog([]));
    expect((await list(empty)).skills).toEqual([]);
    expect((await empty.listResources()).resources.map((file) => file.uri)).toEqual([
      'hub://version',
    ]);
    const ordinary = await connectHttp(new SkillCatalog([first]), makeClient(false));
    expect((await ordinary.listTools()).tools).toHaveLength(1);
    expect((await ordinary.readResource({ uri: first.entry.uri })).contents).toHaveLength(1);
  });

  it('serves a binary attachment through standard resources/read', async () => {
    const temp = await mkdtemp(join(tmpdir(), 'skills-http-'));
    temporaryDirectories.push(temp);
    const root = join(temp, 'review-code');
    await cp(fixture, root, { recursive: true });
    const bytes = Buffer.from([0, 255, 128, 10]);
    await writeFile(join(root, 'asset.bin'), bytes);
    const snapshot = await loadLocalSkillSnapshot(root);
    const client = await connectHttp(new SkillCatalog([snapshot]));
    const asset = snapshot.entry.resources.find((file) => file.uri.endsWith('/asset.bin'))!;
    expect(await client.readResource({ uri: asset.uri })).toMatchObject({
      contents: [{ blob: bytes.toString('base64'), mimeType: 'application/octet-stream' }],
    });
  });

  it('stdio negotiates modern MCP in a real child process and retrieves skill files', async () => {
    const client = makeClient();
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ['--import', 'tsx', stdioScript, '--directory', fixture, '--transport', 'stdio'],
      cwd: repository,
      stderr: 'pipe',
    });
    await client.connect(transport);
    const wireResults: unknown[] = [];
    const onmessage = transport.onmessage;
    transport.onmessage = (message) => {
      if ('result' in message) wireResults.push(message.result);
      onmessage?.(message);
    };
    expect(client.getProtocolEra()).toBe('modern');
    expect(client.getServerCapabilities()?.extensions).toHaveProperty(SKILLS_EXTENSION);
    const page = await list(client);
    expect(ListSkillsResultSchema.parse(wireResults.at(-1))).toMatchObject({
      resultType: 'complete',
      skills: page.skills,
    });
    expect(page.skills).toHaveLength(1);
    const skill = page.skills[0];
    expect(skill.resources).toHaveLength(3);
    const result = await client.readResource({ uri: skill.uri });
    expect(result.contents[0]).toMatchObject({ uri: skill.uri, mimeType: 'text/markdown' });
    const fetched = await client.request(
      { method: 'skills/get', params: { uri: skill.uri } },
      GetSkillPayloadSchema,
    );
    expect(fetched.skill).toEqual(skill);
    expect(GetSkillResultSchema.parse(wireResults.at(-1))).toMatchObject({
      resultType: 'complete',
      skill,
    });
    expect((await client.listTools()).tools.map((tool) => tool.name)).toContain('echo');
  }, 15000);

  it('serves the standalone HTTP harness over a real loopback socket', async () => {
    const child = spawn(
      process.execPath,
      [
        '--import',
        'tsx',
        stdioScript,
        '--directory',
        fixture,
        '--transport',
        'http',
        '--port',
        '0',
      ],
      {
        cwd: repository,
        stdio: ['ignore', 'ignore', 'pipe'],
      },
    );
    processes.push(child);
    const endpoint = await new Promise<string>((resolveEndpoint, reject) => {
      let stderr = '';
      const timeout = setTimeout(
        () => reject(new Error(`HTTP harness did not start: ${stderr}`)),
        10000,
      );
      child.stderr!.setEncoding('utf8').on('data', (chunk: string) => {
        stderr += chunk;
        const match = /Skills validation MCP endpoint: (http:\/\/127\.0\.0\.1:\d+\/mcp)/.exec(
          stderr,
        );
        if (match) {
          clearTimeout(timeout);
          resolveEndpoint(match[1]);
        }
      });
      child.once('error', (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      child.once('exit', (code) => {
        clearTimeout(timeout);
        reject(new Error(`HTTP harness exited (${code}): ${stderr}`));
      });
    });
    const client = makeClient();
    await client.connect(new StreamableHTTPClientTransport(new URL(endpoint)));
    const page = await list(client);
    expect(client.getProtocolEra()).toBe('modern');
    expect(page.skills).toHaveLength(1);
    expect(await client.readResource({ uri: page.skills[0].uri })).toMatchObject({
      contents: [{ mimeType: 'text/markdown' }],
    });
    expect(
      await client.callTool({ name: 'echo', arguments: { message: 'loopback' } }),
    ).toMatchObject({ content: [{ text: 'loopback' }] });
  }, 15000);

  it('keeps legacy Tools/Resources access working through the existing stateless shim', async () => {
    const client = await connectHttp(
      new SkillCatalog([first]),
      makeClient(false, true),
      'stateless',
    );
    expect(client.getProtocolEra()).toBe('legacy');
    expect((await client.listTools()).tools.map((tool) => tool.name)).toContain('echo');
    expect((await client.readResource({ uri: first.entry.uri })).contents).toHaveLength(1);
  });
});
