import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { TestContext, useTestContext } from '../../../../test/context/test-context.js';
import { SkillRepository } from './repository.js';
import { skillSourceFromCommand } from './sources.js';

import type { SkillCommandRunner } from './sources.js';

describe('persistent skill repository', () => {
  let temp: string;
  let source: string;
  let store: string;
  beforeEach(async () => {
    temp = await mkdtemp(join(tmpdir(), 'skills-repository-'));
    const directory = temp;
    useTestContext().register('temporary-directory', () =>
      rm(directory, { recursive: true, force: true }),
    );
    source = join(temp, 'source', 'grill-me');
    store = join(temp, 'store');
    await mkdir(source, { recursive: true });
    await writeFile(
      join(source, 'SKILL.md'),
      '---\nname: grill-me\ndescription: Ask about a design.\n---\nOriginal instructions.',
    );
    await writeFile(join(source, 'asset.bin'), Buffer.from([0, 255, 128]));
  });
  afterEach(async () => {
    await TestContext.resetCurrent();
  });
  async function local() {
    const repository = new SkillRepository(store);
    await repository.saveSource({
      id: 'team',
      type: 'local',
      directory: join(temp, 'source'),
      skills: ['grill-me'],
    });
    return repository;
  }

  it('restores byte-exact snapshots after restart without the original source', async () => {
    const repository = await local();
    const imported = await repository.sync('team');
    await rm(join(temp, 'source'), { recursive: true });
    const restarted = new SkillRepository(store, async () => {
      throw new Error('No upstream access');
    });
    const catalog = await restarted.catalog({ include: imported.selections }, 'group-a');
    expect(catalog.get(imported.skills[0].uri)).toEqual(imported.skills[0]);
    const binary = imported.skills[0].resources.find((resource) =>
      resource.uri.endsWith('asset.bin'),
    )!;
    expect(catalog.read(binary.uri)).toMatchObject({
      blob: Buffer.from([0, 255, 128]).toString('base64'),
    });
    expect(await restarted.latest('team')).toEqual(imported);
  });

  it('keeps old published bytes while candidates update and preserves last-good on failure', async () => {
    const repository = await local();
    const first = await repository.sync('team');
    await writeFile(
      join(source, 'SKILL.md'),
      '---\nname: grill-me\ndescription: Updated design.\n---\nNew instructions.',
    );
    const next = await repository.sync('team', 'update');
    expect(next.revision).not.toBe(first.revision);
    expect(
      (await repository.catalog({ include: first.selections }, 'old')).read(first.skills[0].uri),
    ).toMatchObject({ text: expect.stringContaining('Original instructions.') });
    await writeFile(join(source, 'SKILL.md'), 'invalid');
    await expect(repository.sync('team')).rejects.toThrow();
    expect((await repository.latest('team'))?.revision).toBe(next.revision);
    expect(
      (await repository.catalog({ include: next.selections }, 'new')).get(next.skills[0].uri),
    ).toBeDefined();
  });

  it('rejects corrupted persisted bytes and invalid revision/path selections', async () => {
    const repository = await local();
    const imported = await repository.sync('team');
    await expect(
      repository.catalog({ include: [{ ...imported.selections[0], sourceId: '../team' }] }, 'bad'),
    ).rejects.toThrow();
    await expect(
      repository.catalog({ include: [imported.selections[0], imported.selections[0]] }, 'bad'),
    ).rejects.toThrow('conflicting');
    await expect(
      repository.catalog({ include: [{ ...imported.selections[0], skill: 'missing' }] }, 'bad'),
    ).rejects.toThrow('not found');
    const file = join(store, 'revisions', 'team', `${imported.revision}.json`);
    const persisted = JSON.parse(await readFile(file, 'utf8'));
    persisted.snapshots[0].files[0].base64 = Buffer.from('corruption').toString('base64');
    await writeFile(file, JSON.stringify(persisted));
    await expect(repository.catalog({ include: imported.selections }, 'group-a')).rejects.toThrow();
  });

  it('resolves Git commit before checkout and never fetches when reading publication', async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const runner: SkillCommandRunner = async (command, args) => {
      calls.push({ command, args });
      if (args.includes('clone')) await cp(join(temp, 'source'), args.at(-1)!, { recursive: true });
      if (args.includes('rev-parse')) return 'a'.repeat(40);
      return '';
    };
    const repository = new SkillRepository(store, runner);
    await repository.saveSource({
      id: 'git-team',
      type: 'git',
      repository: 'https://github.com/team/skills.git',
      ref: 'main',
      skills: ['grill-me'],
    });
    const imported = await repository.sync('git-team');
    expect(imported.provenance.commit).toBe('a'.repeat(40));
    expect(calls.find((call) => call.args.includes('clone'))?.args).toContain(
      '--no-recurse-submodules',
    );
    expect(calls.at(-1)?.args).toEqual(
      expect.arrayContaining(['checkout', '--detach', 'a'.repeat(40)]),
    );
    const count = calls.length;
    await repository.catalog({ include: imported.selections }, 'group-a');
    expect(calls).toHaveLength(count);
  });

  it('pins resolved CLI version, isolates project install, and invokes update using its saved lock', async () => {
    const calls: Array<{ args: string[]; cwd: string }> = [];
    const runner: SkillCommandRunner = async (_command, args, cwd) => {
      calls.push({ args, cwd });
      if (args.includes('--version')) return '1.7.2\n';
      if (args.includes('add')) {
        await mkdir(join(cwd, '.agents', 'skills'), { recursive: true });
        await cp(source, join(cwd, '.agents', 'skills', 'grill-me'), { recursive: true });
        await writeFile(
          join(cwd, 'skills-lock.json'),
          JSON.stringify({ version: 1, skills: { 'grill-me': { source: 'mattpocock/skills' } } }),
        );
      }
      if (args.includes('update')) {
        expect(
          JSON.parse(await readFile(join(cwd, 'skills-lock.json'), 'utf8')).skills['grill-me']
            .source,
        ).toBe('mattpocock/skills');
        await writeFile(join(cwd, '.agents', 'skills', 'grill-me', 'asset.bin'), 'updated');
      }
      return '';
    };
    const repository = new SkillRepository(store, runner);
    await repository.saveSource(
      skillSourceFromCommand(
        'cli-team',
        'npx skills@latest add mattpocock/skills --skill=grill-me',
      ),
    );
    await expect(repository.sync('cli-team', 'update')).rejects.toThrow('before updating');
    const first = await repository.sync('cli-team');
    const next = await repository.sync('cli-team', 'update');
    expect(first.provenance.cliVersion).toBe('1.7.2');
    expect(next.revision).not.toBe(first.revision);
    expect(calls.find((call) => call.args.includes('add'))?.args).toEqual([
      '--yes',
      'skills@1.7.2',
      'add',
      'mattpocock/skills',
      '--skill',
      'grill-me',
      '--agent',
      'universal',
      '--copy',
      '--yes',
    ]);
    expect(calls.find((call) => call.args.includes('update'))?.args).toEqual([
      '--yes',
      'skills@1.7.2',
      'update',
      'grill-me',
      '--project',
      '--yes',
    ]);
    expect(calls.every((call) => call.cwd.startsWith(join(store, 'staging')))).toBe(true);
    expect(
      (await repository.catalog({ include: first.selections }, 'old')).get(first.skills[0].uri),
    ).toBeDefined();
  });

  it('keeps the last-good pointer when a reused persisted revision is corrupt', async () => {
    const repository = await local();
    const originalText = await readFile(join(source, 'SKILL.md'), 'utf8');
    const first = await repository.sync('team');
    await writeFile(join(source, 'SKILL.md'), originalText.replace('Original', 'Updated'));
    const lastGood = await repository.sync('team');
    const revisionPath = join(store, 'revisions', 'team', `${first.revision}.json`);
    const persisted = JSON.parse(await readFile(revisionPath, 'utf8'));
    persisted.snapshots[0].files[0].base64 = Buffer.from('corrupt').toString('base64');
    await writeFile(revisionPath, JSON.stringify(persisted));
    await writeFile(join(source, 'SKILL.md'), originalText);

    await expect(repository.sync('team')).rejects.toThrow();
    expect(await repository.latest('team')).toEqual(lastGood);
    const restarted = new SkillRepository(store);
    const catalog = await restarted.catalog({ include: lastGood.selections }, 'published');
    expect(catalog.get(lastGood.skills[0].uri)).toEqual(lastGood.skills[0]);
  });

  it('rejects changing a source identity after it has been saved', async () => {
    const repository = await local();
    await expect(
      repository.saveSource({ id: 'team', type: 'local', directory: temp, skills: ['grill-me'] }),
    ).rejects.toThrow('different configuration');
  });

  it('lists validated historical revisions after restart without accessing upstream', async () => {
    const repository = await local();
    expect(await repository.listRevisions('team')).toEqual([]);
    const first = await repository.sync('team');
    await writeFile(
      join(source, 'SKILL.md'),
      '---\nname: grill-me\ndescription: Updated design.\n---\nNew instructions.',
    );
    const next = await repository.sync('team', 'update');
    await repository.sync('team');
    await writeFile(join(store, 'revisions', 'team', 'unfinished.tmp'), 'partial');
    await rm(join(temp, 'source'), { recursive: true });
    const restarted = new SkillRepository(store, async () => {
      throw new Error('History must not fetch upstream');
    });
    const history = await restarted.listRevisions('team');
    expect(history).toHaveLength(2);
    expect(history).toEqual(expect.arrayContaining([first, next]));
    expect(history[0].importedAt >= history[1].importedAt).toBe(true);
    expect(await restarted.getRevision('team', first.revision)).toEqual(first);
    expect(await restarted.latest('team')).toEqual(next);
    expect(await restarted.getRevision('team', '0'.repeat(64))).toBeUndefined();
    await expect(restarted.listRevisions('../team')).rejects.toThrow();
    await expect(restarted.getRevision('team', '../latest')).rejects.toThrow();
  });

  it('does not offer a corrupted revision in the version history', async () => {
    const repository = await local();
    const imported = await repository.sync('team');
    const path = join(store, 'revisions', 'team', `${imported.revision}.json`);
    const persisted = JSON.parse(await readFile(path, 'utf8'));
    persisted.snapshots[0].files[0].base64 = Buffer.from('corruption').toString('base64');
    await writeFile(path, JSON.stringify(persisted));
    await expect(repository.listRevisions('team')).rejects.toThrow();
    await expect(repository.getRevision('team', imported.revision)).rejects.toThrow();
  });

  it.each([
    'npx skills@latest add mattpocock/skills --skill=grill-me; touch stolen',
    'npx skills@latest add mattpocock/skills --skill=$(whoami)',
    'npx other@latest add mattpocock/skills --skill=grill-me',
    'npx skills@latest add mattpocock/skills --skill=grill-me --global',
  ])('rejects unsupported command syntax: %s', (command) => {
    expect(() => skillSourceFromCommand('team', command)).toThrow();
  });
});
