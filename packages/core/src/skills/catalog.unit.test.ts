import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

import { SkillCatalog } from './catalog.js';
import { loadLocalSkillSnapshot, snapshotFromFiles } from './local-snapshot.js';

import type { SkillSnapshot } from './local-snapshot.js';

const directory = fileURLToPath(new URL('./__fixtures__/review-code', import.meta.url));

describe('published skill catalog views', () => {
  let first: SkillSnapshot;
  let second: SkillSnapshot;
  beforeAll(async () => {
    first = await loadLocalSkillSnapshot(directory, 'team-a');
    second = await loadLocalSkillSnapshot(directory, 'team-b');
  });

  it('retains same-named skills from separate origins and pages whole entries', () => {
    const catalog = new SkillCatalog([second, first]);
    const page = catalog.list(undefined, 1);
    expect(page.skills.map((skill) => skill.uri)).toEqual([first.entry.uri]);
    expect(page.skills[0].resources).toEqual(first.entry.resources);
    const next = catalog.list(page.nextCursor, 1);
    expect(next.skills.map((skill) => skill.uri)).toEqual([second.entry.uri]);
    expect(next.nextCursor).toBeUndefined();
  });

  it('supports direct get before list and isolates file reads to a view', () => {
    const catalog = new SkillCatalog([first], 'group-a');
    expect(catalog.get(first.entry.uri)).toEqual(first.entry);
    expect(catalog.read(first.entry.uri)).toBeDefined();
    expect(catalog.get(second.entry.uri)).toBeUndefined();
    expect(catalog.read(second.entry.uri)).toBeUndefined();
    expect(catalog.get(first.entry.resources[1].uri)).toBeUndefined();
  });

  it('binds cursors to content and the publication view', () => {
    const groupA = new SkillCatalog([first, second], 'group-a');
    const cursor = groupA.list(undefined, 1).nextCursor;
    expect(() => new SkillCatalog([first, second], 'group-b').list(cursor, 1)).toThrow(
      'Invalid skills cursor',
    );
    expect(() => new SkillCatalog([first], 'group-a').list(cursor, 1)).toThrow(
      'Invalid skills cursor',
    );
    expect(() => groupA.list('not-a-cursor', 1)).toThrow('Invalid skills cursor');
    expect(() => groupA.list('', 1)).toThrow('Invalid skills cursor');
    expect(() => groupA.list(undefined, 0)).toThrow('Invalid skill page size');
  });

  it('returns independent entries and lists only published resources', () => {
    const catalog = new SkillCatalog([first]);
    const entry = catalog.list().skills[0];
    entry.frontmatter.description = 'changed';
    entry.resources.length = 0;
    expect(catalog.get(first.entry.uri)).toEqual(first.entry);
    expect(catalog.resources().map((file) => file.uri)).toEqual(
      first.entry.resources.map((file) => file.uri),
    );
  });

  it('supports an empty publication and rejects duplicate URIs', () => {
    expect(new SkillCatalog([]).list()).toEqual({ skills: [] });
    expect(() => new SkillCatalog([first, first])).toThrow('Duplicate skill URI');
  });
});

describe('catalog resource listings and cursor offsets', () => {
  const markdown = (name: string, description: string) =>
    Buffer.from(`---\nname: ${name}\ndescription: ${description}\n---\nBody.\n`);
  const snapshot = (name: string, description = `${name} instructions.`) =>
    snapshotFromFiles(
      [
        { path: 'SKILL.md', bytes: markdown(name, description) },
        { path: 'notes.txt', bytes: Buffer.from('root-level notes') },
        { path: 'references/checklist.md', bytes: Buffer.from('checklist') },
      ],
      'team',
      name,
    );

  it('names the entry by its skill and every supporting file by its own filename', () => {
    const catalog = new SkillCatalog([snapshot('demo-skill', 'The demo description.')]);
    const resources = catalog.resources();
    const entryResource = resources.find((file) => file.uri.endsWith('/SKILL.md'))!;
    expect(entryResource).toMatchObject({
      name: 'demo-skill',
      description: 'The demo description.',
      mimeType: 'text/markdown',
    });
    const rootFile = resources.find((file) => file.uri.endsWith('/notes.txt'))!;
    expect(rootFile).toMatchObject({ name: 'notes.txt', mimeType: 'text/plain' });
    expect('description' in rootFile).toBe(false);
    const nestedFile = resources.find((file) => file.uri.endsWith('/checklist.md'))!;
    expect(nestedFile).toMatchObject({ name: 'checklist.md', mimeType: 'text/markdown' });
    expect('description' in nestedFile).toBe(false);
  });

  it('pages through every entry in ascending URI order', () => {
    const snapshots = [snapshot('beta-skill'), snapshot('alpha-skill'), snapshot('gamma-skill')];
    const catalog = new SkillCatalog(snapshots);
    const ordered = catalog.list(undefined, 10).skills.map((skill) => skill.uri);
    expect(ordered).toEqual([...ordered].sort());
    const firstPage = catalog.list(undefined, 2);
    expect(firstPage.skills.map((skill) => skill.uri)).toEqual(ordered.slice(0, 2));
    const secondPage = catalog.list(firstPage.nextCursor, 2);
    expect(secondPage.skills.map((skill) => skill.uri)).toEqual(ordered.slice(2));
    expect(secondPage.nextCursor).toBeUndefined();
  });

  it('rejects forged cursors with out-of-range offsets for the same view', () => {
    const catalog = new SkillCatalog([snapshot('alpha-skill'), snapshot('beta-skill')]);
    const cursor = catalog.list(undefined, 1).nextCursor!;
    const decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as {
      view: string;
      offset: number;
    };
    const forge = (offset: number) =>
      Buffer.from(JSON.stringify({ view: decoded.view, offset })).toString('base64url');
    expect(() => catalog.list(forge(0), 1)).toThrow('Invalid skills cursor');
    expect(() => catalog.list(forge(2), 1)).toThrow('Invalid skills cursor');
    expect(() => catalog.list(forge(1.5), 1)).toThrow('Invalid skills cursor');
    expect(() => catalog.list(forge(-1), 1)).toThrow('Invalid skills cursor');
    expect(() => catalog.list(forge(Number.MAX_SAFE_INTEGER + 1), 1)).toThrow(
      'Invalid skills cursor',
    );
  });

  it('returns independent entry copies from get', () => {
    const catalog = new SkillCatalog([snapshot('demo-skill')]);
    const uri = catalog.list().skills[0].uri;
    const leaked = catalog.get(uri)!;
    leaked.frontmatter.description = 'changed';
    leaked.resources.length = 0;
    expect(catalog.get(uri)?.frontmatter.description).toBe('demo-skill instructions.');
    expect(catalog.get(uri)?.resources).toHaveLength(3);
  });
});
