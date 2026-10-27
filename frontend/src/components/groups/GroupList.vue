<template>
  <div class="mcp-card group-list">
    <!-- Toolbar: search -->
    <div class="mcp-toolbar" style="padding: var(--space-4) var(--space-5) 0">
      <div class="mcp-toolbar__left">
        <t-input v-model="searchQuery" placeholder="搜索组名称或ID" clearable style="width: 260px">
          <template #prefix-icon>
            <SearchIcon />
          </template>
        </t-input>
      </div>
    </div>

    <!-- Table -->
    <t-table
      v-if="!loading && filteredGroups.length > 0"
      :data="filteredGroups"
      :columns="columns"
      row-key="id"
      hover
      stripe
      style="margin-top: var(--space-3)"
    >
      <template #name="{ row }">
        <span class="group-list__name" @click="emit('edit', row)">
          {{ row.name }}
        </span>
      </template>

      <template #description="{ row }">
        <span class="group-list__description">
          {{ row.description || '-' }}
        </span>
      </template>

      <template #servers="{ row }">
        <span class="group-list__servers">
          {{ row.connectedServers }}/{{ row.stats.totalServers }}
        </span>
      </template>

      <template #tools="{ row }">
        <span class="group-list__tools"> {{ row.filteredToolCount }}/{{ row.toolCount }} </span>
      </template>

      <template #skills="{ row }">
        {{ row.skills?.include.length ?? 0 }}
      </template>

      <template #health="{ row }">
        <span :class="['group-list__health', healthColorClass(row.healthScore)]">
          {{ healthPercentage(row.healthScore) }}
        </span>
      </template>

      <template #validation="{ row }">
        <span
          v-if="row.validation.enabled"
          class="group-list__validation group-list__validation--enabled"
        >
          <CheckCircleIcon />
          已启用
        </span>
        <span v-else class="group-list__validation group-list__validation--disabled">
          <CloseCircleIcon />
          未启用
        </span>
      </template>

      <template #actions="{ row }">
        <div class="group-list__actions">
          <t-tooltip v-if="canManageSkills" content="发布技能 / 回滚">
            <t-button
              variant="text"
              shape="square"
              size="small"
              aria-label="发布技能或回滚"
              @click="emit('manageSkills', row.id)"
            >
              <template #icon><BookOpenIcon /></template>
            </t-button>
          </t-tooltip>
          <t-tooltip content="编辑">
            <t-button
              variant="text"
              shape="square"
              size="small"
              aria-label="编辑组"
              @click="emit('edit', row)"
            >
              <template #icon><EditIcon /></template>
            </t-button>
          </t-tooltip>
          <t-tooltip content="管理工具">
            <t-button
              variant="text"
              shape="square"
              size="small"
              aria-label="管理工具"
              @click="emit('manageTools', row.id)"
            >
              <template #icon><ControlPlatformIcon /></template>
            </t-button>
          </t-tooltip>
          <t-tooltip content="管理验证">
            <t-button
              variant="text"
              shape="square"
              size="small"
              aria-label="管理验证"
              @click="emit('manageValidation', row.id)"
            >
              <template #icon><LockOnIcon /></template>
            </t-button>
          </t-tooltip>
          <t-popconfirm content="确认删除此组？" @confirm="emit('delete', row.id)">
            <t-button variant="text" shape="square" size="small" theme="danger" aria-label="删除">
              <template #icon><DeleteIcon /></template>
            </t-button>
          </t-popconfirm>
        </div>
      </template>
    </t-table>

    <!-- Loading state -->
    <div v-if="loading" style="padding: var(--space-10) 0">
      <t-loading size="medium" text="加载中..." />
    </div>

    <!-- Empty state -->
    <div v-if="!loading && groups.length === 0" class="mcp-empty">
      <FolderIcon class="mcp-empty__icon" />
      <p class="mcp-empty__title">暂无组</p>
      <p class="mcp-empty__desc">点击"创建组"按钮创建第一个服务器组</p>
    </div>

    <!-- Filtered empty state -->
    <div v-if="!loading && groups.length > 0 && filteredGroups.length === 0" class="mcp-empty">
      <SearchIcon class="mcp-empty__icon" />
      <p class="mcp-empty__title">未找到匹配的组</p>
      <p class="mcp-empty__desc">尝试调整搜索条件</p>
    </div>
  </div>
</template>

<script setup lang="ts">
import {
  SearchIcon,
  EditIcon,
  DeleteIcon,
  FolderIcon,
  CheckCircleIcon,
  CloseCircleIcon,
  ControlPlatformIcon,
  LockOnIcon,
  BookOpenIcon,
} from 'tdesign-icons-vue-next';
import { ref, computed } from 'vue';

import type { GroupInfo } from '@/types/group';

const props = defineProps<{
  groups: GroupInfo[];
  loading: boolean;
  canManageSkills?: boolean;
}>();

const emit = defineEmits<{
  edit: [group: GroupInfo];
  delete: [id: string];
  manageTools: [id: string];
  manageValidation: [id: string];
  manageSkills: [id: string];
}>();

const searchQuery = ref('');

const columns = [
  { colKey: 'name', title: '名称', width: 160 },
  { colKey: 'description', title: '描述', width: 200 },
  { colKey: 'servers', title: '服务器', width: 100 },
  { colKey: 'tools', title: '工具', width: 100 },
  { colKey: 'skills', title: '技能', width: 80 },
  { colKey: 'health', title: '健康度', width: 100 },
  { colKey: 'validation', title: '验证', width: 120 },
  { colKey: 'actions', title: '操作', width: 210, fixed: 'right' as const },
];

const filteredGroups = computed(() => {
  if (!searchQuery.value) return props.groups;
  const query = searchQuery.value.toLowerCase();
  return props.groups.filter(
    (g) => g.name.toLowerCase().includes(query) || g.id.toLowerCase().includes(query),
  );
});

function healthPercentage(score: number): string {
  return `${Math.round(score)}%`;
}

function healthColorClass(score: number): string {
  if (score > 80) return 'group-list__health--good';
  if (score > 50) return 'group-list__health--warn';
  return 'group-list__health--bad';
}
</script>

<style scoped>
.group-list {
  overflow: hidden;
}

.group-list__name {
  font-weight: var(--weight-semibold);
  color: var(--accent);
  cursor: pointer;
  transition: color var(--transition-fast);
}

.group-list__name:hover {
  color: var(--accent-hover);
}

.group-list__description {
  color: var(--text-secondary);
  font-size: var(--text-sm);
}

.group-list__servers,
.group-list__tools {
  font-variant-numeric: tabular-nums;
}

.group-list__health {
  font-weight: var(--weight-semibold);
  font-variant-numeric: tabular-nums;
}

.group-list__health--good {
  color: var(--success);
}

.group-list__health--warn {
  color: var(--warning);
}

.group-list__health--bad {
  color: var(--danger);
}

.group-list__validation {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  font-size: var(--text-sm);
  font-weight: var(--weight-medium);
}

.group-list__validation--enabled {
  color: var(--success);
}

.group-list__validation--disabled {
  color: var(--text-tertiary);
}

.group-list__actions {
  display: flex;
  align-items: center;
  gap: var(--space-1);
}
</style>
