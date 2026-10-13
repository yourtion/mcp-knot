import { createHash } from 'node:crypto';

import { ErrorCode, ValidationError } from '../errors/index.js';
import { skillMimeType } from './local-snapshot.js';

import type { SkillFileContents, SkillSnapshot } from './local-snapshot.js';
import type { StaticSkillEntry } from './schemas.js';
import type { Resource } from '@modelcontextprotocol/server';

/** One immutable publication view. Only the snapshots supplied here are accessible. */
export class SkillCatalog {
  private readonly entries: StaticSkillEntry[];
  private readonly snapshotsByFile = new Map<string, SkillSnapshot>();
  private readonly viewDigest: string;

  constructor(snapshots: readonly SkillSnapshot[], viewId = 'default') {
    this.entries = snapshots
      .map((snapshot) => snapshot.entry)
      .toSorted((a, b) => (a.uri < b.uri ? -1 : a.uri > b.uri ? 1 : 0));
    if (new Set(this.entries.map((entry) => entry.uri)).size !== this.entries.length) {
      throw new ValidationError(ErrorCode.INVALID_PARAMETER_VALUE, 'Duplicate skill URI');
    }
    for (const snapshot of snapshots) {
      for (const file of snapshot.entry.resources) this.snapshotsByFile.set(file.uri, snapshot);
    }
    this.viewDigest = createHash('sha256')
      .update(JSON.stringify([viewId, this.entries.map((entry) => entry.uri)]))
      .digest('hex');
  }

  list(cursor?: string, pageSize = 10): { skills: StaticSkillEntry[]; nextCursor?: string } {
    if (!Number.isSafeInteger(pageSize) || pageSize < 1) {
      throw new ValidationError(ErrorCode.INVALID_PARAMETER_VALUE, 'Invalid skill page size');
    }
    let offset = 0;
    if (cursor !== undefined) {
      try {
        if (!/^[A-Za-z0-9_-]+$/.test(cursor)) throw new SyntaxError('Invalid cursor encoding');
        const decoded: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
        if (
          typeof decoded !== 'object' ||
          decoded === null ||
          !('view' in decoded) ||
          decoded.view !== this.viewDigest ||
          !('offset' in decoded) ||
          typeof decoded.offset !== 'number' ||
          !Number.isSafeInteger(decoded.offset) ||
          decoded.offset <= 0 ||
          decoded.offset >= this.entries.length
        )
          throw new SyntaxError('Invalid cursor view or offset');
        offset = decoded.offset;
      } catch (_error) {
        throw new ValidationError(ErrorCode.INVALID_PARAMETER_VALUE, 'Invalid skills cursor');
      }
    }
    const skills = structuredClone(this.entries.slice(offset, offset + pageSize));
    const nextOffset = offset + skills.length;
    return {
      skills,
      ...(nextOffset < this.entries.length && {
        nextCursor: Buffer.from(
          JSON.stringify({ view: this.viewDigest, offset: nextOffset }),
        ).toString('base64url'),
      }),
    };
  }

  get(uri: string): StaticSkillEntry | undefined {
    const entry = this.entries.find((skill) => skill.uri === uri);
    return entry && structuredClone(entry);
  }

  read(uri: string): SkillFileContents | undefined {
    return this.snapshotsByFile.get(uri)?.read(uri);
  }

  resources(): Resource[] {
    return this.entries.flatMap((entry) =>
      entry.resources.map((file) => ({
        uri: file.uri,
        name:
          file.uri === entry.uri
            ? entry.frontmatter.name
            : decodeURIComponent(file.uri.split('/').at(-1)!),
        ...(file.uri === entry.uri && { description: entry.frontmatter.description }),
        mimeType: skillMimeType(new URL(file.uri).pathname),
      })),
    );
  }
}
