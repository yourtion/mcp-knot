import { cp, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { TestContext, useTestContext } from '../../../../test/context/test-context.js';
import { acquireSkills, runSkillCommand, skillSourceFromCommand } from './sources.js';

import type { SkillCommandRunner } from './sources.js';

const skillMarkdown = (name: string) =>
  `---\nname: ${name}\ndescription: Fixture skill.\n---\nBody.\n`;

async function writeSkill(directory: string, name: string) {
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'SKILL.md'), skillMarkdown(name));
}

describe('skill command sources', () => {
  let temp: string;

  beforeEach(async () => {
    temp = await mkdtemp(join(tmpdir(), 'skills-sources-'));
    const directory = temp;
    useTestContext().register('temporary-directory', () =>
      rm(directory, { recursive: true, force: true }),
    );
  });

  afterEach(async () => {
    await TestContext.resetCurrent();
  });

  describe('runSkillCommand', () => {
    it('runs the command in its working directory with a hardened git environment', async () => {
      const output = await runSkillCommand(
        'node',
        [
          '-e',
          'console.log([process.env.GIT_TERMINAL_PROMPT, process.env.GIT_CONFIG_NOSYSTEM, process.env.GIT_CONFIG_GLOBAL, process.env.DISABLE_TELEMETRY, process.env.CI, process.env.npm_config_cache].join(" "))',
        ],
        temp,
      );
      expect(output.trim()).toBe(
        ['0', '1', '/dev/null', '1', '1', join(temp, '..', '.npm-cache')].join(' '),
      );
    });

    it('returns stdout from the configured working directory', async () => {
      const output = await runSkillCommand('node', ['-e', 'console.log(process.cwd())'], temp);
      expect(output.trim()).toBe(await realpath(temp));
    });
  });

  describe('skillSourceFromCommand', () => {
    it('accepts flexible whitespace, pinned versions, and space-separated skill names', () => {
      expect(
        skillSourceFromCommand(
          'team',
          'npx  skills@1.2.3   add   owner/repo   --skill   my-skill  ',
        ),
      ).toEqual({
        id: 'team',
        type: 'skills-cli',
        cliVersion: '1.2.3',
        repository: 'owner/repo',
        skills: ['my-skill'],
      });
    });

    it.each([
      'npx skills@12.34.5 add o/r --skill=x',
      'npx skills@1.22.3 add o/r --skill=x',
      'npx skills@1.2.33 add o/r --skill=x',
      'npx skills@latest add owner.name/repo_1-2 --skill=my-skill.v2',
    ])('accepts supported syntax %s', (command) => {
      expect(() => skillSourceFromCommand('team', command)).not.toThrow();
    });

    it.each([
      'sh -c npx skills@latest add o/r --skill=x',
      'evil npx skills@latest add o/r --skill=x',
    ])('rejects commands with leading content: %s', (command) => {
      expect(() => skillSourceFromCommand('team', command)).toThrow(
        'Supported command: npx skills@latest add owner/repo --skill=name',
      );
    });
  });

  describe('acquireSkills from a local directory', () => {
    it('snapshots the skill and records local provenance without a lock file', async () => {
      await writeSkill(join(temp, 'source', 'grill-me'), 'grill-me');
      const acquired = await acquireSkills(
        { id: 'team', type: 'local', directory: join(temp, 'source'), skills: ['grill-me'] },
        join(temp, 'staging'),
        'sync',
      );
      expect(acquired.snapshots).toHaveLength(1);
      expect(acquired.provenance).toStrictEqual({
        type: 'local',
        commit: undefined,
        cliVersion: undefined,
        paths: ['grill-me'],
      });
      expect(acquired.workspace).toBeUndefined();
    });

    it('rejects a symbolic-linked local source root', async () => {
      await writeSkill(join(temp, 'source', 'grill-me'), 'grill-me');
      await symlink(join(temp, 'source'), join(temp, 'linked'));
      await expect(
        acquireSkills(
          { id: 'team', type: 'local', directory: join(temp, 'linked'), skills: ['grill-me'] },
          join(temp, 'staging'),
          'sync',
        ),
      ).rejects.toThrow('Skill source cannot be a symbolic link');
    });
  });

  describe('acquireSkills from git', () => {
    let repo: string;

    beforeEach(async () => {
      repo = join(temp, 'fixture-repo');
      await writeSkill(join(repo, 'grill-me'), 'grill-me');
    });

    function gitRunner(commit: string, options: { failFirstRevParse?: boolean } = {}) {
      const calls: Array<{ command: string; args: string[]; cwd: string }> = [];
      const runner: SkillCommandRunner = async (command, args, cwd) => {
        calls.push({ command, args, cwd });
        if (args.includes('clone')) {
          await cp(repo, args.at(-1)!, { recursive: true });
          return '';
        }
        if (args.includes('rev-parse')) {
          if (options.failFirstRevParse && !args.join(' ').includes('refs/tags'))
            throw new Error('unknown revision');
          return commit;
        }
        return '';
      };
      return { calls, runner };
    }

    const source = (ref: string) => ({
      id: 'git-team',
      type: 'git' as const,
      repository: 'https://github.com/team/skills.git',
      ref,
      skills: ['grill-me'],
    });

    it('clones defensively and resolves a branch through its remote ref', async () => {
      const commit = 'b'.repeat(40);
      const { calls, runner } = gitRunner(commit);
      const staging = join(temp, 'staging');
      const acquired = await acquireSkills(source('main'), staging, 'sync', undefined, runner);

      expect(calls.find((call) => call.args.includes('clone'))?.args).toEqual([
        '-c',
        'core.hooksPath=/dev/null',
        '-c',
        'protocol.file.allow=never',
        'clone',
        '--no-checkout',
        '--no-recurse-submodules',
        '--',
        'https://github.com/team/skills.git',
        join(staging, 'repository'),
      ]);
      expect(calls.find((call) => call.args.includes('rev-parse'))?.args.slice(-2)).toEqual([
        '--verify',
        'refs/remotes/origin/main^{commit}',
      ]);
      expect(calls.at(-1)?.args).toEqual([
        '-c',
        'core.hooksPath=/dev/null',
        '-c',
        'filter.lfs.smudge=',
        '-c',
        'filter.lfs.required=false',
        'checkout',
        '--detach',
        commit,
      ]);
      expect(acquired.provenance).toStrictEqual({
        type: 'git',
        commit,
        cliVersion: undefined,
        paths: ['grill-me'],
      });
    });

    it.each([
      ['HEAD', 'HEAD'],
      ['a'.repeat(40), 'a'.repeat(40)],
    ])('resolves ref %s directly', async (ref, expected) => {
      const { calls, runner } = gitRunner('c'.repeat(40));
      await acquireSkills(source(ref), join(temp, 'staging'), 'sync', undefined, runner);
      expect(calls.find((call) => call.args.includes('rev-parse'))?.args.slice(-1)).toEqual([
        `${expected}^{commit}`,
      ]);
    });

    it.each([['a'.repeat(41)], [`z${'a'.repeat(40)}`], ['feature/x']])(
      'routes non-commit ref %s through refs/remotes/origin',
      async (ref) => {
        const { calls, runner } = gitRunner('c'.repeat(40));
        await acquireSkills(source(ref), join(temp, 'staging'), 'sync', undefined, runner);
        expect(calls.find((call) => call.args.includes('rev-parse'))?.args.slice(-1)).toEqual([
          `refs/remotes/origin/${ref}^{commit}`,
        ]);
      },
    );

    it('falls back to a tag ref when the remote ref is missing', async () => {
      const { calls, runner } = gitRunner('d'.repeat(40), { failFirstRevParse: true });
      const acquired = await acquireSkills(
        source('v1.2.3'),
        join(temp, 'staging'),
        'sync',
        undefined,
        runner,
      );
      const revParses = calls.filter((call) => call.args.includes('rev-parse'));
      expect(revParses).toHaveLength(2);
      expect(revParses[0].args.slice(-1)).toEqual(['refs/remotes/origin/v1.2.3^{commit}']);
      expect(revParses[1].args.slice(-1)).toEqual(['refs/tags/v1.2.3^{commit}']);
      expect(acquired.provenance.commit).toBe('d'.repeat(40));
    });

    it.each([
      ['nothex', 'Git returned an invalid commit'],
      [`${'a'.repeat(40)}zz`, 'Git returned an invalid commit'],
      [`zz${'a'.repeat(40)}`, 'Git returned an invalid commit'],
      ['a'.repeat(65), 'Git returned an invalid commit'],
    ])('rejects an invalid resolved commit %s', async (commit, message) => {
      const { runner } = gitRunner(commit);
      await expect(
        acquireSkills(source('main'), join(temp, 'staging'), 'sync', undefined, runner),
      ).rejects.toThrow(message);
    });

    it('accepts a resolved commit between 40 and 64 hex characters', async () => {
      const commit = 'e'.repeat(41);
      const { runner } = gitRunner(commit);
      const acquired = await acquireSkills(
        source('main'),
        join(temp, 'staging'),
        'sync',
        undefined,
        runner,
      );
      expect(acquired.provenance.commit).toBe(commit);
    });
  });

  describe('acquireSkills from the skills CLI', () => {
    function cliRunner(
      options: { versionOutput?: string; verifyUpdate?: (cwd: string) => void } = {},
    ) {
      const calls: Array<{ args: string[]; cwd: string }> = [];
      const runner: SkillCommandRunner = async (_command, args, cwd) => {
        calls.push({ args, cwd });
        if (args.includes('--version')) return options.versionOutput ?? '1.7.2\n';
        if (args.includes('add') || args.includes('update')) {
          await writeSkill(join(cwd, '.agents', 'skills', 'grill-me'), 'grill-me');
          await writeFile(
            join(cwd, 'skills-lock.json'),
            JSON.stringify({ version: 1, skills: { 'grill-me': { source: 'owner/repo' } } }),
          );
          options.verifyUpdate?.(cwd);
        }
        return '';
      };
      return { calls, runner };
    }

    const source = {
      id: 'cli-team',
      type: 'skills-cli' as const,
      repository: 'owner/repo',
      skills: ['grill-me'],
      cliVersion: 'latest',
    };

    it('takes the version from the last line and pins it for the add command', async () => {
      const { calls, runner } = cliRunner({ versionOutput: 'skills banner\n1.7.2\n' });
      const staging = join(temp, 'staging');
      const acquired = await acquireSkills(source, staging, 'sync', undefined, runner);
      expect(acquired.provenance.cliVersion).toBe('1.7.2');
      expect(acquired.provenance.lock).toMatchObject({ version: 1 });
      expect(acquired.workspace).toBe(join(staging, 'workspace'));
      expect(calls.find((call) => call.args.includes('add'))?.args).toEqual([
        '--yes',
        'skills@1.7.2',
        'add',
        'owner/repo',
        '--skill',
        'grill-me',
        '--agent',
        'universal',
        '--copy',
        '--yes',
      ]);
    });

    it.each(['1.2.3-beta', 'v1.2.3', '', 'beta'])(
      'rejects an unresolvable CLI version %j',
      async (versionOutput) => {
        const { runner } = cliRunner({ versionOutput });
        await expect(
          acquireSkills(source, join(temp, 'staging'), 'sync', undefined, runner),
        ).rejects.toThrow('Unable to resolve skills CLI version');
      },
    );

    it('reuses the previous workspace when updating', async () => {
      const previousWorkspace = join(temp, 'previous-workspace');
      await mkdir(previousWorkspace, { recursive: true });
      await writeFile(join(previousWorkspace, 'marker.txt'), 'kept');
      let marker = 'missing';
      const { calls, runner } = cliRunner({
        verifyUpdate: async (cwd) => {
          marker = await readFile(join(cwd, 'marker.txt'), 'utf8');
        },
      });
      const acquired = await acquireSkills(
        source,
        join(temp, 'staging'),
        'update',
        previousWorkspace,
        runner,
      );
      expect(marker).toBe('kept');
      expect(calls.find((call) => call.args.includes('update'))?.args).toEqual([
        '--yes',
        'skills@1.7.2',
        'update',
        'grill-me',
        '--project',
        '--yes',
      ]);
      expect(acquired.provenance.type).toBe('skills-cli');
    });

    it('re-creates a workspace directory that already exists in staging', async () => {
      const staging = join(temp, 'staging');
      await mkdir(join(staging, 'workspace'), { recursive: true });
      const { runner } = cliRunner();
      const acquired = await acquireSkills(source, staging, 'sync', undefined, runner);
      expect(acquired.snapshots).toHaveLength(1);
    });
  });

  describe('skill discovery limits', () => {
    it('discovers a skill nested exactly twelve levels deep', async () => {
      let directory = join(temp, 'source');
      for (let depth = 0; depth < 11; depth += 1) {
        directory = join(directory, `d${depth}`);
      }
      await writeSkill(join(directory, 'grill-me'), 'grill-me');
      const acquired = await acquireSkills(
        { id: 'team', type: 'local', directory: join(temp, 'source'), skills: ['grill-me'] },
        join(temp, 'staging'),
        'sync',
      );
      expect(acquired.snapshots).toHaveLength(1);
    }, 30_000);

    it('rejects discovery thirteen levels deep', async () => {
      let directory = join(temp, 'source');
      for (let depth = 0; depth < 12; depth += 1) {
        directory = join(directory, `d${depth}`);
      }
      await writeSkill(join(directory, 'grill-me'), 'grill-me');
      await expect(
        acquireSkills(
          { id: 'team', type: 'local', directory: join(temp, 'source'), skills: ['grill-me'] },
          join(temp, 'staging'),
          'sync',
        ),
      ).rejects.toThrow('Skill discovery exceeds directory limits');
    }, 30_000);

    it('supports exactly 5000 directory visits', async () => {
      const root = join(temp, 'source');
      await mkdir(root, { recursive: true });
      await writeSkill(join(root, 'grill-me'), 'grill-me');
      await Promise.all(
        Array.from({ length: 4998 }, (_, index) => mkdir(join(root, `empty-${index}`))),
      );
      const acquired = await acquireSkills(
        { id: 'team', type: 'local', directory: root, skills: ['grill-me'] },
        join(temp, 'staging'),
        'sync',
      );
      expect(acquired.snapshots).toHaveLength(1);
    }, 120_000);

    it('rejects discovery beyond 5000 directory visits', async () => {
      const root = join(temp, 'source');
      await mkdir(root, { recursive: true });
      await writeSkill(join(root, 'grill-me'), 'grill-me');
      await Promise.all(
        Array.from({ length: 4999 }, (_, index) => mkdir(join(root, `empty-${index}`))),
      );
      await expect(
        acquireSkills(
          { id: 'team', type: 'local', directory: root, skills: ['grill-me'] },
          join(temp, 'staging'),
          'sync',
        ),
      ).rejects.toThrow('Skill discovery exceeds directory limits');
    }, 120_000);
  });

  describe('skill discovery behavior', () => {
    it('treats a stray file next to the skill directory as supporting context, not a skill marker', async () => {
      const root = join(temp, 'source');
      await mkdir(root, { recursive: true });
      await writeFile(join(root, 'note.txt'), 'not a skill');
      await writeSkill(join(root, 'grill-me'), 'grill-me');
      const acquired = await acquireSkills(
        { id: 'team', type: 'local', directory: root, skills: ['grill-me'] },
        join(temp, 'staging'),
        'sync',
      );
      expect(acquired.snapshots[0].entry.resources).toHaveLength(1);
    });

    it('reports the first missing name when a requested skill is absent', async () => {
      await writeSkill(join(temp, 'source', 'grill-me'), 'grill-me');
      await expect(
        acquireSkills(
          {
            id: 'team',
            type: 'local',
            directory: join(temp, 'source'),
            skills: ['grill-me', 'missing'],
          },
          join(temp, 'staging'),
          'sync',
        ),
      ).rejects.toThrow('Expected one skill named missing; found 0');
    });

    it('rejects duplicate skills with the same frontmatter name', async () => {
      await writeSkill(join(temp, 'source', 'grill-me'), 'grill-me');
      await writeSkill(join(temp, 'source', 'nested', 'grill-me'), 'grill-me');
      await expect(
        acquireSkills(
          { id: 'team', type: 'local', directory: join(temp, 'source'), skills: ['grill-me'] },
          join(temp, 'staging'),
          'sync',
        ),
      ).rejects.toThrow('Expected one skill named grill-me; found 2');
    });

    it.each(['.git', 'node_modules', '.npm-cache'])(
      'never descends into %s directories',
      async (skipped) => {
        await writeSkill(join(temp, 'source', skipped, 'grill-me'), 'grill-me');
        await expect(
          acquireSkills(
            { id: 'team', type: 'local', directory: join(temp, 'source'), skills: ['grill-me'] },
            join(temp, 'staging'),
            'sync',
          ),
        ).rejects.toThrow('Expected one skill named grill-me; found 0');
      },
    );
  });
});
