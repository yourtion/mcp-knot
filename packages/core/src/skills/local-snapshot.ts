import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import { basename, extname, join, relative, resolve, sep } from 'node:path';
import { TextDecoder } from 'node:util';
import { parseDocument } from 'yaml';

import { ErrorCode, ValidationError } from '../errors/index.js';
import { MAX_SKILL_BYTES, MAX_SKILL_FILES, SkillFrontmatterSchema } from './schemas.js';

import type { StaticSkillEntry } from './schemas.js';
import type { BlobResourceContents, TextResourceContents } from '@modelcontextprotocol/server';

export type SkillFileContents = TextResourceContents | BlobResourceContents;

/** Captured bytes are private; metadata and reads cannot mutate the snapshot. */
export interface SkillSnapshot {
  readonly entry: StaticSkillEntry;
  read(uri: string): SkillFileContents | undefined;
}

const MIME_TYPES: Record<string, string> = {
  '.md': 'text/markdown',
  '.txt': 'text/plain',
  '.json': 'application/json',
  '.yaml': 'application/yaml',
  '.yml': 'application/yaml',
  '.csv': 'text/csv',
  '.sh': 'text/x-shellscript',
  '.py': 'text/x-python',
  '.js': 'text/javascript',
  '.ts': 'text/plain',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.pdf': 'application/pdf',
};

export function skillMimeType(path: string): string {
  return MIME_TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream';
}

function invalidSkill(message: string): ValidationError {
  return new ValidationError(ErrorCode.INVALID_PARAMETER_VALUE, message);
}

function decodeText(bytes: Buffer): string {
  // Preserve a UTF-8 BOM: digest/size cover the original bytes, including BOMs.
  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
}

function parseFrontmatter(bytes: Buffer) {
  const text = decodeText(bytes);
  const match = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (!match) throw invalidSkill('SKILL.md must begin with YAML frontmatter');

  const document = parseDocument(match[1], { schema: 'core', uniqueKeys: true });
  if (document.errors.length > 0 || document.warnings.length > 0) {
    throw invalidSkill(
      `Invalid skill YAML: ${[...document.errors, ...document.warnings][0].message}`,
    );
  }
  const value: unknown = document.toJS({ maxAliasCount: 100 });
  const result = SkillFrontmatterSchema.safeParse(value);
  if (!result.success) throw invalidSkill(`Invalid skill frontmatter: ${result.error.message}`);
  return result.data;
}

/** Load one standard skill directory, including nested skill files, into memory. */
export async function loadLocalSkillSnapshot(
  directory: string,
  namespace = 'local',
): Promise<SkillSnapshot> {
  if (!namespace.split('/').every((part) => /^[a-z0-9][a-z0-9._-]*$/.test(part))) {
    throw invalidSkill('Skill namespace must contain URI-safe lowercase path segments');
  }
  const configuredRoot = resolve(directory);
  const rootStat = await lstat(configuredRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw invalidSkill('Skill root must be a directory, not a symbolic link');
  }
  const root = await realpath(configuredRoot);
  const files: Array<{ path: string; bytes: Buffer; digest: string }> = [];
  let totalBytes = 0;

  async function walk(folder: string): Promise<void> {
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      const path = join(folder, entry.name);
      if (entry.isSymbolicLink())
        throw invalidSkill(`Symbolic links are not served: ${entry.name}`);
      if (entry.isDirectory()) {
        await walk(path);
        continue;
      }
      if (!entry.isFile()) throw invalidSkill(`Only regular skill files are served: ${entry.name}`);
      if (files.length >= MAX_SKILL_FILES) throw invalidSkill('Skill exceeds 512 files');
      const actualPath = await realpath(path);
      if (!actualPath.startsWith(`${root}${sep}`))
        throw invalidSkill('Skill file is outside its root');
      const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      let bytes: Buffer;
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.nlink > 1)
          throw invalidSkill('Skill files must be regular, unlinked files');
        if (totalBytes + stat.size > MAX_SKILL_BYTES) throw invalidSkill('Skill exceeds 16 MiB');
        bytes = await handle.readFile();
      } finally {
        await handle.close();
      }
      totalBytes += bytes.length;
      if (totalBytes > MAX_SKILL_BYTES) throw invalidSkill('Skill exceeds 16 MiB');
      files.push({
        path: relative(root, path).split(sep).join('/'),
        bytes,
        digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
      });
    }
  }

  await walk(root);
  return snapshotFromFiles(
    files.map(({ path, bytes }) => ({ path, bytes })),
    namespace,
    basename(root),
  );
}

/** Reconstruct and validate persisted bytes using the same rules as local imports. */
export function snapshotFromFiles(
  input: Array<{ path: string; bytes: Buffer }>,
  namespace: string,
  directoryName: string,
): SkillSnapshot {
  if (!namespace.split('/').every((part) => /^[a-z0-9][a-z0-9._-]*$/.test(part)))
    throw invalidSkill('Invalid snapshot namespace');
  if (
    input.length > MAX_SKILL_FILES ||
    input.reduce((size, file) => size + file.bytes.length, 0) > MAX_SKILL_BYTES
  )
    throw invalidSkill('Snapshot exceeds skill limits');
  const files = input.map(({ path, bytes }) => {
    if (
      !path ||
      path.includes('\\') ||
      path.includes('\0') ||
      path.split('/').some((part) => !part || part === '.' || part === '..')
    )
      throw invalidSkill('Invalid snapshot file path');
    const captured = Buffer.from(bytes);
    return {
      path,
      bytes: captured,
      digest: `sha256:${createHash('sha256').update(captured).digest('hex')}`,
    };
  });
  if (new Set(files.map((file) => file.path)).size !== files.length)
    throw invalidSkill('Duplicate snapshot file path');
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const main = files.find((file) => file.path === 'SKILL.md');
  if (!main) throw invalidSkill('Skill directory must contain SKILL.md');
  const frontmatter = parseFrontmatter(main.bytes);
  if (directoryName.normalize('NFKC') !== frontmatter.name.normalize('NFKC')) {
    throw invalidSkill('Skill directory name must match frontmatter.name');
  }

  const revision = createHash('sha256')
    .update(JSON.stringify(files.map((file) => [file.path, file.digest, file.bytes.length])))
    .digest('hex');
  const rootUri = `skill://${namespace}/rev-${revision}/${encodeURIComponent(frontmatter.name)}`;
  const byUri = new Map(
    files.map((file) => [
      `${rootUri}/${file.path.split('/').map(encodeURIComponent).join('/')}`,
      file,
    ]),
  );
  const entry: StaticSkillEntry = {
    uri: `${rootUri}/SKILL.md`,
    frontmatter,
    resources: [...byUri].map(([uri, file]) => ({
      uri,
      digest: file.digest,
      size: file.bytes.length,
    })),
  };

  return Object.freeze({
    get entry() {
      return structuredClone(entry);
    },
    read(uri: string): SkillFileContents | undefined {
      const file = byUri.get(uri);
      if (!file) return undefined;
      const mimeType = skillMimeType(file.path);
      if (
        mimeType !== 'application/octet-stream' &&
        !['image/png', 'image/jpeg', 'application/pdf'].includes(mimeType)
      ) {
        try {
          return { uri, mimeType, text: decodeText(file.bytes) };
        } catch (_error) {
          // Non-UTF-8 supporting files remain byte-exact through base64 blobs.
        }
      }
      return { uri, mimeType, blob: file.bytes.toString('base64') };
    },
  });
}
