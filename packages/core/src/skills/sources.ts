import { SkillSourceSchema } from '@mcp-core/mcp-knot-share/config';
import { execFile } from 'node:child_process';
import { cp, lstat, mkdir, readdir, readFile } from 'node:fs/promises';
import { basename, join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';

import { loadLocalSkillSnapshot } from './local-snapshot.js';

import type { SkillSnapshot } from './local-snapshot.js';
import type { SkillSource } from '@mcp-core/mcp-knot-share/config';

const exec = promisify(execFile);
export type SkillCommandRunner = (command: string, args: string[], cwd: string) => Promise<string>;
export const runSkillCommand: SkillCommandRunner = async (command, args, cwd) => {
  const { stdout } = await exec(command, args, {
    cwd,
    timeout: 120_000,
    maxBuffer: 4 * 1024 * 1024,
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: '0',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      DISABLE_TELEMETRY: '1',
      CI: '1',
      npm_config_cache: join(cwd, '..', '.npm-cache'),
    },
    shell: false,
  });
  return stdout;
};

/** Accept only the supported add command; never execute a caller-provided shell. */
export function skillSourceFromCommand(id: string, command: string): SkillSource {
  const match =
    /^npx\s+skills@(latest|\d+\.\d+\.\d+)\s+add\s+([a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+)\s+--skill(?:=|\s+)([^\s;&|`$<>]+)\s*$/.exec(
      command,
    );
  if (!match) throw new Error('Supported command: npx skills@latest add owner/repo --skill=name');
  return SkillSourceSchema.parse({
    id,
    type: 'skills-cli',
    cliVersion: match[1],
    repository: match[2],
    skills: [match[3]],
  });
}

export interface AcquiredSkills {
  snapshots: SkillSnapshot[];
  provenance: {
    type: SkillSource['type'];
    commit?: string;
    cliVersion?: string;
    paths: string[];
    lock?: unknown;
  };
  workspace?: string;
}

async function discover(root: string, names: readonly string[], namespace: string) {
  const found: Array<{ path: string; snapshot: SkillSnapshot }> = [];
  let visited = 0;
  async function walk(directory: string, depth: number): Promise<void> {
    if (++visited > 5000 || depth > 12) throw new Error('Skill discovery exceeds directory limits');
    const entries = await readdir(directory, { withFileTypes: true });
    if (entries.some((entry) => entry.isFile() && entry.name === 'SKILL.md')) {
      if (names.some((name) => name.normalize('NFKC') === basename(directory).normalize('NFKC'))) {
        found.push({
          path: relative(root, directory),
          snapshot: await loadLocalSkillSnapshot(directory, namespace),
        });
      }
      return; // Nested skills remain supporting files of the enclosing skill.
    }
    for (const entry of entries) {
      if (entry.isDirectory() && !['.git', 'node_modules', '.npm-cache'].includes(entry.name))
        await walk(join(directory, entry.name), depth + 1);
    }
  }
  await walk(root, 0);
  for (const name of names) {
    const matches = found.filter(({ snapshot }) => snapshot.entry.frontmatter.name === name);
    if (matches.length !== 1)
      throw new Error(`Expected one skill named ${name}; found ${matches.length}`);
  }
  return found;
}

export async function acquireSkills(
  source: SkillSource,
  staging: string,
  operation: 'sync' | 'update',
  previousWorkspace?: string,
  runner: SkillCommandRunner = runSkillCommand,
): Promise<AcquiredSkills> {
  let root: string;
  let commit: string | undefined;
  let cliVersion: string | undefined;
  let lock: unknown;
  let workspace: string | undefined;
  await mkdir(staging, { recursive: true });
  if (source.type === 'git') {
    root = join(staging, 'repository');
    await runner(
      'git',
      [
        '-c',
        'core.hooksPath=/dev/null',
        '-c',
        'protocol.file.allow=never',
        'clone',
        '--no-checkout',
        '--no-recurse-submodules',
        '--',
        source.repository,
        root,
      ],
      staging,
    );
    const git = (args: string[]) =>
      runner('git', ['-c', 'core.hooksPath=/dev/null', ...args], root);
    // HEAD / branches / tags / exact commits all resolve before checkout.
    const ref =
      source.ref === 'HEAD'
        ? 'HEAD'
        : /^[a-f0-9]{40}$/.test(source.ref)
          ? source.ref
          : `refs/remotes/origin/${source.ref}`;
    try {
      commit = (await git(['rev-parse', '--verify', `${ref}^{commit}`])).trim();
    } catch {
      commit = (await git(['rev-parse', '--verify', `refs/tags/${source.ref}^{commit}`])).trim();
    }
    if (!/^[a-f0-9]{40,64}$/.test(commit)) throw new Error('Git returned an invalid commit');
    await git([
      '-c',
      'filter.lfs.smudge=',
      '-c',
      'filter.lfs.required=false',
      'checkout',
      '--detach',
      commit,
    ]);
  } else if (source.type === 'local') {
    root = resolve(source.directory);
    if ((await lstat(root)).isSymbolicLink())
      throw new Error('Skill source cannot be a symbolic link');
  } else {
    root = join(staging, 'workspace');
    if (operation === 'update') {
      if (!previousWorkspace) throw new Error('Import a skills-cli source before updating it');
      await cp(previousWorkspace, root, { recursive: true });
    } else await mkdir(root, { recursive: true });
    const versionOutput = await runner(
      'npx',
      ['--yes', `skills@${source.cliVersion}`, '--version'],
      root,
    );
    cliVersion = versionOutput.trim().split(/\r?\n/).at(-1);
    if (!cliVersion || !/^\d+\.\d+\.\d+$/.test(cliVersion))
      throw new Error('Unable to resolve skills CLI version');
    const prefix = ['--yes', `skills@${cliVersion}`];
    if (operation === 'update')
      await runner('npx', [...prefix, 'update', ...source.skills, '--project', '--yes'], root);
    else
      await runner(
        'npx',
        [
          ...prefix,
          'add',
          source.repository,
          '--skill',
          ...source.skills,
          '--agent',
          'universal',
          '--copy',
          '--yes',
        ],
        root,
      );
    lock = JSON.parse(await readFile(join(root, 'skills-lock.json'), 'utf8')) as unknown;
    workspace = root;
    root = join(root, '.agents', 'skills');
  }
  const found = await discover(root, source.skills, source.id);
  return {
    snapshots: found.map((item) => item.snapshot),
    provenance: {
      type: source.type,
      commit,
      cliVersion,
      paths: found.map((item) => item.path),
      ...(lock !== undefined && { lock }),
    },
    workspace,
  };
}
