<template>
  <div class="tool-list">
    <div class="mcp-toolbar">
      <div class="mcp-toolbar__left">
        <t-input
          v-model="searchText"
          placeholder="搜索工具名称或描述"
          clearable
          style="width: 260px"
          @change="handleSearch"
        >
          <template #prefixIcon>
            <SearchIcon />
          </template>
        </t-input>
        <t-select
          v-model="statusFilter"
          placeholder="状态筛选"
          clearable
          style="width: 140px"
          :options="statusOptions"
          @change="handleFilter"
        />
      </div>
      <div class="mcp-toolbar__right">
        <span class="tool-list__count"> 共 {{ filteredData.length }} 个工具 </span>
      </div>
    </div>

    <t-table
      :data="filteredData"
      :columns="columns"
      :loading="loading"
      row-key="name"
      hover
      stripe
      :empty="() => emptyContent"
      @row-click="handleRowClick"
    />
  </div>
</template>

<script setup lang="ts">
import { SearchIcon } from 'tdesign-icons-vue-next';
import { computed, ref, h } from 'vue';

import type { ToolInfo } from '@/types/tool';
import type { PrimaryTableCol, TableRowData } from 'tdesign-vue-next';

const props = defineProps<{
  tools: ToolInfo[];
  loading: boolean;
}>();

const emit = defineEmits<{
  select: [tool: ToolInfo];
}>();

const searchText = ref('');
const statusFilter = ref<string | undefined>(undefined);

const statusOptions = [
  { label: '可用', value: 'available' },
  { label: '不可用', value: 'unavailable' },
];

const filteredData = computed(() => {
  let result = props.tools;

  if (searchText.value) {
    const term = searchText.value.toLowerCase();
    result = result.filter(
      (tool) =>
        tool.name.toLowerCase().includes(term) || tool.description.toLowerCase().includes(term),
    );
  }

  if (statusFilter.value) {
    result = result.filter((tool) => tool.status === statusFilter.value);
  }

  return result;
});

const emptyContent = h('div', { class: 'mcp-empty' }, [
  h('div', { class: 'mcp-empty__icon' }, '\u{1F527}'),
  h('div', { class: 'mcp-empty__title' }, '暂无工具'),
  h('div', { class: 'mcp-empty__desc' }, '未找到匹配的工具，请调整搜索条件'),
]);

const columns: PrimaryTableCol<TableRowData>[] = [
  {
    title: '名称',
    colKey: 'name',
    width: 240,
    cell: (_h, { row }) => {
      const tool = row as ToolInfo;
      return h(
        'span',
        {
          style: {
            fontWeight: 600,
            color: 'var(--accent)',
            cursor: 'pointer',
          },
        },
        tool.name,
      );
    },
  },
  {
    title: '描述',
    colKey: 'description',
    cell: (_h, { row }) => {
      const tool = row as ToolInfo;
      const desc = tool.description || '-';
      const truncated = desc.length > 60 ? `${desc.slice(0, 60)}...` : desc;
      return h('span', { style: { color: 'var(--text-secondary)' } }, truncated);
    },
  },
  {
    title: '服务器',
    colKey: 'serverId',
    width: 180,
    cell: (_h, { row }) => {
      const tool = row as ToolInfo;
      return h(
        'span',
        {
          style: {
            display: 'inline-flex',
            alignItems: 'center',
            padding: '2px 10px',
            fontSize: 'var(--text-xs)',
            fontWeight: 500,
            background: 'var(--bg-tertiary)',
            borderRadius: 'var(--radius-full)',
            color: 'var(--text-secondary)',
          },
        },
        tool.serverName || tool.serverId,
      );
    },
  },
  {
    title: '状态',
    colKey: 'status',
    width: 120,
    cell: (_h, { row }) => {
      const tool = row as ToolInfo;
      const isAvailable = tool.status === 'available';
      return h(
        'span',
        {
          class: `mcp-status mcp-status--${tool.status}`,
        },
        [
          h('span', { class: 'mcp-status__dot' }),
          h(
            'span',
            {
              style: {
                color: isAvailable ? 'var(--success)' : 'var(--text-tertiary)',
              },
            },
            isAvailable ? '可用' : '不可用',
          ),
        ],
      );
    },
  },
];

const handleSearch = () => {
  // Filtering is reactive via computed
};

const handleFilter = () => {
  // Filtering is reactive via computed
};

const handleRowClick = ({ row }: { row: TableRowData }) => {
  emit('select', row as ToolInfo);
};
</script>

<style scoped>
.tool-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

.tool-list__count {
  font-size: var(--text-sm);
  color: var(--text-tertiary);
  white-space: nowrap;
}
</style>
