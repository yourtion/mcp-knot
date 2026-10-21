import {
  GroupSkillsSchema,
  SkillSourceIdSchema,
  SkillSourceSchema,
} from '@mcp-core/mcp-knot-share/config';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod/v4';

import { SkillCatalog } from './catalog.js';
import { snapshotFromFiles } from './local-snapshot.js';
import { acquireSkills, runSkillCommand } from './sources.js';

import type { SkillSnapshot } from './local-snapshot.js';
import type { AcquiredSkills, SkillCommandRunner } from './sources.js';
import type { SkillSelection, SkillSource } from '@mcp-core/mcp-knot-share/config';

const StoredSnapshotSchema = z.object({
  name: z.string(),
  files: z.array(z.object({ path: z.string(), base64: z.string() })),
});
const RevisionSchema = z.object({
  sourceId: SkillSourceIdSchema,
  revision: z.string().regex(/^[a-f0-9]{64}$/),
  importedAt: z.string(),
  source: SkillSourceSchema,
  provenance: z.object({
    type: z.enum(['git', 'local', 'skills-cli']),
    commit: z.string().optional(),
    cliVersion: z.string().optional(),
    paths: z.array(z.string()),
    lock: z.unknown().optional(),
  }),
  snapshots: z.array(StoredSnapshotSchema),
});
export interface SkillImportResult {
  sourceId: string;
  revision: string;
  importedAt: string;
  provenance: AcquiredSkills['provenance'];
  selections: SkillSelection[];
  skills: SkillSnapshot['entry'][];
}

/** Persistent source registry and immutable revisions. Reads never fetch upstream. */
export class SkillRepository {
  constructor(
    readonly directory: string,
    private readonly runner: SkillCommandRunner = runSkillCommand,
  ) {}

  private async atomicJson(path: string, value: unknown) {
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(value), { flag: 'wx', mode: 0o600 });
      await rename(temporary, path);
    } finally {
      await rm(temporary, { force: true });
    }
  }

  async listSources(): Promise<SkillSource[]> {
    try {
      return z
        .array(SkillSourceSchema)
        .parse(JSON.parse(await readFile(join(this.directory, 'sources.json'), 'utf8')));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }

  private async exclusive<T>(action: () => Promise<T>): Promise<T> {
    await mkdir(this.directory, { recursive: true });
    const lock = join(this.directory, '.write-lock');
    try {
      await mkdir(lock);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST')
        throw new Error('Another skills mutation is in progress', { cause: error });
      throw error;
    }
    try {
      return await action();
    } finally {
      await rm(lock, { recursive: true, force: true });
    }
  }

  async saveSource(input: unknown): Promise<SkillSource> {
    const source = SkillSourceSchema.parse(input);
    return this.exclusive(async () => {
      const sources = await this.listSources();
      const existing = sources.find((item) => item.id === source.id);
      if (existing && JSON.stringify(existing) !== JSON.stringify(source))
        throw new Error('Source ID already exists with different configuration; use a new ID');
      if (!existing)
        await this.atomicJson(join(this.directory, 'sources.json'), [...sources, source]);
      return source;
    });
  }

  async sync(sourceId: string, operation: 'sync' | 'update' = 'sync'): Promise<SkillImportResult> {
    SkillSourceIdSchema.parse(sourceId);
    return this.exclusive(async () => {
      const source = (await this.listSources()).find((item) => item.id === sourceId);
      if (!source) throw new Error('Unknown skill source');
      const staging = join(this.directory, 'staging', randomUUID());
      try {
        let previousWorkspace: string | undefined;
        if (operation === 'update' && source.type === 'skills-cli') {
          const previous = await this.latest(sourceId);
          if (previous)
            previousWorkspace = join(this.directory, 'workspaces', sourceId, previous.revision);
        }
        const acquired = await acquireSkills(
          source,
          staging,
          operation,
          previousWorkspace,
          this.runner,
        );
        const revision = createHash('sha256')
          .update(
            JSON.stringify(acquired.snapshots.map((snapshot) => snapshot.entry.uri).toSorted()),
          )
          .digest('hex');
        const snapshots = acquired.snapshots.map((snapshot) => ({
          name: snapshot.entry.frontmatter.name,
          files: snapshot.entry.resources.map((resource) => {
            const contents = snapshot.read(resource.uri)!;
            const base64 =
              'text' in contents ? Buffer.from(contents.text).toString('base64') : contents.blob;
            const root = snapshot.entry.uri.slice(0, -'SKILL.md'.length);
            return {
              path: resource.uri.slice(root.length).split('/').map(decodeURIComponent).join('/'),
              base64,
            };
          }),
        }));
        const stored = RevisionSchema.parse({
          sourceId,
          revision,
          importedAt: new Date().toISOString(),
          source,
          provenance: acquired.provenance,
          snapshots,
        });
        const revisions = join(this.directory, 'revisions', sourceId);
        await mkdir(revisions, { recursive: true });
        // A given content revision is never replaced; keep its original provenance.
        try {
          await readFile(join(revisions, `${revision}.json`));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          await this.atomicJson(join(revisions, `${revision}.json`), stored);
        }
        if (acquired.workspace) {
          const workspace = join(this.directory, 'workspaces', sourceId, revision);
          await mkdir(join(this.directory, 'workspaces', sourceId), { recursive: true });
          try {
            await rename(acquired.workspace, workspace);
          } catch (error) {
            if (!['EEXIST', 'ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code ?? ''))
              throw error;
          }
        }
        // Validate a reused on-disk revision before changing the last-good pointer.
        const loaded = await this.loadRevision(sourceId, revision);
        // The mutable candidate pointer changes only after a completely valid import.
        await this.atomicJson(join(revisions, 'latest.json'), { revision });
        return loaded.result;
      } finally {
        await rm(staging, { recursive: true, force: true });
      }
    });
  }

  async latest(sourceId: string): Promise<SkillImportResult | undefined> {
    SkillSourceIdSchema.parse(sourceId);
    try {
      const pointer = z
        .object({ revision: z.string().regex(/^[a-f0-9]{64}$/) })
        .parse(
          JSON.parse(
            await readFile(join(this.directory, 'revisions', sourceId, 'latest.json'), 'utf8'),
          ),
        );
      return (await this.loadRevision(sourceId, pointer.revision)).result;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  }

  /** Saved candidates, including old publications; never contacts the source. */
  async listRevisions(sourceId: string): Promise<SkillImportResult[]> {
    SkillSourceIdSchema.parse(sourceId);
    let files: string[];
    try {
      files = await readdir(join(this.directory, 'revisions', sourceId));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const revisions = await Promise.all(
      files
        .filter((file) => /^[a-f0-9]{64}\.json$/.test(file))
        .map(async (file) => (await this.loadRevision(sourceId, file.slice(0, -5))).result),
    );
    return revisions.toSorted(
      (a, b) => b.importedAt.localeCompare(a.importedAt) || a.revision.localeCompare(b.revision),
    );
  }

  async getRevision(sourceId: string, revision: string): Promise<SkillImportResult | undefined> {
    SkillSourceIdSchema.parse(sourceId);
    z.string()
      .regex(/^[a-f0-9]{64}$/)
      .parse(revision);
    try {
      return (await this.loadRevision(sourceId, revision)).result;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  }

  private async loadRevision(sourceId: string, revision: string) {
    const stored = RevisionSchema.parse(
      JSON.parse(
        await readFile(join(this.directory, 'revisions', sourceId, `${revision}.json`), 'utf8'),
      ),
    );
    if (stored.sourceId !== sourceId || stored.revision !== revision)
      throw new Error('Snapshot identity mismatch');
    const snapshots = stored.snapshots.map((snapshot) =>
      snapshotFromFiles(
        snapshot.files.map((file) => ({
          path: file.path,
          bytes: Buffer.from(file.base64, 'base64'),
        })),
        sourceId,
        snapshot.name,
      ),
    );
    const digest = createHash('sha256')
      .update(JSON.stringify(snapshots.map((snapshot) => snapshot.entry.uri).toSorted()))
      .digest('hex');
    if (digest !== revision) throw new Error('Persisted snapshot integrity check failed');
    const result: SkillImportResult = {
      sourceId,
      revision,
      importedAt: stored.importedAt,
      provenance: stored.provenance,
      selections: snapshots.map((snapshot) => ({
        sourceId,
        revision,
        skill: snapshot.entry.frontmatter.name,
      })),
      skills: snapshots.map((snapshot) => snapshot.entry),
    };
    return { result, snapshots };
  }

  async catalog(input: unknown, viewId: string): Promise<SkillCatalog> {
    const selection = GroupSkillsSchema.parse(input);
    const selected: SkillSnapshot[] = [];
    const revisions = new Map<string, Awaited<ReturnType<SkillRepository['loadRevision']>>>();
    const chosen = new Set<string>();
    for (const item of selection.include) {
      const key = `${item.sourceId}:${item.skill}`;
      if (chosen.has(key)) throw new Error('Duplicate or conflicting skill selection');
      chosen.add(key);
      const revisionKey = `${item.sourceId}:${item.revision}`;
      if (!revisions.has(revisionKey))
        revisions.set(revisionKey, await this.loadRevision(item.sourceId, item.revision));
      const snapshot = revisions
        .get(revisionKey)!
        .snapshots.find((candidate) => candidate.entry.frontmatter.name === item.skill);
      if (!snapshot) throw new Error('Selected skill not found in revision');
      selected.push(snapshot);
    }
    return new SkillCatalog(selected, viewId);
  }
}
