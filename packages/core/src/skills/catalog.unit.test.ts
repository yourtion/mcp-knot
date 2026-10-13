import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

import { SkillCatalog } from './catalog.js';
import { loadLocalSkillSnapshot } from './local-snapshot.js';

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
