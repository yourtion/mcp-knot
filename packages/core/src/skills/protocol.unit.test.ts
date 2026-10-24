import { INVALID_PARAMS, ProtocolError, ResourceTemplate } from '@modelcontextprotocol/server';
import { describe, expect, it, vi } from 'vitest';

import { SkillCatalog } from './catalog.js';
import { snapshotFromFiles } from './local-snapshot.js';
import { registerSkills } from './protocol.js';
import { SKILLS_EXTENSION } from './schemas.js';

import type { SkillCatalog as Catalog } from './catalog.js';
import type { McpServer } from '@modelcontextprotocol/server';

function makeSnapshot(name: string, namespace: string) {
  const markdown = `---\nname: ${name}\ndescription: Skill ${name} instructions.\n---\nUse notes.txt.\n`;
  return snapshotFromFiles(
    [
      { path: 'SKILL.md', bytes: Buffer.from(markdown) },
      { path: 'notes.txt', bytes: Buffer.from(`${name} notes`) },
    ],
    namespace,
    name,
  );
}

interface CapturedServer {
  server: McpServer;
  capabilities: ReturnType<typeof vi.fn>;
  handlers: Map<string, (params: Record<string, unknown>) => Promise<unknown>>;
  resources: Array<{
    name: string;
    template: ResourceTemplate;
    options: { description?: string; cacheHint?: { ttlMs: number; cacheScope: string } };
    read: (uri: URL) => Promise<unknown>;
  }>;
}

function captureServer(): CapturedServer {
  const handlers = new Map<string, (params: Record<string, unknown>) => Promise<unknown>>();
  const resources: CapturedServer['resources'] = [];
  const capabilities = vi.fn();
  const server = {
    server: {
      registerCapabilities: capabilities,
      setRequestHandler: vi.fn(
        (
          method: string,
          _schemas: unknown,
          handler: (params: Record<string, unknown>) => Promise<unknown>,
        ) => {
          handlers.set(method, handler);
        },
      ),
    },
    registerResource: vi.fn(
      (
        name: string,
        template: ResourceTemplate,
        options: CapturedServer['resources'][number]['options'],
        read: (uri: URL) => Promise<unknown>,
      ) => {
        resources.push({ name, template, options, read });
      },
    ),
  };
  return { server: server as unknown as McpServer, capabilities, handlers, resources };
}

describe('skills protocol extension registration', () => {
  it('advertises the extension capability and registers list, get, and skill_files resource', () => {
    const captured = captureServer();
    registerSkills(captured.server, new SkillCatalog([makeSnapshot('demo-skill', 'team')]));

    expect(captured.capabilities).toHaveBeenCalledWith({
      resources: {},
      extensions: { [SKILLS_EXTENSION]: {} },
    });
    expect(captured.handlers.has('skills/list')).toBe(true);
    expect(captured.handlers.has('skills/get')).toBe(true);
    expect(captured.resources).toHaveLength(1);
    expect(captured.resources[0].name).toBe('skill_files');
    expect(captured.resources[0].template).toBeInstanceOf(ResourceTemplate);
    expect(captured.resources[0].template.uriTemplate.toString()).toContain('skill://');
    expect(captured.resources[0].options).toEqual({
      description: 'Published skill instructions and supporting files',
      cacheHint: { ttlMs: 60_000, cacheScope: 'private' },
    });
  });

  it('serves a complete list page with the private cache hint and default page size', async () => {
    const captured = captureServer();
    const snapshots = Array.from({ length: 11 }, (_, index) =>
      makeSnapshot(`skill-number-${index}`, 'team'),
    );
    const catalog = new SkillCatalog(snapshots);
    registerSkills(captured.server, catalog);

    const expected = catalog.list(undefined, 100).skills;
    const first = (await captured.handlers.get('skills/list')!({ cursor: undefined })) as {
      resultType: string;
      ttlMs: number;
      cacheScope: string;
      skills: unknown[];
      nextCursor?: string;
    };
    expect(first.resultType).toBe('complete');
    expect(first.ttlMs).toBe(60_000);
    expect(first.cacheScope).toBe('private');
    expect(first.skills).toEqual(expected.slice(0, 10));
    expect(typeof first.nextCursor).toBe('string');

    const second = (await captured.handlers.get('skills/list')!({ cursor: first.nextCursor })) as {
      skills: unknown[];
      nextCursor?: string;
    };
    expect(second.skills).toEqual(expected.slice(10));
    expect(second.nextCursor).toBeUndefined();
  });

  it('converts catalog validation failures into INVALID_PARAMS protocol errors', async () => {
    const captured = captureServer();
    registerSkills(captured.server, new SkillCatalog([makeSnapshot('demo-skill', 'team')]));

    const error = await captured.handlers.get('skills/list')!({ cursor: 'not-a-cursor' }).catch(
      (cause: unknown) => cause,
    );
    expect(error).toBeInstanceOf(ProtocolError);
    expect((error as ProtocolError).code).toBe(INVALID_PARAMS);
    expect((error as ProtocolError).message).toBe('Invalid skills cursor');
  });

  it('rethrows unexpected catalog errors unchanged', async () => {
    const captured = captureServer();
    const broken = {
      list: () => {
        throw new Error('catalog exploded');
      },
    } as unknown as Catalog;
    registerSkills(captured.server, broken);

    await expect(captured.handlers.get('skills/list')!({ cursor: undefined })).rejects.toThrow(
      'catalog exploded',
    );
  });

  it('returns one whole skill entry via skills/get', async () => {
    const captured = captureServer();
    const snapshot = makeSnapshot('demo-skill', 'team');
    registerSkills(captured.server, new SkillCatalog([snapshot]));

    const result = (await captured.handlers.get('skills/get')!({ uri: snapshot.entry.uri })) as {
      resultType: string;
      ttlMs: number;
      cacheScope: string;
      skill: unknown;
    };
    expect(result).toEqual({
      resultType: 'complete',
      ttlMs: 60_000,
      cacheScope: 'private',
      skill: snapshot.entry,
    });
  });

  it('rejects unknown skill URIs with INVALID_PARAMS', async () => {
    const captured = captureServer();
    registerSkills(captured.server, new SkillCatalog([makeSnapshot('demo-skill', 'team')]));

    const error = await captured.handlers.get('skills/get')!({
      uri: 'skill://team/rev-unknown/demo-skill/SKILL.md',
    }).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(ProtocolError);
    expect((error as ProtocolError).code).toBe(INVALID_PARAMS);
    expect((error as ProtocolError).message).toBe('Unknown skill URI');
  });

  it('lists published files through the resource template and reads their contents', async () => {
    const captured = captureServer();
    const snapshot = makeSnapshot('demo-skill', 'team');
    registerSkills(captured.server, new SkillCatalog([snapshot]));

    const list = await captured.resources[0].template.listCallback!();
    expect(
      (list as { resources: Array<{ uri: string }> }).resources.map((file) => file.uri),
    ).toEqual(snapshot.entry.resources.map((file) => file.uri));

    const notes = snapshot.entry.resources.find((file) => file.uri.endsWith('/notes.txt'))!;
    const contents = (await captured.resources[0].read(new URL(notes.uri))) as {
      contents: Array<{ uri: string; mimeType: string; text: string }>;
    };
    expect(contents).toEqual({
      contents: [{ uri: notes.uri, mimeType: 'text/plain', text: 'demo-skill notes' }],
    });

    const error = await captured.resources[0]
      .read(new URL('skill://team/rev-unknown/demo-skill/missing.txt'))
      .catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(ProtocolError);
    expect((error as ProtocolError).code).toBe(INVALID_PARAMS);
    expect((error as ProtocolError).message).toBe('Unknown skill file URI');
  });
});
