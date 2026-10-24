import { createHash } from 'node:crypto';
import { cp, link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { TestContext, useTestContext } from '../../../../test/context/test-context.js';
import { loadLocalSkillSnapshot, skillMimeType, snapshotFromFiles } from './local-snapshot.js';
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
    const directory = temp;
    useTestContext().register('temporary-directory', () =>
      rm(directory, { recursive: true, force: true }),
    );
    root = join(temp, 'review-code');
    await mkdir(join(root, 'references'), { recursive: true });
    await writeFile(join(root, 'SKILL.md'), skillText);
    await writeFile(join(root, 'references', 'checklist.md'), '检查变更。\r\n');
  });

  afterEach(async () => {
    await TestContext.resetCurrent();
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

  it('rejects a regular file used as the skill root', async () => {
    const file = join(temp, 'plain.txt');
    await writeFile(file, 'not a directory');
    await expect(loadLocalSkillSnapshot(file)).rejects.toThrow(
      'Skill root must be a directory, not a symbolic link',
    );
  });

  it('rejects hard-linked skill files', async () => {
    const original = join(temp, 'original.md');
    await writeFile(original, 'linked content');
    await link(original, join(root, 'hard-linked.md'));
    await expect(loadLocalSkillSnapshot(root)).rejects.toThrow(
      'Skill files must be regular, unlinked files',
    );
  });
});

describe('skill MIME type mapping', () => {
  it.each([
    ['.md', 'text/markdown'],
    ['.txt', 'text/plain'],
    ['.json', 'application/json'],
    ['.yaml', 'application/yaml'],
    ['.yml', 'application/yaml'],
    ['.csv', 'text/csv'],
    ['.sh', 'text/x-shellscript'],
    ['.py', 'text/x-python'],
    ['.js', 'text/javascript'],
    ['.ts', 'text/plain'],
    ['.svg', 'image/svg+xml'],
    ['.png', 'image/png'],
    ['.jpg', 'image/jpeg'],
    ['.pdf', 'application/pdf'],
    ['.MD', 'text/markdown'],
    ['.Png', 'image/png'],
    ['.bin', 'application/octet-stream'],
    ['README', 'application/octet-stream'],
    ['archive.tar.gz', 'application/octet-stream'],
  ])('maps %s to %s', (extension, mimeType) => {
    expect(skillMimeType(`dir/file${extension}`)).toBe(mimeType);
  });
});

describe('skill frontmatter boundaries', () => {
  let temp: string;
  let root: string;

  beforeEach(async () => {
    temp = await mkdtemp(join(tmpdir(), 'mcp-knot-frontmatter-'));
    const directory = temp;
    useTestContext().register('temporary-directory', () =>
      rm(directory, { recursive: true, force: true }),
    );
    root = join(temp, 'review-code');
    await mkdir(root, { recursive: true });
  });

  afterEach(async () => {
    await TestContext.resetCurrent();
  });

  it('rejects frontmatter that does not start the file', async () => {
    await writeFile(
      join(root, 'SKILL.md'),
      'Intro before frontmatter.\n---\nname: review-code\ndescription: x.\n---\n',
    );
    await expect(loadLocalSkillSnapshot(root)).rejects.toThrow(
      'SKILL.md must begin with YAML frontmatter',
    );
  });

  it('accepts a document that ends exactly at the closing delimiter', async () => {
    const bytes = Buffer.from('---\nname: review-code\ndescription: x.\n---');
    await writeFile(join(root, 'SKILL.md'), bytes);
    const snapshot = await loadLocalSkillSnapshot(root);
    expect(snapshot.read(snapshot.entry.uri)).toMatchObject({ text: bytes.toString('utf8') });
  });

  it.each(['Team', 'team!', '-team', '/team', 'team/', 'a/BAD'])(
    'rejects the unsafe namespace %s',
    async (namespace) => {
      await writeFile(join(root, 'SKILL.md'), skillText);
      await expect(loadLocalSkillSnapshot(root, namespace)).rejects.toThrow(
        'Skill namespace must contain URI-safe lowercase path segments',
      );
    },
  );

  it('accepts nested lowercase namespaces', async () => {
    await writeFile(join(root, 'SKILL.md'), skillText);
    const snapshot = await loadLocalSkillSnapshot(root, 'team-a/group_b.c');
    expect(snapshot.entry.uri.startsWith('skill://team-a/group_b.c/')).toBe(true);
  });
});

describe('snapshot reconstruction from persisted files', () => {
  const markdown = (name: string) =>
    Buffer.from(`---\nname: ${name}\ndescription: Fixture skill.\n---\nBody.\n`);
  const input = (files: Array<[string, Buffer | string]>) =>
    files.map(([path, bytes]) => ({
      path,
      bytes: Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes),
    }));

  it.each(['', 'a\\b', 'a\0b', '/leading', 'trailing/', 'a//b', '.', '..', 'a/.', 'a/..', 'a/.'])(
    'rejects the invalid stored path %j',
    (path) => {
      expect(() =>
        snapshotFromFiles(
          [
            { path: 'SKILL.md', bytes: markdown('demo-skill') },
            { path, bytes: Buffer.from('x') },
          ],
          'team',
          'demo-skill',
        ),
      ).toThrow('Invalid snapshot file path');
    },
  );

  it('rejects duplicate stored paths', () => {
    expect(() =>
      snapshotFromFiles(
        input([
          ['SKILL.md', markdown('demo-skill')],
          ['notes.txt', 'one'],
          ['notes.txt', 'two'],
        ]),
        'team',
        'demo-skill',
      ),
    ).toThrow('Duplicate snapshot file path');
  });

  it('rejects snapshots above the file or byte limits', () => {
    const files = input([['SKILL.md', markdown('demo-skill')]]);
    for (let index = 0; index < MAX_SKILL_FILES; index += 1)
      files.push({ path: `f${index}.txt`, bytes: Buffer.alloc(0) });
    expect(() => snapshotFromFiles(files, 'team', 'demo-skill')).toThrow(
      'Snapshot exceeds skill limits',
    );
    expect(() =>
      snapshotFromFiles(
        input([
          ['SKILL.md', markdown('demo-skill')],
          ['asset.bin', Buffer.alloc(MAX_SKILL_BYTES + 1)],
        ]),
        'team',
        'demo-skill',
      ),
    ).toThrow('Snapshot exceeds skill limits');
  });

  it('requires SKILL.md and a matching directory name', () => {
    expect(() =>
      snapshotFromFiles(input([['README.md', 'no skill here']]), 'team', 'demo-skill'),
    ).toThrow('Skill directory must contain SKILL.md');
    expect(() =>
      snapshotFromFiles(input([['SKILL.md', markdown('demo-skill')]]), 'team', 'other-skill'),
    ).toThrow('Skill directory name must match frontmatter.name');
    expect(() =>
      snapshotFromFiles(input([['SKILL.md', markdown('demo-skill')]]), 'team', 'demo-skiil'),
    ).toThrow('Skill directory name must match frontmatter.name');
  });

  it('matches directory names using NFKC normalization', () => {
    const snapshot = snapshotFromFiles(
      input([['SKILL.md', markdown('ｄｅｍｏ-ｓｋｉｌｌ')]]),
      'team',
      'demo-skill',
    );
    expect(snapshot.entry.frontmatter.name).toBe('ｄｅｍｏ-ｓｋｉｌｌ');
  });

  it('rejects unsafe namespaces before touching any file bytes', () => {
    expect(() =>
      snapshotFromFiles(input([['SKILL.md', markdown('demo-skill')]]), 'Team', 'demo-skill'),
    ).toThrow('Invalid snapshot namespace');
  });

  it('serves resources in sorted path order regardless of input order', () => {
    const snapshot = snapshotFromFiles(
      input([
        ['z-last.md', 'z'],
        ['SKILL.md', markdown('demo-skill')],
        ['a-first.md', 'a'],
      ]),
      'team',
      'demo-skill',
    );
    expect(snapshot.entry.resources.map((file) => file.uri.split('/').at(-1))).toEqual([
      'SKILL.md',
      'a-first.md',
      'z-last.md',
    ]);
  });

  it('keeps binary and image MIME types byte-exact even when the bytes are UTF-8', () => {
    const snapshot = snapshotFromFiles(
      input([
        ['SKILL.md', markdown('demo-skill')],
        ['logo.png', 'PNG-not-really'],
        ['data.bin', 'hello'],
      ]),
      'team',
      'demo-skill',
    );
    const read = (suffix: string) =>
      snapshot.read(snapshot.entry.resources.find((file) => file.uri.endsWith(suffix))!.uri);
    expect(read('logo.png')).toMatchObject({
      mimeType: 'image/png',
      blob: Buffer.from('PNG-not-really').toString('base64'),
    });
    expect(read('data.bin')).toMatchObject({
      mimeType: 'application/octet-stream',
      blob: Buffer.from('hello').toString('base64'),
    });
    expect(read('SKILL.md')).toMatchObject({ mimeType: 'text/markdown', text: expect.any(String) });
  });
});
