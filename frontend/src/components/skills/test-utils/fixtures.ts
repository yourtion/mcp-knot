import type { GroupDetailInfo, GroupInfo } from '@/types/group';
import type { SkillRevision, SkillSelection, SkillSourceInfo } from '@/types/skill';

export function revision(hash: string, importedAt: string): SkillRevision {
  const id = hash.repeat(64);
  return {
    sourceId: 'team',
    revision: id,
    importedAt,
    provenance: { type: 'git', commit: hash.repeat(40), paths: ['skills/review'] },
    selections: [{ sourceId: 'team', revision: id, skill: 'review' }],
    skills: [
      {
        uri: `skill://team/${id}/review/SKILL.md`,
        frontmatter: { name: 'review', description: `Review version ${hash}` },
        resources: [
          { uri: `skill://team/${id}/review/SKILL.md`, digest: `sha256:${id}`, size: 120 },
        ],
      },
    ],
  };
}

export const first = revision('a', '2026-10-20T10:00:00Z');
export const second = revision('b', '2026-10-21T10:00:00Z');
export const source: SkillSourceInfo = {
  id: 'team',
  type: 'git',
  repository: 'https://github.com/team/skills.git',
  ref: 'main',
  skills: ['review'],
  latest: second,
};
export const other: SkillSelection = {
  sourceId: 'other',
  skill: 'design',
  revision: 'c'.repeat(64),
};

export function groupInfo(include: SkillSelection[] = first.selections): GroupInfo {
  return {
    id: 'design',
    name: 'Design',
    description: 'Team group',
    servers: ['server'],
    tools: ['existing-tool'],
    skills: { include },
    serverCount: 1,
    connectedServers: 1,
    toolCount: 1,
    filteredToolCount: 1,
    toolFilterMode: 'whitelist',
    isHealthy: true,
    healthScore: 1,
    validation: { enabled: true, hasKey: true },
    stats: {
      totalServers: 1,
      availableServers: 1,
      totalTools: 1,
      filteredTools: 1,
      healthPercentage: 100,
    },
    lastUpdated: '2026-10-21T10:00:00Z',
  };
}

export function groupDetail(include: SkillSelection[] = first.selections): GroupDetailInfo {
  return {
    ...groupInfo(include),
    servers: [{ id: 'server', status: 'connected', toolCount: 1 }],
    tools: [{ name: 'existing-tool', description: '', serverId: 'server' }],
    performance: { averageResponseTime: 0, totalRequests: 0, successRate: 1 },
    accessControl: { requiresValidation: true, toolAccessRestricted: true },
  };
}

export const stubs = {
  TDialog: {
    props: ['visible', 'header', 'confirmBtn', 'cancelBtn', 'footer'],
    emits: ['confirm', 'close'],
    template: `<section v-if="visible"><h2>{{ header }}</h2><slot /><div v-if="footer !== false">
      <button :disabled="confirmBtn?.loading" @click="$emit('confirm')">{{ confirmBtn?.content || '确认' }}</button>
      <button :disabled="cancelBtn?.disabled" @click="$emit('close')">取消</button>
    </div></section>`,
  },
  TForm: { template: '<form @submit.prevent><slot /></form>' },
  TFormItem: { props: ['label'], template: '<label><span>{{ label }}</span><slot /></label>' },
  TSelect: {
    props: ['modelValue', 'options', 'multiple', 'disabled'],
    emits: ['update:modelValue'],
    template: `<select :multiple="multiple" :disabled="disabled" :value="modelValue"
      @change="$emit('update:modelValue', multiple ? Array.from($event.target.selectedOptions).map(option => option.value) : $event.target.value)">
      <option value="" v-if="!multiple">选择</option>
      <option v-for="option in options" :key="option.value" :value="option.value">{{ option.label }}</option>
    </select>`,
  },
  TInput: {
    props: ['modelValue', 'disabled'],
    emits: ['update:modelValue'],
    template:
      '<input :value="modelValue" :disabled="disabled" @input="$emit(\'update:modelValue\', $event.target.value)" />',
  },
  TTextarea: {
    props: ['modelValue', 'disabled'],
    emits: ['update:modelValue'],
    template:
      '<textarea :value="modelValue" :disabled="disabled" @input="$emit(\'update:modelValue\', $event.target.value)" />',
  },
  TButton: {
    props: ['disabled', 'loading'],
    template: '<button :disabled="disabled || loading"><slot /></button>',
  },
  TAlert: { props: ['message'], template: '<div role="alert">{{ message }}</div>' },
  TLoading: { props: ['text'], template: '<div role="status">{{ text }}</div>' },
  TTag: { template: '<span><slot /></span>' },
  TPopconfirm: {
    props: ['content'],
    emits: ['confirm'],
    template:
      '<div><slot /><button class="confirm-revoke" @click="$emit(\'confirm\')">{{ content }}</button></div>',
  },
};
