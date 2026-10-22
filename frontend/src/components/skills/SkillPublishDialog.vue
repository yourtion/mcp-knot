<template>
  <t-dialog
    :visible="visible"
    header="Group 技能发布与回滚"
    width="840px"
    :footer="false"
    :close-btn="!saving"
    :close-on-overlay-click="!saving"
    :close-on-esc-keydown="!saving"
    @close="close"
  >
    <t-alert v-if="error" theme="error" :message="error" class="publication-alert" />
    <t-loading v-if="loading" text="加载来源与 Group…" />
    <template v-else>
      <t-form label-align="top">
        <t-form-item label="目标 Group">
          <t-select
            v-model="groupId"
            :options="
              groups.map((group) => ({ value: group.id, label: `${group.name} (${group.id})` }))
            "
            placeholder="选择要发布到的 Group"
            :disabled="saving || !!props.groupId"
            filterable
          />
        </t-form-item>
      </t-form>
      <p v-if="!groups.length" class="publication-help">请先在组管理中创建 Group。</p>
      <t-loading v-if="groupLoading" text="加载已发布技能…" />
      <section v-else-if="group" class="publication-current">
        <h3>当前已发布 · {{ currentSelections.length }} 个技能</h3>
        <p v-if="!currentSelections.length" class="publication-help">此 Group 尚未发布技能。</p>
        <div
          v-for="item in currentSelections"
          :key="`${item.sourceId}:${item.skill}`"
          class="publication-row"
        >
          <div>
            <strong>{{ item.skill }}</strong>
            <span class="publication-help"> · {{ item.sourceId }}</span>
            <code :title="item.revision">{{ item.revision.slice(0, 12) }}</code>
          </div>
          <t-popconfirm :content="`确认从此 Group 撤销 ${item.skill}？`" @confirm="revoke(item)">
            <t-button
              theme="danger"
              variant="text"
              size="small"
              :disabled="saving || (currentSelections.length === 1 && !group.servers.length)"
              >撤销</t-button
            >
          </t-popconfirm>
        </div>
        <p v-if="currentSelections.length === 1 && !group.servers.length" class="publication-help">
          纯技能 Group 至少需要保留一个技能。
        </p>
      </section>

      <t-form label-align="top" class="publication-form">
        <t-form-item label="技能来源">
          <t-select
            v-model="sourceId"
            :options="sources.map((source) => ({ value: source.id, label: source.id }))"
            placeholder="选择来源"
            :disabled="saving"
            filterable
          />
        </t-form-item>
        <t-form-item label="发布版本">
          <t-select
            v-model="revisionId"
            :options="versionOptions"
            :loading="versionsLoading"
            :disabled="saving || versionsLoading || !revisions.length"
            placeholder="选择已保存的版本"
            filterable
          />
        </t-form-item>
        <t-form-item v-if="selectedRevision" label="本次发布的技能">
          <t-select
            v-model="skillNames"
            :options="
              selectedRevision.selections.map((item) => ({ value: item.skill, label: item.skill }))
            "
            :disabled="saving"
            multiple
            clearable
          />
        </t-form-item>
      </t-form>
      <p v-if="sourceId && !versionsLoading && !revisions.length" class="publication-help">
        此来源尚无可用版本，请先在技能管理中同步。
      </p>

      <section v-if="group && selectedRevision" class="publication-preview">
        <h3>发布变更预览</h3>
        <p class="publication-help">
          所选技能将替换 Group 中同来源的同名技能，其他已发布技能保留。
        </p>
        <div v-for="item in changes" :key="item.skill" class="publication-row">
          <strong>{{ item.skill }}</strong>
          <span>
            <code :title="item.previous">{{ item.previous?.slice(0, 12) || '未发布' }}</code>
            → <code :title="revisionId">{{ revisionId.slice(0, 12) }}</code>
            <t-tag :theme="item.previous === revisionId ? 'default' : 'primary'" variant="light">
              {{ item.previous === revisionId ? '已是此版本' : item.previous ? '替换' : '新增' }}
            </t-tag>
          </span>
        </div>
        <p class="publication-help">
          生效端点：<code>/{{ group.id }}/mcp</code>
        </p>
      </section>
      <div class="publication-footer">
        <t-button variant="outline" :disabled="saving" @click="close">关闭</t-button>
        <t-button theme="primary" :loading="saving" :disabled="!canPublish" @click="publish">{{
          isHistorical ? '回滚 / 发布此历史版本' : '发布所选版本'
        }}</t-button>
      </div>
    </template>
  </t-dialog>
</template>

<script setup lang="ts">
import {
  Alert as TAlert,
  Button as TButton,
  Dialog as TDialog,
  Form as TForm,
  FormItem as TFormItem,
  Loading as TLoading,
  Popconfirm as TPopconfirm,
  Select as TSelect,
  Tag as TTag,
  MessagePlugin,
} from 'tdesign-vue-next';
import { computed, ref, watch } from 'vue';

import { getGroup, getGroups, updateGroup } from '@/services/group';
import { skillErrorMessage, skillService } from '@/services/skill';

import type { GroupDetailInfo, GroupInfo } from '@/types/group';
import type { SkillRevision, SkillSelection, SkillSourceInfo } from '@/types/skill';

const props = defineProps<{
  visible: boolean;
  groupId?: string;
  sourceId?: string;
  revision?: string;
}>();
const emit = defineEmits<{ 'update:visible': [visible: boolean]; saved: [] }>();
const groups = ref<GroupInfo[]>([]);
const sources = ref<SkillSourceInfo[]>([]);
const groupId = ref('');
const sourceId = ref('');
const group = ref<GroupDetailInfo>();
const revisions = ref<SkillRevision[]>([]);
const revisionId = ref('');
const skillNames = ref<string[]>([]);
const loading = ref(false);
const groupLoading = ref(false);
const versionsLoading = ref(false);
const saving = ref(false);
const error = ref('');
let session = 0;
let groupRequest = 0;
let versionRequest = 0;

const currentSelections = computed(() => group.value?.skills?.include ?? []);
const selectedRevision = computed(() =>
  revisions.value.find((item) => item.revision === revisionId.value),
);
const isHistorical = computed(
  () =>
    !!selectedRevision.value &&
    revisionId.value !==
      sources.value.find((source) => source.id === sourceId.value)?.latest?.revision,
);
const versionOptions = computed(() =>
  revisions.value.map((item) => ({
    value: item.revision,
    label: `${item.revision.slice(0, 12)} · ${new Date(item.importedAt).toLocaleString()}${item.revision === sources.value.find((source) => source.id === sourceId.value)?.latest?.revision ? ' · 最新候选' : ''}`,
  })),
);
const selections = computed(
  () =>
    selectedRevision.value?.selections.filter((item) => skillNames.value.includes(item.skill)) ??
    [],
);
const changes = computed(() =>
  selections.value.map((item) => ({
    skill: item.skill,
    previous: currentSelections.value.find(
      (current) => current.sourceId === item.sourceId && current.skill === item.skill,
    )?.revision,
  })),
);
const canPublish = computed(
  () =>
    !loading.value &&
    !saving.value &&
    !groupLoading.value &&
    !versionsLoading.value &&
    !!group.value &&
    selections.value.length > 0 &&
    changes.value.some((item) => item.previous !== revisionId.value),
);

watch(
  () => props.visible,
  async (visible) => {
    const currentSession = ++session;
    ++groupRequest;
    ++versionRequest;
    if (!visible) return;
    loading.value = true;
    error.value = '';
    group.value = undefined;
    revisions.value = [];
    groupId.value = '';
    sourceId.value = '';
    revisionId.value = '';
    skillNames.value = [];
    try {
      const [sourceList, groupList] = await Promise.all([skillService.listSources(), getGroups()]);
      if (session !== currentSession) return;
      sources.value = sourceList;
      groups.value = groupList.groups;
      groupId.value = props.groupId ?? '';
      sourceId.value = props.sourceId ?? '';
    } catch (cause) {
      if (session === currentSession) error.value = skillErrorMessage(cause);
    } finally {
      if (session === currentSession) loading.value = false;
    }
  },
  { immediate: true },
);

watch(groupId, async (id) => {
  const request = ++groupRequest;
  group.value = undefined;
  groupLoading.value = !!id;
  if (!id) return;
  try {
    const data = await getGroup(id);
    if (request === groupRequest) group.value = data;
  } catch (cause) {
    if (request === groupRequest) error.value = skillErrorMessage(cause);
  } finally {
    if (request === groupRequest) groupLoading.value = false;
  }
});

watch(sourceId, async (id) => {
  const request = ++versionRequest;
  revisions.value = [];
  revisionId.value = '';
  versionsLoading.value = !!id;
  if (!id) return;
  try {
    const data = await skillService.listRevisions(id);
    if (request !== versionRequest) return;
    revisions.value = data;
    const preferred =
      props.sourceId === id && props.revision
        ? props.revision
        : sources.value.find((source) => source.id === id)?.latest?.revision;
    if (preferred && !data.some((item) => item.revision === preferred)) {
      error.value = '所选版本已不可用，请重新选择一个已保存的版本';
      return;
    }
    revisionId.value = preferred ?? data[0]?.revision ?? '';
  } catch (cause) {
    if (request === versionRequest) error.value = skillErrorMessage(cause);
  } finally {
    if (request === versionRequest) versionsLoading.value = false;
  }
});

watch(selectedRevision, (revision) => {
  skillNames.value = revision?.selections.map((item) => item.skill) ?? [];
});

function sameSelections(left: SkillSelection[], right: SkillSelection[]) {
  return (
    left.length === right.length &&
    left.every((item) =>
      right.some(
        (other) =>
          item.sourceId === other.sourceId &&
          item.skill === other.skill &&
          item.revision === other.revision,
      ),
    )
  );
}

async function save(include: SkillSelection[], message: string) {
  if (!group.value || saving.value) return;
  saving.value = true;
  error.value = '';
  try {
    const latestGroup = await getGroup(group.value.id);
    if (!sameSelections(latestGroup.skills?.include ?? [], currentSelections.value)) {
      group.value = latestGroup;
      throw new Error('Group 的技能已被其他操作修改，已刷新当前版本。请检查变更预览后重试。');
    }
    if (!latestGroup.servers.length && !include.length)
      throw new Error('纯技能 Group 至少需要保留一个技能');
    await updateGroup(group.value.id, { skills: { include } });
    group.value = { ...latestGroup, skills: { include } };
    MessagePlugin.success(message);
    emit('saved');
  } catch (cause) {
    error.value = skillErrorMessage(cause);
  } finally {
    saving.value = false;
  }
}

async function publish() {
  if (!canPublish.value) return;
  const replacementKeys = new Set(selections.value.map((item) => `${item.sourceId}:${item.skill}`));
  const retained = currentSelections.value.filter(
    (item) => !replacementKeys.has(`${item.sourceId}:${item.skill}`),
  );
  await save(
    [...retained, ...selections.value],
    isHistorical.value ? '历史版本已发布，回滚完成' : '技能版本已发布',
  );
}

async function revoke(item: SkillSelection) {
  await save(
    currentSelections.value.filter(
      (current) => current.sourceId !== item.sourceId || current.skill !== item.skill,
    ),
    '技能已从此 Group 撤销',
  );
}

function close() {
  if (!saving.value) emit('update:visible', false);
}
</script>

<style scoped>
.publication-alert {
  margin-bottom: var(--space-4);
}
.publication-current,
.publication-preview {
  padding: var(--space-4);
  background: var(--bg-secondary);
  border-radius: var(--radius-md);
  margin-bottom: var(--space-4);
}
h3 {
  margin: 0 0 var(--space-3);
  font-size: var(--text-md);
}
.publication-help {
  color: var(--text-secondary);
  font-size: var(--text-sm);
  margin: var(--space-2) 0;
}
.publication-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-2) 0;
  flex-wrap: wrap;
}
code {
  font-family: var(--font-mono);
  margin: 0 var(--space-2);
  overflow-wrap: anywhere;
}
.publication-footer {
  display: flex;
  justify-content: flex-end;
  gap: var(--space-3);
  margin-top: var(--space-5);
}
</style>
