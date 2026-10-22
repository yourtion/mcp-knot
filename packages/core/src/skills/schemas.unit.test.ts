import { describe, expect, it } from 'vitest';

import {
  GetSkillParamsSchema,
  GetSkillResultSchema,
  ListSkillsParamsSchema,
  ListSkillsResultSchema,
  ListSkillsPayloadSchema,
  MAX_SKILL_BYTES,
  MAX_SKILL_FILES,
  SKILLS_EXTENSION,
  SkillEntrySchema,
  SkillFrontmatterSchema,
  SkillResourceSchema,
} from './schemas.js';

const baseFrontmatter = { name: 'demo-skill', description: 'A demo skill.' };
const digest = `sha256:${'a'.repeat(64)}`;
const resource = { uri: 'skill://team/rev-x/demo-skill/SKILL.md', digest, size: 12 };
const entry = {
  uri: 'skill://team/rev-x/demo-skill/SKILL.md',
  frontmatter: baseFrontmatter,
  resources: [resource],
};
const cacheFields = { resultType: 'complete', ttlMs: 60_000, cacheScope: 'private' } as const;

describe('skills wire schemas', () => {
  it('pins the extension identifier and snapshot limits', () => {
    expect(SKILLS_EXTENSION).toBe('io.modelcontextprotocol/skills');
    expect(MAX_SKILL_FILES).toBe(512);
    expect(MAX_SKILL_BYTES).toBe(16 * 1024 * 1024);
  });

  describe('SkillFrontmatterSchema', () => {
    it('accepts a name of exactly 64 characters and the optional metadata fields', () => {
      const parsed = SkillFrontmatterSchema.safeParse({
        ...baseFrontmatter,
        name: 'a'.repeat(64),
        license: 'MIT OR Apache-2.0',
        compatibility: 'c'.repeat(500),
        'allowed-tools': 'Read, Grep',
        metadata: { owner: 'team', tier: 'gold' },
      });
      expect(parsed.success).toBe(true);
    });

    it.each([
      { name: 'a'.repeat(65) },
      { name: 'demo_skill' },
      { name: 'Demo-Skill' },
      { name: '-demo' },
      { name: '' },
      { description: '' },
      { description: '   ' },
      { description: 'd'.repeat(1025) },
      { compatibility: 'c'.repeat(501) },
      { metadata: { count: 1 } },
      { metadata: { list: ['a'] } },
      { metadata: null },
      { metadata: 'team' },
      { metadata: { nested: { deep: true } } },
    ])('rejects invalid frontmatter %j', (fields) => {
      expect(SkillFrontmatterSchema.safeParse({ ...baseFrontmatter, ...fields }).success).toBe(
        false,
      );
    });

    it('accepts a description of exactly 1024 characters', () => {
      expect(
        SkillFrontmatterSchema.safeParse({ ...baseFrontmatter, description: 'd'.repeat(1024) })
          .success,
      ).toBe(true);
    });

    it('requires JSON-safe values and rejects non-plain object prototypes', () => {
      expect(SkillFrontmatterSchema.safeParse({ ...baseFrontmatter, 'x-extra': NaN }).success).toBe(
        false,
      );
      expect(
        SkillFrontmatterSchema.safeParse({ ...baseFrontmatter, 'x-extra': Infinity }).success,
      ).toBe(false);
      expect(
        SkillFrontmatterSchema.safeParse({
          ...baseFrontmatter,
          'x-extra': { nested: new Date(0) },
        }).success,
      ).toBe(false);
      expect(
        SkillFrontmatterSchema.safeParse({ ...baseFrontmatter, 'x-extra': new Map() }).success,
      ).toBe(false);
      expect(
        SkillFrontmatterSchema.safeParse({ ...baseFrontmatter, 'x-extra': () => 'nope' }).success,
      ).toBe(false);
      expect(
        SkillFrontmatterSchema.safeParse({ ...baseFrontmatter, 'x-extra': [1, 'two', null, false] })
          .success,
      ).toBe(true);
      const detached = Object.assign(Object.create(null), baseFrontmatter);
      expect(SkillFrontmatterSchema.safeParse(detached).success).toBe(true);
    });

    it('rejects circular references instead of recursing forever', () => {
      const cyclic: Record<string, unknown> = { ...baseFrontmatter };
      cyclic.self = cyclic;
      expect(SkillFrontmatterSchema.safeParse(cyclic).success).toBe(false);
    });

    it('preserves extra string keys through the JSON catchall', () => {
      const parsed = SkillFrontmatterSchema.safeParse({ ...baseFrontmatter, extra: ['list', 1] });
      expect(parsed.success).toBe(true);
    });
  });

  describe('SkillResourceSchema and SkillEntrySchema', () => {
    it('accepts a well-formed resource and entry', () => {
      expect(SkillResourceSchema.safeParse(resource).success).toBe(true);
      expect(SkillEntrySchema.safeParse(entry).success).toBe(true);
      expect(SkillEntrySchema.safeParse({ ...entry, resources: 'dynamic' }).success).toBe(true);
    });

    it.each([
      { digest: 'not-a-digest' },
      { digest: `sha256:${'a'.repeat(63)}` },
      { digest: `sha256:${'a'.repeat(65)}` },
      { digest: `sha256:${'A'.repeat(64)}` },
      { digest: `md5:${'a'.repeat(32)}` },
      { digest: `${'a'.repeat(64)}` },
      { size: -1 },
      { size: 1.5 },
      { uri: '' },
    ])('rejects an invalid resource %j', (overrides) => {
      expect(SkillResourceSchema.safeParse({ ...resource, ...overrides }).success).toBe(false);
    });

    it('rejects entries with invalid resources or frontmatter', () => {
      expect(
        SkillEntrySchema.safeParse({ ...entry, resources: [{ ...resource, digest: 'nope' }] })
          .success,
      ).toBe(false);
      expect(SkillEntrySchema.safeParse({ ...entry, uri: '' }).success).toBe(false);
      expect(SkillEntrySchema.safeParse({ ...entry, frontmatter: { name: 'x' } }).success).toBe(
        false,
      );
    });
  });

  describe('request parameter schemas', () => {
    it('treats the list cursor as optional but requires a non-empty get URI', () => {
      expect(ListSkillsParamsSchema.safeParse({}).success).toBe(true);
      expect(ListSkillsParamsSchema.safeParse({ cursor: 'abc' }).success).toBe(true);
      expect(GetSkillParamsSchema.safeParse({ uri: entry.uri }).success).toBe(true);
      expect(GetSkillParamsSchema.safeParse({ uri: '' }).success).toBe(false);
      expect(GetSkillParamsSchema.safeParse({}).success).toBe(false);
    });
  });

  describe('result schemas', () => {
    it('accepts a complete list result and allows an optional next cursor', () => {
      expect(ListSkillsResultSchema.safeParse({ ...cacheFields, skills: [entry] }).success).toBe(
        true,
      );
      expect(
        ListSkillsResultSchema.safeParse({
          ...cacheFields,
          skills: [entry],
          nextCursor: 'next',
        }).success,
      ).toBe(true);
    });

    it.each([
      { ...cacheFields, skills: [entry], resultType: 'incremental' },
      { ...cacheFields, skills: [entry], ttlMs: -1 },
      { ...cacheFields, skills: [entry], ttlMs: 1.5 },
      { ...cacheFields, skills: [entry], cacheScope: 'shared' },
      { ...cacheFields },
    ])('rejects an invalid list result %j', (value) => {
      expect(ListSkillsResultSchema.safeParse(value).success).toBe(false);
    });

    it('accepts a get result and rejects one without a skill', () => {
      expect(GetSkillResultSchema.safeParse({ ...cacheFields, skill: entry }).success).toBe(true);
      expect(GetSkillResultSchema.safeParse({ ...cacheFields }).success).toBe(false);
    });

    it('strips the wire-only resultType from client payloads', () => {
      const payload = ListSkillsPayloadSchema.parse({ ...cacheFields, skills: [entry] });
      expect(Object.hasOwn(payload, 'resultType')).toBe(false);
      expect(ListSkillsPayloadSchema.safeParse({ ...cacheFields, skills: [entry] }).success).toBe(
        true,
      );
      expect(
        ListSkillsPayloadSchema.safeParse({
          ttlMs: cacheFields.ttlMs,
          cacheScope: cacheFields.cacheScope,
          skills: [entry],
        }).success,
      ).toBe(true);
    });
  });
});
