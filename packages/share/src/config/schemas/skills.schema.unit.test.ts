import { describe, expect, it } from 'vitest';

import { GroupSchema } from './group.schema.js';
import {
  GroupSkillsSchema,
  SkillSelectionSchema,
  SkillSourceIdSchema,
  SkillSourceSchema,
} from './skills.schema.js';

describe('SkillSourceIdSchema', () => {
  it.each(['team', 'team_skills-1', 'a'.repeat(64)])('接受合法 ID %j', (id) => {
    expect(SkillSourceIdSchema.parse(id)).toBe(id);
  });

  it.each(['', '!team', 'team!', 'Team', 'a'.repeat(65), 'team/slash', 'team space'])(
    '拒绝非法 ID %j',
    (id) => {
      expect(SkillSourceIdSchema.safeParse(id).success).toBe(false);
    },
  );
});

describe('skillNames（skills 数组约束）', () => {
  const base = { id: 'team', type: 'local', directory: '/skills' } as const;

  const parseSkills = (skills: string[]) =>
    SkillSourceSchema.safeParse({ ...base, skills }).error?.issues[0]?.message;

  it('拒绝空数组', () => {
    expect(SkillSourceSchema.safeParse({ ...base, skills: [] }).success).toBe(false);
  });

  it.each(['a/b', 'a\\b', 'a\0b', '/root', '-lead', ''])('拒绝非法技能名 %j', (name) => {
    expect(SkillSourceSchema.safeParse({ ...base, skills: [name] }).success).toBe(false);
  });

  it('重复技能名被拒绝且提示 Duplicate skill names', () => {
    expect(SkillSourceSchema.safeParse({ ...base, skills: ['a', 'b', 'a'] }).success).toBe(false);
    expect(parseSkills(['a', 'a'])).toBe('Duplicate skill names');
  });

  it('普通技能名（含点、下划线、结尾连字符）可正常解析', () => {
    const parsed = SkillSourceSchema.parse({
      ...base,
      skills: ['grill-me', 'code_review.v2', 'trail-'],
    });
    expect(parsed.type === 'local' && parsed.skills).toEqual([
      'grill-me',
      'code_review.v2',
      'trail-',
    ]);
  });
});

describe('SkillSourceSchema git 类型', () => {
  const base = {
    id: 'team',
    type: 'git',
    repository: 'https://github.com/team/skills.git',
    skills: ['grill-me'],
  } as const;

  it('合法配置解析后 ref 默认 HEAD', () => {
    const parsed = SkillSourceSchema.parse(base);
    expect(parsed.type === 'git' && parsed.ref).toBe('HEAD');
  });

  it('显式 ref 保留且支持多级路径与标签', () => {
    for (const ref of ['v1', 'v1.2', 'feature/x', 'refs/tags/v1.0.0', 'aB9._-']) {
      const parsed = SkillSourceSchema.parse({ ...base, ref });
      expect(parsed.type === 'git' && parsed.ref).toBe(ref);
    }
  });

  it.each(['', '-abc', ' abc', 'abc def'])('拒绝非法 ref %j', (ref) => {
    expect(SkillSourceSchema.safeParse({ ...base, ref }).success).toBe(false);
  });

  it('repository 必须是 HTTPS URL 且不含凭据/查询串/锚点', () => {
    const badUrls = [
      'http://github.com/team/skills.git',
      'https://user@github.com/team/skills.git',
      'https://user:token@github.com/team/skills.git',
      'https://github.com/team/skills.git?token=1',
      'https://github.com/team/skills.git#section',
      'not-a-url',
      'ftp://github.com/team/skills.git',
    ];
    for (const repository of badUrls) {
      expect(SkillSourceSchema.safeParse({ ...base, repository }).success).toBe(false);
    }
  });

  it('repository 校验失败时给出固定错误消息', () => {
    const result = SkillSourceSchema.safeParse({ ...base, repository: 'http://x.com/a' });
    expect(
      result.error?.issues.some(
        (i) => i.message === 'Repository must be an HTTPS URL without credentials',
      ),
    ).toBe(true);
  });
});

describe('SkillSourceSchema local 类型', () => {
  it('合法配置解析并保留 directory 与 skills', () => {
    const parsed = SkillSourceSchema.parse({
      id: 'local1',
      type: 'local',
      directory: '/abs/skills',
      skills: ['a'],
    });
    expect(parsed.type === 'local' && parsed.directory).toBe('/abs/skills');
  });

  it('directory 不能为空且必填', () => {
    expect(
      SkillSourceSchema.safeParse({ id: 'local1', type: 'local', directory: '', skills: ['a'] })
        .success,
    ).toBe(false);
    expect(
      SkillSourceSchema.safeParse({ id: 'local1', type: 'local', skills: ['a'] }).success,
    ).toBe(false);
  });
});

describe('SkillSourceSchema skills-cli 类型', () => {
  const base = { id: 'cli1', type: 'skills-cli', repository: 'team/skills' } as const;

  it('合法配置解析后 cliVersion 默认 latest', () => {
    const parsed = SkillSourceSchema.parse({ ...base, skills: ['a'] });
    expect(parsed.type === 'skills-cli' && parsed.cliVersion).toBe('latest');
  });

  it.each(['team/skills', 'a1/b2', 'my-org.my-repo/sub_repo-x'])(
    '接受 owner/repo 形式 %j',
    (repository) => {
      expect(SkillSourceSchema.safeParse({ ...base, repository, skills: ['a'] }).success).toBe(
        true,
      );
    },
  );

  it.each([
    '',
    'owner',
    'owner/repo/extra',
    '/owner/repo',
    'owner/repo!',
    'owner/repo extra',
    'https://github.com/owner/repo',
  ])('拒绝非法仓库标识 %j', (repository) => {
    expect(SkillSourceSchema.safeParse({ ...base, repository, skills: ['a'] }).success).toBe(false);
  });

  it.each(['1.2.3', '10.20.30', 'latest'])('接受 cliVersion %j', (cliVersion) => {
    const parsed = SkillSourceSchema.parse({ ...base, skills: ['a'], cliVersion });
    expect(parsed.type === 'skills-cli' && parsed.cliVersion).toBe(cliVersion);
  });

  it.each(['v1.2.3', '1.2', '1.2.3.4', 'latestx', 'xlatest', 'LATEST', ''])(
    '拒绝非法 cliVersion %j',
    (cliVersion) => {
      expect(SkillSourceSchema.safeParse({ ...base, skills: ['a'], cliVersion }).success).toBe(
        false,
      );
    },
  );
});

describe('SkillSourceSchema 判别', () => {
  it('未知 type 被拒绝', () => {
    expect(SkillSourceSchema.safeParse({ id: 'x', type: 'svn', skills: ['a'] }).success).toBe(
      false,
    );
  });

  it('缺少 id 时校验失败', () => {
    expect(
      SkillSourceSchema.safeParse({ type: 'local', directory: '/x', skills: ['a'] }).success,
    ).toBe(false);
  });
});

describe('SkillSelectionSchema', () => {
  const valid = { sourceId: 'team', revision: 'a'.repeat(64), skill: 'grill-me' };

  it('合法选择解析并保留全部字段', () => {
    expect(SkillSelectionSchema.parse(valid)).toEqual(valid);
  });

  it.each([
    '', // 空
    'a'.repeat(63), // 少一位
    'a'.repeat(65), // 多一位
    'A'.repeat(64), // 大写十六进制
    `z${'a'.repeat(64)}`, // 前缀非 hex（锚定 ^）
    `${'a'.repeat(64)}z`, // 后缀非 hex（锚定 $）
    'g'.repeat(64), // 非 hex 字符
  ])('拒绝非法 revision %j', (revision) => {
    expect(SkillSelectionSchema.safeParse({ ...valid, revision }).success).toBe(false);
  });

  it('skill 不能为空', () => {
    expect(SkillSelectionSchema.safeParse({ ...valid, skill: '' }).success).toBe(false);
  });

  it('sourceId 复用 SkillSourceIdSchema 的规则', () => {
    expect(SkillSelectionSchema.safeParse({ ...valid, sourceId: 'BAD' }).success).toBe(false);
  });
});

describe('GroupSkillsSchema / Group 集成', () => {
  const base = { id: 'design', name: 'Design', servers: [], tools: [] };
  const skills = { include: [{ sourceId: 'team', revision: 'a'.repeat(64), skill: 'grill-me' }] };

  it('include 必填', () => {
    expect(GroupSkillsSchema.safeParse({}).success).toBe(false);
  });

  it('保留 pinned skill 引用且允许 skills-only Group', () => {
    expect(GroupSchema.parse({ ...base, skills }).skills).toEqual(skills);
    expect(GroupSchema.safeParse(base).success).toBe(false);
    expect(GroupSchema.parse({ ...base, servers: ['upstream'] }).skills).toBeUndefined();
  });

  it('拒绝可变 revision 与带凭据的 Git URL', () => {
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
