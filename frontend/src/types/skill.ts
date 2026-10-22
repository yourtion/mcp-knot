import type { SkillSelection, SkillSource } from '@mcp-core/mcp-knot-share/config';

export type { SkillSelection, SkillSource };

export interface SkillEntry {
  uri: string;
  frontmatter: { name: string; description: string; [key: string]: unknown };
  resources: Array<{ uri: string; digest: string; size: number }>;
}

export interface SkillRevision {
  sourceId: string;
  revision: string;
  importedAt: string;
  provenance: {
    type: SkillSource['type'];
    commit?: string;
    cliVersion?: string;
    paths: string[];
    lock?: unknown;
  };
  selections: SkillSelection[];
  skills: SkillEntry[];
}

export type SkillSourceInfo = SkillSource & { latest?: SkillRevision };
export type SkillSourceInput = SkillSource | { id: string; command: string };
