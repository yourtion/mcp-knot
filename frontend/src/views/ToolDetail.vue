<template>
  <div class="mcp-page">
    <div class="mcp-page__header">
      <div class="detail-header">
        <div>
          <t-button variant="text" size="small" @click="goBack">
            <template #icon><ChevronLeftIcon /></template>
            返回工具列表
          </t-button>
          <h2 class="mcp-page__title detail-title">{{ tool?.name || toolName }}</h2>
          <p class="mcp-page__desc">{{ tool?.description || '加载中...' }}</p>
        </div>
        <div class="mcp-page__actions">
          <t-button variant="outline" @click="goTest">
            <template #icon><CheckCircleIcon /></template>
            测试工具
          </t-button>
          <t-button theme="primary" @click="goExecute">
            <template #icon><PlayIcon /></template>
            执行工具
          </t-button>
        </div>
      </div>
    </div>

    <t-loading :loading="loading" />

    <template v-if="tool && !loading">
      <!-- Status & Server Info -->
      <div class="mcp-grid mcp-grid--2 mcp-section">
        <div class="mcp-card detail-info-card">
          <h3 class="detail-info-card__title">服务器信息</h3>
          <div class="detail-info-card__row">
            <span class="detail-info-card__label">服务器 ID</span>
            <span class="detail-info-card__value">{{ tool.serverId }}</span>
          </div>
          <div v-if="tool.serverName" class="detail-info-card__row">
            <span class="detail-info-card__label">服务器名称</span>
            <span class="detail-info-card__value">{{ tool.serverName }}</span>
          </div>
          <div class="detail-info-card__row">
            <span class="detail-info-card__label">状态</span>
            <span :class="`mcp-status mcp-status--${tool.status}`">
              <span class="mcp-status__dot" />
              <span>{{ tool.status === 'available' ? '可用' : '不可用' }}</span>
            </span>
          </div>
        </div>

        <div class="mcp-card detail-info-card">
          <h3 class="detail-info-card__title">Schema 概览</h3>
          <div class="detail-info-card__row">
            <span class="detail-info-card__label">类型</span>
            <span class="detail-info-card__value">{{ tool.inputSchema.type }}</span>
          </div>
          <div class="detail-info-card__row">
            <span class="detail-info-card__label">参数数量</span>
            <span class="detail-info-card__value">{{ parameterCount }}</span>
          </div>
          <div class="detail-info-card__row">
            <span class="detail-info-card__label">必填参数</span>
            <span class="detail-info-card__value">{{ requiredParams.length }}</span>
          </div>
        </div>
      </div>

      <!-- Parameter Schema -->
      <div class="mcp-section">
        <div class="mcp-card detail-schema-card">
          <h3 class="detail-schema-card__title">参数定义</h3>
          <template v-if="schemaProperties.length > 0">
            <t-table
              :data="schemaProperties"
              :columns="schemaColumns"
              row-key="name"
              size="medium"
              stripe
            />
          </template>
          <template v-else>
            <div class="mcp-empty">
              <div class="mcp-empty__desc">此工具无输入参数</div>
            </div>
          </template>
        </div>
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { ChevronLeftIcon, CheckCircleIcon, PlayIcon } from 'tdesign-icons-vue-next';
import { MessagePlugin } from 'tdesign-vue-next';
import { computed, h, onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';

import { useToolStore } from '@/stores/tool';

import type { ToolInfo } from '@/types/tool';
import type { PrimaryTableCol, TableRowData } from 'tdesign-vue-next';

interface SchemaPropertyRow {
  name: string;
  type: string;
  description: string;
  required: boolean;
  enumValues: string[];
  defaultValue: string;
}

const route = useRoute();
const router = useRouter();
const toolStore = useToolStore();

const toolName = computed(() => route.params.toolName as string);
const loading = ref(false);
const tool = ref<ToolInfo | null>(null);

const requiredParams = computed(() => {
  if (!tool.value?.inputSchema?.required) return [];
  return tool.value.inputSchema.required;
});

const parameterCount = computed(() => {
  if (!tool.value?.inputSchema?.properties) return 0;
  return Object.keys(tool.value.inputSchema.properties).length;
});

const schemaProperties = computed((): SchemaPropertyRow[] => {
  if (!tool.value?.inputSchema?.properties) return [];
  const properties = tool.value.inputSchema.properties;
  const required = tool.value.inputSchema.required || [];

  return Object.entries(properties).map(([name, prop]) => ({
    name,
    type: prop.type || 'unknown',
    description: prop.description || '-',
    required: required.includes(name),
    enumValues: prop.enum || [],
    defaultValue: prop.default !== undefined ? JSON.stringify(prop.default) : '-',
  }));
});

const schemaColumns: PrimaryTableCol<TableRowData>[] = [
  {
    title: '参数名',
    colKey: 'name',
    width: 200,
    cell: (_h, { row }) => {
      const r = row as SchemaPropertyRow;
      return h('span', { style: { fontFamily: 'var(--font-mono)', fontWeight: 600 } }, r.name);
    },
  },
  {
    title: '类型',
    colKey: 'type',
    width: 120,
    cell: (_h, { row }) => {
      const r = row as SchemaPropertyRow;
      return h(
        'span',
        {
          style: {
            fontSize: 'var(--text-xs)',
            fontWeight: 500,
            padding: '2px 8px',
            background: 'var(--bg-tertiary)',
            borderRadius: 'var(--radius-sm)',
            color: 'var(--accent)',
          },
        },
        r.type,
      );
    },
  },
  {
    title: '描述',
    colKey: 'description',
    cell: (_h, { row }) => {
      const r = row as SchemaPropertyRow;
      return h('span', { style: { color: 'var(--text-secondary)' } }, r.description);
    },
  },
  {
    title: '必填',
    colKey: 'required',
    width: 80,
    cell: (_h, { row }) => {
      const r = row as SchemaPropertyRow;
      return r.required
        ? h(
            'span',
            {
              style: {
                fontSize: 'var(--text-xs)',
                fontWeight: 500,
                padding: '2px 8px',
                background: 'var(--accent-light)',
                color: 'var(--accent)',
                borderRadius: 'var(--radius-full)',
              },
            },
            '必填',
          )
        : h('span', { style: { color: 'var(--text-tertiary)' } }, '-');
    },
  },
  {
    title: '枚举值',
    colKey: 'enumValues',
    width: 200,
    cell: (_h, { row }) => {
      const r = row as SchemaPropertyRow;
      if (r.enumValues.length === 0) {
        return h('span', { style: { color: 'var(--text-tertiary)' } }, '-');
      }
      return h(
        'div',
        {
          style: {
            display: 'flex',
            gap: '4px',
            flexWrap: 'wrap',
          },
        },
        r.enumValues.map((v) =>
          h(
            'span',
            {
              style: {
                fontSize: 'var(--text-xs)',
                padding: '1px 6px',
                background: 'var(--bg-tertiary)',
                borderRadius: 'var(--radius-xs)',
                color: 'var(--text-secondary)',
              },
            },
            v,
          ),
        ),
      );
    },
  },
  {
    title: '默认值',
    colKey: 'defaultValue',
    width: 120,
    cell: (_h, { row }) => {
      const r = row as SchemaPropertyRow;
      return h(
        'span',
        {
          style: {
            fontFamily: 'var(--font-mono)',
            fontSize: 'var(--text-sm)',
            color: r.defaultValue === '-' ? 'var(--text-tertiary)' : 'var(--text-secondary)',
          },
        },
        r.defaultValue,
      );
    },
  },
];

const goBack = () => {
  router.push({ name: 'Tools' });
};

const goTest = () => {
  router.push({ name: 'ToolTest', params: { toolName: toolName.value } });
};

const goExecute = () => {
  router.push({ name: 'ToolExecute', params: { toolName: toolName.value } });
};

onMounted(async () => {
  loading.value = true;
  try {
    tool.value = await toolStore.fetchToolDetail(toolName.value);
  } catch {
    MessagePlugin.error('获取工具详情失败');
  } finally {
    loading.value = false;
  }
});
</script>

<style scoped>
.detail-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--space-4);
}

.detail-title {
  margin-top: var(--space-2);
}

.detail-info-card {
  padding: var(--space-5);
}

.detail-info-card__title {
  font-size: var(--text-md);
  font-weight: var(--weight-semibold);
  color: var(--text-primary);
  margin-bottom: var(--space-4);
}

.detail-info-card__row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: var(--space-2) 0;
  border-bottom: 1px solid var(--border-light);
}

.detail-info-card__row:last-child {
  border-bottom: none;
}

.detail-info-card__label {
  font-size: var(--text-sm);
  color: var(--text-secondary);
}

.detail-info-card__value {
  font-size: var(--text-sm);
  font-weight: var(--weight-medium);
  color: var(--text-primary);
}

.detail-schema-card {
  padding: var(--space-5);
}

.detail-schema-card__title {
  font-size: var(--text-md);
  font-weight: var(--weight-semibold);
  color: var(--text-primary);
  margin-bottom: var(--space-4);
}
</style>
