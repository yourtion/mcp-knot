import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadLocalSkillSnapshot } from './local-snapshot.js';
import { MAX_SKILL_BYTES, MAX_SKILL_FILES } from './schemas.js';

const skillText = `---
name: review-code
description: Review changes with evidence.
metadata:
  version: "1.0"
x-extra:
  enabled: true
  count: 2
  values: [null, "11"]
---
Read references/checklist.md when needed.
`;

describe('local skill snapshots', () => {
  let temp: string;
  let root: string;

  beforeEach(async () => {
    temp = await mkdtemp(join(tmpdir(), 'mcp-knot-skills-'));
    root = join(temp, 'review-code');
    await mkdir(join(root, 'references'), { recursive: true });
    await writeFile(join(root, 'SKILL.md'), skillText);
    await writeFile(join(root, 'references', 'checklist.md'), '检查变更。\r\n');
  });

  afterEach(async () => {
    await rm(temp, { recursive: true, force: true });
  });

  it('preserves all frontmatter and hashes every supporting file using raw bytes', async () => {
    const snapshot = await loadLocalSkillSnapshot(root, 'team');
    expect(snapshot.entry.frontmatter).toMatchObject({
      name: 'review-code',
      metadata: { version: '1.0' },
      'x-extra': { enabled: true, count: 2, values: [null, '11'] },
    });
    expect(snapshot.entry.uri).toMatch(/^skill:\/\/team\/rev-[0-9a-f]{64}\/review-code\/SKILL.md$/);
    expect(snapshot.entry.resources).toHaveLength(2);
    for (const resource of snapshot.entry.resources) {
      const contents = snapshot.read(resource.uri)!;
      const bytes =
        'text' in contents ? Buffer.from(contents.text) : Buffer.from(contents.blob, 'base64');
      expect(bytes.length).toBe(resource.size);
      expect(`sha256:${createHash('sha256').update(bytes).digest('hex')}`).toBe(resource.digest);
    }
  });

  it('keeps listed bytes after source edits or deletions and creates a new revision on reload', async () => {
    const first = await loadLocalSkillSnapshot(root);
    const reference = first.entry.resources.find((file) => file.uri.endsWith('/checklist.md'))!;
    await writeFile(
      join(root, 'SKILL.md'),
      skillText.replace('Review changes', 'Review updated changes'),
    );
    await rm(join(root, 'references', 'checklist.md'));
    expect(first.read(first.entry.uri)).toMatchObject({ text: skillText });
    expect(first.read(reference.uri)).toMatchObject({ text: '检查变更。\r\n' });
    const second = await loadLocalSkillSnapshot(root);
    expect(second.entry.uri).not.toBe(first.entry.uri);
    expect(second.entry.resources).toHaveLength(1);
  });

  it('preserves special JSON keys without changing object prototypes', async () => {
    await writeFile(
      join(root, 'SKILL.md'),
      skillText.replace(
        'x-extra:',
        '__proto__: { note: original }\nconstructor: original\nx-extra:\n  __proto__: { nested: true }',
      ),
    );
    const frontmatter = (await loadLocalSkillSnapshot(root)).entry.frontmatter;
    expect(Object.hasOwn(frontmatter, '__proto__')).toBe(true);
    expect(JSON.parse(JSON.stringify(frontmatter))).toMatchObject(
      JSON.parse(
        '{"__proto__":{"note":"original"},"constructor":"original","x-extra":{"__proto__":{"nested":true}}}',
      ),
    );
    expect(Object.getPrototypeOf(frontmatter)).toBe(Object.prototype);
    expect(Object.hasOwn(Object.prototype, 'note')).toBe(false);
  });

  it.each(['__proto__: .inf', 'metadata: { __proto__: false }'])(
    'rejects invalid values under special keys: %s',
    async (field) => {
      await writeFile(
        join(root, 'SKILL.md'),
        `---\nname: review-code\ndescription: Review changes.\n${field}\n---\n`,
      );
      await expect(loadLocalSkillSnapshot(root)).rejects.toThrow('Invalid skill frontmatter');
    },
  );

  it('returns independent metadata copies', async () => {
    const snapshot = await loadLocalSkillSnapshot(root);
    const entry = snapshot.entry;
    entry.frontmatter.name = 'changed';
    entry.resources.length = 0;
    expect(snapshot.entry.frontmatter.name).toBe('review-code');
    expect(snapshot.entry.resources).toHaveLength(2);
  });

  it('preserves UTF-8 BOMs and CRLF bytes', async () => {
    const bytes = Buffer.from(`\uFEFF${skillText.replaceAll('\n', '\r\n')}`);
    await writeFile(join(root, 'SKILL.md'), bytes);
    const snapshot = await loadLocalSkillSnapshot(root);
    const contents = snapshot.read(snapshot.entry.uri)!;
    expect('text' in contents && Buffer.from(contents.text).equals(bytes)).toBe(true);
  });

  it('serves binary assets and non-UTF-8 supporting text byte-exactly as blobs', async () => {
    const bytes = Buffer.from([0, 255, 128, 10]);
    await writeFile(join(root, 'asset.bin'), bytes);
    await writeFile(join(root, 'legacy.txt'), bytes);
    const snapshot = await loadLocalSkillSnapshot(root);
    for (const filename of ['asset.bin', 'legacy.txt']) {
      const resource = snapshot.entry.resources.find((file) => file.uri.endsWith(`/${filename}`))!;
      expect(snapshot.read(resource.uri)).toMatchObject({ blob: bytes.toString('base64') });
    }
  });

  it('includes nested skills as supporting files without activating them', async () => {
    await mkdir(join(root, 'nested'));
    await writeFile(
      join(root, 'nested', 'SKILL.md'),
      '---\nname: nested\ndescription: A nested fixture.\n---\n',
    );
    const snapshot = await loadLocalSkillSnapshot(root);
    expect(snapshot.entry.resources.some((file) => file.uri.endsWith('/nested/SKILL.md'))).toBe(
      true,
    );
    expect(snapshot.entry.frontmatter.name).toBe('review-code');
  });

  it('encodes filename segments while keeping relative resource resolution valid', async () => {
    await writeFile(join(root, 'references', 'a #中文.md'), 'reference');
    const snapshot = await loadLocalSkillSnapshot(root);
    const uri = new URL('references/a%20%23%E4%B8%AD%E6%96%87.md', snapshot.entry.uri).href;
    expect(snapshot.read(uri)).toMatchObject({ text: 'reference' });
    expect(snapshot.read(new URL('../../SKILL.md', snapshot.entry.uri).href)).toBeUndefined();
  });

  it.each(['代码审查', 'révision', 're\u0301vision', 'ｒｅｖｉｅｗ'])(
    'supports Unicode skill name %s without rewriting frontmatter',
    async (name) => {
      const localized = join(temp, name);
      await cp(root, localized, { recursive: true });
      await writeFile(
        join(localized, 'SKILL.md'),
        skillText.replace('name: review-code', `name: ${name}`),
      );
      const snapshot = await loadLocalSkillSnapshot(localized);
      expect(snapshot.entry.frontmatter.name).toBe(name);
      expect(snapshot.entry.uri.endsWith(`/${encodeURIComponent(name)}/SKILL.md`)).toBe(true);
      expect(snapshot.read(new URL(snapshot.entry.uri).href)).toBeDefined();
    },
  );

  it('rejects missing SKILL.md and a directory/name mismatch', async () => {
    await rm(join(root, 'SKILL.md'));
    await expect(loadLocalSkillSnapshot(root)).rejects.toThrow('must contain SKILL.md');
    await writeFile(join(root, 'SKILL.md'), skillText.replace('name: review-code', 'name: other'));
    await expect(loadLocalSkillSnapshot(root)).rejects.toThrow('directory name must match');
  });

  it.each(['Review-Code', '-review', 'review-', 'review--code', 'a'.repeat(65)])(
    'rejects invalid name %s',
    async (name) => {
      await writeFile(
        join(root, 'SKILL.md'),
        skillText.replace('name: review-code', `name: ${name}`),
      );
      await expect(loadLocalSkillSnapshot(root)).rejects.toThrow('Invalid skill frontmatter');
    },
  );

  it('rejects duplicate YAML keys and an alias expansion bomb', async () => {
    await writeFile(
      join(root, 'SKILL.md'),
      skillText.replace('name: review-code', 'name: review-code\nname: other'),
    );
    await expect(loadLocalSkillSnapshot(root)).rejects.toThrow('Invalid skill YAML');
    await writeFile(
      join(root, 'SKILL.md'),
      '---\nname: review-code\ndescription: Alias fixture.\na: &a [a, a]\nb: &b [*a, *a]\nc: &c [*b, *b]\nd: &d [*c, *c]\ne: [*d, *d, *d, *d, *d, *d, *d, *d]\n---\n',
    );
    await expect(loadLocalSkillSnapshot(root)).rejects.toThrow();
  });

  it('rejects symbolic links both inside the tree and as the skill root', async () => {
    const secret = join(temp, 'secret.txt');
    await writeFile(secret, 'not a published file');
    await symlink(secret, join(root, 'leak.txt'));
    await expect(loadLocalSkillSnapshot(root)).rejects.toThrow('Symbolic links are not served');
    await rm(join(root, 'leak.txt'));
    const linkedRoot = join(temp, 'linked-root');
    await symlink(root, linkedRoot);
    await expect(loadLocalSkillSnapshot(linkedRoot)).rejects.toThrow('not a symbolic link');
  });

  it('supports the 512-file boundary and rejects one extra file', async () => {
    await rm(join(root, 'references'), { recursive: true });
    await Promise.all(
      Array.from({ length: MAX_SKILL_FILES - 1 }, (_, index) =>
        writeFile(join(root, `${index}.txt`), ''),
      ),
    );
    expect((await loadLocalSkillSnapshot(root)).entry.resources).toHaveLength(MAX_SKILL_FILES);
    await writeFile(join(root, 'extra.txt'), '');
    await expect(loadLocalSkillSnapshot(root)).rejects.toThrow('exceeds 512 files');
  });

  it('supports the 16-MiB boundary and rejects an oversized skill', async () => {
    await rm(join(root, 'references'), { recursive: true });
    const mainSize = (await readFile(join(root, 'SKILL.md'))).length;
    await writeFile(join(root, 'asset.bin'), Buffer.alloc(MAX_SKILL_BYTES - mainSize));
    expect(
      (await loadLocalSkillSnapshot(root)).entry.resources.reduce(
        (size, file) => size + file.size,
        0,
      ),
    ).toBe(MAX_SKILL_BYTES);
    await writeFile(join(root, 'extra.txt'), 'x');
    await expect(loadLocalSkillSnapshot(root)).rejects.toThrow('exceeds 16 MiB');
  });
});
