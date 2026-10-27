<template>
  <div class="mcp-card server-list">
    <!-- Toolbar: search + filter -->
    <div class="mcp-toolbar" style="padding: var(--space-4) var(--space-5) 0">
      <div class="mcp-toolbar__left">
        <t-input
          v-model="searchQuery"
          placeholder="搜索服务器名称或ID"
          clearable
          style="width: 260px"
          @input="handleSearch"
        >
          <template #prefix-icon>
            <SearchIcon />
          </template>
        </t-input>
        <t-select
          v-model="statusFilter"
          placeholder="状态筛选"
          clearable
          style="width: 160px"
          :options="statusOptions"
          @change="handleFilter"
        />
      </div>
    </div>

    <!-- Table -->
    <t-table
      v-if="!loading && filteredServers.length > 0"
      :data="filteredServers"
      :columns="columns"
      row-key="id"
      hover
      stripe
      style="margin-top: var(--space-3)"
    >
      <template #name="{ row }">
        <span class="server-list__name" @click="emit('edit', row)">
          {{ row.name }}
        </span>
      </template>

      <template #type="{ row }">
        <t-tag variant="light" size="small">
          {{ row.type }}
        </t-tag>
      </template>

      <template #status="{ row }">
        <span :class="['mcp-status', `mcp-status--${row.status}`]">
          <span class="mcp-status__dot" />
          {{ statusLabel(row.status) }}
        </span>
      </template>

      <template #toolCount="{ row }">
        {{ row.toolCount ?? 0 }}
      </template>

      <template #lastConnected="{ row }">
        {{ row.lastConnected ? formatTime(row.lastConnected) : '-' }}
      </template>

      <template #actions="{ row }">
        <div class="server-list__actions">
          <t-button
            v-if="row.status !== 'connected' && row.status !== 'connecting'"
            variant="text"
            shape="square"
            size="small"
            aria-label="连接服务器"
            @click="emit('connect', row.id)"
          >
            <template #icon><LinkIcon /></template>
          </t-button>
          <t-button
            v-if="row.status === 'connected'"
            variant="text"
            shape="square"
            size="small"
            theme="warning"
            aria-label="断开服务器"
            @click="emit('disconnect', row.id)"
          >
            <template #icon><LinkUnlinkIcon /></template>
          </t-button>
          <t-button
            variant="text"
            shape="square"
            size="small"
            aria-label="编辑服务器"
            @click="emit('edit', row)"
          >
            <template #icon><EditIcon /></template>
          </t-button>
          <t-popconfirm content="确认删除此服务器？" @confirm="emit('delete', row.id)">
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
    <div v-if="!loading && servers.length === 0" class="mcp-empty">
      <ServerIcon class="mcp-empty__icon" />
      <p class="mcp-empty__title">暂无服务器</p>
      <p class="mcp-empty__desc">点击"添加服务器"按钮创建第一个MCP服务器</p>
    </div>

    <!-- Filtered empty state -->
    <div v-if="!loading && servers.length > 0 && filteredServers.length === 0" class="mcp-empty">
      <SearchIcon class="mcp-empty__icon" />
      <p class="mcp-empty__title">未找到匹配的服务器</p>
      <p class="mcp-empty__desc">尝试调整搜索条件或状态筛选</p>
    </div>
  </div>
</template>

<script setup lang="ts">
import {
  SearchIcon,
  LinkIcon,
  LinkUnlinkIcon,
  EditIcon,
  DeleteIcon,
  ServerIcon,
} from 'tdesign-icons-vue-next';
import { ref, computed } from 'vue';

import type { ServerInfo, ServerStatus } from '@/types/server';

const props = defineProps<{
  servers: ServerInfo[];
  loading: boolean;
}>();

const emit = defineEmits<{
  edit: [server: ServerInfo];
  delete: [id: string];
  connect: [id: string];
  disconnect: [id: string];
}>();

const searchQuery = ref('');
const statusFilter = ref<ServerStatus | ''>('');

const statusOptions = [
  { label: '已连接', value: 'connected' },
  { label: '连接中', value: 'connecting' },
  { label: '已断开', value: 'disconnected' },
  { label: '错误', value: 'error' },
];

const columns = [
  { colKey: 'name', title: '名称', width: 180 },
  { colKey: 'type', title: '类型', width: 120 },
  { colKey: 'status', title: '状态', width: 140 },
  { colKey: 'toolCount', title: '工具数', width: 100 },
  { colKey: 'lastConnected', title: '最后连接', width: 200 },
  { colKey: 'actions', title: '操作', width: 160, fixed: 'right' as const },
];

const filteredServers = computed(() => {
  let result = props.servers;

  if (searchQuery.value) {
    const query = searchQuery.value.toLowerCase();
    result = result.filter(
      (s) => s.name.toLowerCase().includes(query) || s.id.toLowerCase().includes(query),
    );
  }

  if (statusFilter.value) {
    result = result.filter((s) => s.status === statusFilter.value);
  }

  return result;
});

function statusLabel(status: ServerStatus): string {
  const map: Record<ServerStatus, string> = {
    connected: '已连接',
    connecting: '连接中',
    disconnected: '已断开',
    error: '错误',
  };
  return map[status] ?? status;
}

function formatTime(timestamp: string): string {
  return new Date(timestamp).toLocaleString('zh-CN');
}

function handleSearch() {
  // Reactive via computed
}

function handleFilter() {
  // Reactive via computed
}
</script>

<style scoped>
.server-list {
  overflow: hidden;
}

.server-list__name {
  font-weight: var(--weight-semibold);
  color: var(--accent);
  cursor: pointer;
  transition: color var(--transition-fast);
}

.server-list__name:hover {
  color: var(--accent-hover);
}

.server-list__actions {
  display: flex;
  align-items: center;
  gap: var(--space-1);
}
</style>
