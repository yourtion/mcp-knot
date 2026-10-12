import { describe, expect, it } from 'vitest';

import { GroupSchema } from './group.schema.js';
import { SkillSourceSchema } from './skills.schema.js';

describe('Skills source and Group config', () => {
  const base = { id: 'design', name: 'Design', servers: [], tools: [] };
  const skills = { include: [{ sourceId: 'team', revision: 'a'.repeat(64), skill: 'grill-me' }] };
  it('preserves pinned skill references and permits skills-only Groups', () => {
    expect(GroupSchema.parse({ ...base, skills }).skills).toEqual(skills);
    expect(GroupSchema.safeParse(base).success).toBe(false);
    expect(GroupSchema.parse({ ...base, servers: ['upstream'] }).skills).toBeUndefined();
  });
  it('rejects mutable revision names and credential-bearing Git URLs', () => {
    expect(
      GroupSchema.safeParse({
        ...base,
        skills: { include: [{ ...skills.include[0], revision: 'main' }] },
      }).success,
    ).toBe(false);
    expect(
      SkillSourceSchema.safeParse({
        id: 'team',
        type: 'git',
        repository: 'https://user:token@github.com/team/skills.git',
        skills: ['grill-me'],
      }).success,
    ).toBe(false);
  });
});
