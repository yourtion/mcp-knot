<template>
  <div class="mcp-page skills-page">
    <div class="mcp-page__header">
      <div>
        <h1 class="mcp-page__title">技能管理</h1>
        <p class="mcp-page__desc">导入技能快照，选择固定版本并发布到 Group，随时切换历史版本。</p>
      </div>
      <div v-if="isAdmin" class="mcp-page__actions">
        <t-button variant="outline" :loading="loading" :disabled="!!busySource" @click="refresh">
          <template #icon><RefreshIcon /></template>刷新
        </t-button>
        <t-button theme="primary" :disabled="!!busySource" @click="importVisible = true">
          <template #icon><AddIcon /></template>导入技能
        </t-button>
      </div>
    </div>

    <t-alert v-if="!isAdmin" theme="warning" message="技能来源和版本管理需要管理员权限。" />
    <template v-else>
      <t-alert v-if="error" theme="error" :message="error" class="skills-alert" />
      <t-alert
        theme="info"
        message="同步与更新只生成候选版本。Group 持续使用已发布的固定版本，直到你明确发布或回滚。"
        class="skills-alert"
      />
      <t-loading v-if="loading && !sources.length" text="加载技能来源…" />
      <div v-else-if="!sources.length && !error" class="mcp-card mcp-empty">
        <BookOpenIcon class="mcp-empty__icon" />
        <p class="mcp-empty__title">尚未导入技能</p>
        <p class="mcp-empty__desc">从公共 Git 仓库、服务器目录或 skills CLI 导入选定的技能。</p>
        <t-button theme="primary" @click="importVisible = true">导入第一个技能</t-button>
      </div>

      <div class="skills-sources">
        <article
          v-for="source in sources"
          :key="source.id"
          class="mcp-card skills-source"
          :class="{ 'skills-source--selected': source.id === sourceId }"
        >
          <div class="skills-source__heading">
            <h2>{{ source.id }}</h2>
            <t-tag variant="light">{{ sourceLabels[source.type] }}</t-tag>
            <t-tag :theme="source.latest ? 'success' : 'warning'" variant="light">{{
              source.latest ? '已导入' : '待同步'
            }}</t-tag>
          </div>
          <p class="skills-source__location">
            {{ source.type === 'local' ? source.directory : source.repository }}
          </p>
          <p class="skills-muted">技能：{{ source.skills.join('、') }}</p>
          <p v-if="source.latest" class="skills-muted">
            最新候选
            <code :title="source.latest.revision">{{ source.latest.revision.slice(0, 12) }}</code> ·
            {{ formatTime(source.latest.importedAt) }}
          </p>
          <p class="skills-muted">已发布至 {{ publishedGroups(source.id).length }} 个 Group</p>
          <div class="skills-source__actions">
            <t-button variant="outline" :disabled="!!busySource" @click="showVersions(source)"
              >查看版本</t-button
            >
            <t-button
              :loading="busySource === source.id"
              :disabled="!!busySource && busySource !== source.id"
              @click="sync(source)"
            >
              {{ source.latest ? '更新候选' : '同步导入' }}
            </t-button>
          </div>
        </article>
      </div>

      <section v-if="activeSource" class="mcp-card skills-versions">
        <div class="skills-versions__heading">
          <h2>{{ activeSource.id }} · 版本与技能</h2>
          <t-button
            theme="primary"
            :disabled="!selectedRevision || versionsLoading || !!busySource"
            @click="publishVisible = true"
            >发布到 Group / 回滚</t-button
          >
        </div>
        <t-alert v-if="versionError" theme="error" :message="versionError" class="skills-alert" />
        <t-loading v-if="versionsLoading" text="读取已保存的历史版本…" />
        <template v-else-if="selectedRevision">
          <t-select
            v-model="revisionId"
            :options="versionOptions"
            class="skills-version-select"
            filterable
          />
          <dl class="skills-provenance">
            <dt>完整版本</dt>
            <dd>
              <code>{{ selectedRevision.revision }}</code>
            </dd>
            <dt>导入时间</dt>
            <dd>{{ formatTime(selectedRevision.importedAt) }}</dd>
            <template v-if="selectedRevision.provenance.commit"
              ><dt>Git Commit</dt>
              <dd>
                <code>{{ selectedRevision.provenance.commit }}</code>
              </dd></template
            >
            <template v-if="selectedRevision.provenance.cliVersion"
              ><dt>CLI 版本</dt>
              <dd>{{ selectedRevision.provenance.cliVersion }}</dd></template
            >
          </dl>
          <article v-for="skill in selectedRevision.skills" :key="skill.uri" class="skills-entry">
            <h3>{{ skill.frontmatter.name }}</h3>
            <p>{{ skill.frontmatter.description }}</p>
            <p class="skills-muted">
              {{ skill.resources.length }} 个文件 ·
              {{ formatBytes(skill.resources.reduce((total, file) => total + file.size, 0)) }}
            </p>
            <p class="skills-muted">
              发布至：{{
                publishedForSkill(skill.frontmatter.name, selectedRevision.revision).join('、') ||
                '此版本尚未发布'
              }}
            </p>
            <details>
              <summary>查看文件清单与 SHA-256</summary>
              <div class="skills-files">
                <div v-for="file in skill.resources" :key="file.uri" class="skills-file">
                  <strong>{{ fileName(file.uri, skill.uri) }}</strong>
                  <span>{{ formatBytes(file.size) }}</span>
                  <code>{{ file.digest }}</code>
                </div>
              </div>
            </details>
          </article>
        </template>
        <p v-else-if="!versionError" class="skills-muted">此来源尚无可用版本，请先同步导入。</p>
      </section>
      <SkillImportDialog
        v-model:visible="importVisible"
        @changed="refresh"
        @imported="onImported"
      />
      <SkillPublishDialog
        v-if="publishVisible"
        v-model:visible="publishVisible"
        :source-id="sourceId"
        :revision="revisionId"
        @saved="refresh"
      />
    </template>
  </div>
</template>

<script setup lang="ts">
import { AddIcon, BookOpenIcon, RefreshIcon } from 'tdesign-icons-vue-next';
import {
  Alert as TAlert,
  Button as TButton,
  Loading as TLoading,
  Select as TSelect,
  Tag as TTag,
  MessagePlugin,
} from 'tdesign-vue-next';
import { computed, onMounted, ref } from 'vue';

import SkillImportDialog from '@/components/skills/SkillImportDialog.vue';
import SkillPublishDialog from '@/components/skills/SkillPublishDialog.vue';
import { getGroups } from '@/services/group';
import { skillErrorMessage, skillService } from '@/services/skill';
import { useAuthStore } from '@/stores/auth';

import type { GroupInfo } from '@/types/group';
import type { SkillRevision, SkillSourceInfo } from '@/types/skill';

const authStore = useAuthStore();
const isAdmin = computed(() => authStore.user?.role === 'admin');
const sources = ref<SkillSourceInfo[]>([]);
const groups = ref<GroupInfo[]>([]);
const loading = ref(false);
const error = ref('');
const busySource = ref('');
const importVisible = ref(false);
const publishVisible = ref(false);
const sourceId = ref('');
const revisions = ref<SkillRevision[]>([]);
const revisionId = ref('');
const versionsLoading = ref(false);
const versionError = ref('');
let versionRequest = 0;
let refreshRequest = 0;
const sourceLabels = { git: 'Git', local: '本地目录', 'skills-cli': 'skills CLI' };
const activeSource = computed(() => sources.value.find((source) => source.id === sourceId.value));
const selectedRevision = computed(() =>
  revisions.value.find((revision) => revision.revision === revisionId.value),
);
const versionOptions = computed(() =>
  revisions.value.map((revision) => ({
    value: revision.revision,
    label: `${revision.revision.slice(0, 12)} · ${formatTime(revision.importedAt)}${activeSource.value?.latest?.revision === revision.revision ? ' · 最新候选' : ''}`,
  })),
);

function formatTime(value: string) {
  return new Date(value).toLocaleString();
}
function formatBytes(size: number) {
  return size < 1024
    ? `${size} B`
    : size < 1024 * 1024
      ? `${(size / 1024).toFixed(1)} KiB`
      : `${(size / 1024 / 1024).toFixed(1)} MiB`;
}
function fileName(uri: string, skillUri: string) {
  return decodeURIComponent(uri.slice(skillUri.lastIndexOf('/') + 1));
}
function publishedGroups(id: string) {
  return groups.value.filter((group) => group.skills?.include.some((item) => item.sourceId === id));
}
function publishedForSkill(skill: string, revision: string) {
  return groups.value
    .filter((group) =>
      group.skills?.include.some(
        (item) =>
          item.sourceId === sourceId.value && item.skill === skill && item.revision === revision,
      ),
    )
    .map((group) => group.name);
}

async function refresh() {
  const request = ++refreshRequest;
  if (!isAdmin.value) return;
  loading.value = true;
  error.value = '';
  try {
    const [sourceList, groupList] = await Promise.all([skillService.listSources(), getGroups()]);
    if (request !== refreshRequest) return;
    sources.value = sourceList;
    groups.value = groupList.groups;
  } catch (cause) {
    if (request === refreshRequest) error.value = skillErrorMessage(cause);
  } finally {
    if (request === refreshRequest) loading.value = false;
  }
}

async function showVersions(source: SkillSourceInfo) {
  const request = ++versionRequest;
  sourceId.value = source.id;
  revisionId.value = '';
  revisions.value = [];
  versionError.value = '';
  versionsLoading.value = true;
  try {
    const data = await skillService.listRevisions(source.id);
    if (request !== versionRequest) return;
    revisions.value = data;
    revisionId.value = source.latest?.revision ?? data[0]?.revision ?? '';
  } catch (cause) {
    if (request === versionRequest) versionError.value = skillErrorMessage(cause);
  } finally {
    if (request === versionRequest) versionsLoading.value = false;
  }
}

async function sync(source: SkillSourceInfo) {
  if (busySource.value) return;
  busySource.value = source.id;
  error.value = '';
  try {
    const imported = await skillService.syncSource(source.id, source.latest ? 'update' : 'sync');
    await refresh();
    await showVersions({ ...source, latest: imported });
    MessagePlugin.success('候选版本已保存，可检查后发布到 Group');
  } catch (cause) {
    error.value = skillErrorMessage(cause);
  } finally {
    busySource.value = '';
  }
}

async function onImported(id: string) {
  await refresh();
  const source = sources.value.find((item) => item.id === id);
  if (source) await showVersions(source);
  MessagePlugin.success('技能已导入，尚未发布到 Group');
}

onMounted(refresh);
</script>

<style scoped>
.skills-alert {
  margin-bottom: var(--space-4);
}
.skills-sources {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(min(100%, 330px), 1fr));
  gap: var(--space-4);
}
.skills-source,
.skills-versions {
  padding: var(--space-5);
}
.skills-source--selected {
  border-color: var(--accent);
}
.skills-source__heading,
.skills-source__actions,
.skills-versions__heading {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  flex-wrap: wrap;
}
.skills-source__heading h2,
.skills-versions h2 {
  margin: 0;
  font-size: var(--text-lg);
}
.skills-source__location {
  overflow-wrap: anywhere;
  margin: var(--space-3) 0;
}
.skills-muted {
  color: var(--text-secondary);
  font-size: var(--text-sm);
  margin: var(--space-2) 0;
}
.skills-source__actions {
  margin-top: var(--space-4);
}
.skills-versions {
  margin-top: var(--space-5);
}
.skills-versions__heading {
  justify-content: space-between;
  margin-bottom: var(--space-4);
}
.skills-version-select {
  max-width: 560px;
}
.skills-provenance {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: var(--space-2) var(--space-4);
  margin: var(--space-4) 0;
}
.skills-provenance dt {
  color: var(--text-secondary);
}
.skills-provenance dd {
  min-width: 0;
  margin: 0;
  overflow-wrap: anywhere;
}
.skills-entry {
  border-top: 1px solid var(--border);
  padding: var(--space-4) 0;
}
.skills-entry h3 {
  margin-bottom: var(--space-2);
}
.skills-entry summary {
  cursor: pointer;
  color: var(--accent);
  margin-top: var(--space-3);
}
.skills-file {
  display: flex;
  gap: var(--space-3);
  flex-wrap: wrap;
  padding: var(--space-3) 0;
  border-bottom: 1px solid var(--border);
}
.skills-file code {
  flex-basis: 100%;
  overflow-wrap: anywhere;
  font-size: var(--text-xs);
}
code {
  font-family: var(--font-mono);
}
</style>
