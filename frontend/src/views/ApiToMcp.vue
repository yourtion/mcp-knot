<template>
  <div class="mcp-page api-to-mcp-page">
    <!-- Page Header -->
    <div class="mcp-page__header">
      <div class="mcp-page__header-content">
        <h1 class="mcp-page__title">API转MCP</h1>
        <p class="mcp-page__desc">将外部API转换为MCP工具</p>
      </div>
      <div class="mcp-page__actions">
        <t-button variant="outline" @click="handleExport">
          <template #icon><FileExportIcon /></template>
          导出
        </t-button>
        <t-button variant="outline" @click="handleImport">
          <template #icon><FileImportIcon /></template>
          导入
        </t-button>
        <t-button theme="primary" @click="openAddDialog">
          <template #icon><AddIcon /></template>
          添加API配置
        </t-button>
      </div>
    </div>

    <!-- Stats -->
    <div v-if="stats" class="mcp-grid mcp-grid--4 api-to-mcp-page__stats">
      <div class="mcp-card mcp-stat">
        <div class="mcp-stat__value">{{ stats.totalConfigs }}</div>
        <div class="mcp-stat__label">总配置数</div>
      </div>
      <div class="mcp-card mcp-stat">
        <div class="mcp-stat__value">{{ stats.activeConfigs }}</div>
        <div class="mcp-stat__label">活跃配置</div>
      </div>
      <div class="mcp-card mcp-stat">
        <div class="mcp-stat__value">{{ stats.totalTools }}</div>
        <div class="mcp-stat__label">生成工具数</div>
      </div>
      <div class="mcp-card mcp-stat">
        <div class="mcp-stat__value">{{ formatTime(stats.lastUpdated) }}</div>
        <div class="mcp-stat__label">最后更新</div>
      </div>
    </div>

    <!-- Config Table -->
    <div class="mcp-card api-to-mcp-page__table-card">
      <div v-if="loading" style="padding: var(--space-10) 0">
        <t-loading size="medium" text="加载配置列表..." />
      </div>

      <div v-else-if="configs.length === 0" class="mcp-empty">
        <SwapIcon class="mcp-empty__icon" />
        <p class="mcp-empty__title">暂无API配置</p>
        <p class="mcp-empty__desc">点击"添加API配置"按钮创建第一个API转MCP配置</p>
      </div>

      <t-table v-else :data="configs" :columns="tableColumns" row-key="id" hover stripe>
        <template #status="{ row }">
          <StatusTag :status="row.status" />
        </template>

        <template #method="{ row }">
          <t-tag variant="light" size="small">
            {{ row.api.method }}
          </t-tag>
        </template>

        <template #url="{ row }">
          <span class="api-to-mcp-page__url" :title="row.api.url">
            {{ row.api.url }}
          </span>
        </template>

        <template #toolsGenerated="{ row }">
          {{ row.toolsGenerated }}
        </template>

        <template #lastUpdated="{ row }">
          {{ formatTime(row.lastUpdated) }}
        </template>

        <template #actions="{ row }">
          <div class="api-to-mcp-page__actions">
            <t-button variant="text" size="small" @click="openTestDialog(row)"> 测试 </t-button>
            <t-button variant="text" size="small" @click="openEditDialog(row)"> 编辑 </t-button>
            <t-popconfirm content="确认删除此API配置？" @confirm="handleDelete(row.id)">
              <t-button variant="text" size="small" theme="danger"> 删除 </t-button>
            </t-popconfirm>
          </div>
        </template>
      </t-table>
    </div>

    <!-- Add/Edit Dialog -->
    <t-dialog
      v-model:visible="configDialogVisible"
      :header="isEditing ? '编辑API配置' : '添加API配置'"
      :confirm-btn="{ loading: dialogSaving }"
      @confirm="handleSaveConfig"
      @close="resetForm"
    >
      <t-form :data="formData" label-align="top">
        <t-form-item label="名称">
          <t-input v-model="formData.name" placeholder="API配置名称" />
        </t-form-item>
        <t-form-item label="描述">
          <t-textarea
            v-model="formData.description"
            placeholder="API配置描述"
            :autosize="{ minRows: 2, maxRows: 4 }"
          />
        </t-form-item>
        <t-form-item label="API URL">
          <t-input v-model="formData.url" placeholder="https://api.example.com/endpoint" />
        </t-form-item>
        <t-form-item label="请求方法">
          <t-select v-model="formData.method" :options="methodOptions" placeholder="选择请求方法" />
        </t-form-item>
        <t-form-item label="请求头 (JSON)">
          <t-textarea
            v-model="formData.headers"
            :autosize="{ minRows: 2, maxRows: 6 }"
            class="api-to-mcp-page__json-textarea"
            placeholder='{"Content-Type": "application/json"}'
          />
        </t-form-item>
        <t-form-item label="参数 Schema (JSON)">
          <t-textarea
            v-model="formData.parametersSchema"
            :autosize="{ minRows: 4, maxRows: 10 }"
            class="api-to-mcp-page__json-textarea"
            placeholder='{"type": "object", "properties": {}}'
          />
        </t-form-item>
      </t-form>
    </t-dialog>

    <!-- Test Dialog -->
    <t-dialog
      v-model:visible="testDialogVisible"
      :header="`测试API配置 - ${testTarget?.name ?? ''}`"
      :footer="false"
      width="640px"
    >
      <div class="api-to-mcp-page__test-section">
        <t-form label-align="top">
          <t-form-item label="测试参数 (JSON)">
            <t-textarea
              v-model="testParams"
              :autosize="{ minRows: 3, maxRows: 8 }"
              class="api-to-mcp-page__json-textarea"
              placeholder='{"key": "value"}'
            />
          </t-form-item>
        </t-form>

        <t-button
          theme="primary"
          :loading="testLoading"
          style="margin-bottom: var(--space-4)"
          @click="handleTestConfig"
        >
          执行测试
        </t-button>

        <div v-if="testResult" class="api-to-mcp-page__test-result">
          <div class="api-to-mcp-page__test-result-header">
            <span class="api-to-mcp-page__test-result-title">测试结果</span>
            <t-tag :theme="testResult.success ? 'success' : 'danger'" variant="light" size="small">
              {{ testResult.success ? '成功' : '失败' }}
            </t-tag>
            <t-tag v-if="testResult.executionTime" variant="light" size="small">
              {{ testResult.executionTime }}ms
            </t-tag>
          </div>
          <pre class="mcp-code">{{ formatJson(testResult.response ?? testResult.error) }}</pre>
        </div>
      </div>
    </t-dialog>
  </div>
</template>

<script setup lang="ts">
import { JsonSchemaSchema } from '@mcp-core/mcp-knot-share/config';
import { AddIcon, FileExportIcon, FileImportIcon, SwapIcon } from 'tdesign-icons-vue-next';
import {
  Button as TButton,
  Table as TTable,
  Tag as TTag,
  Loading as TLoading,
  Dialog as TDialog,
  Form as TForm,
  FormItem as TFormItem,
  Input as TInput,
  Textarea as TTextarea,
  Select as TSelect,
  Popconfirm as TPopconfirm,
  MessagePlugin,
} from 'tdesign-vue-next';
import { onMounted, reactive, ref } from 'vue';

import { StatusTag } from '@/components/common';
import { apiToMcpService } from '@/services/api-to-mcp';

import type { ApiConfigInfo, ApiToolConfig, TestApiConfigResponse } from '@/types/api-to-mcp';

// --- State ---
const loading = ref(false);
const configs = ref<ApiConfigInfo[]>([]);
const stats = ref<{
  totalConfigs: number;
  activeConfigs: number;
  totalTools: number;
  lastUpdated: string;
} | null>(null);

// Dialog state
const configDialogVisible = ref(false);
const dialogSaving = ref(false);
const isEditing = ref(false);
const editingId = ref('');
const originalConfig = ref<ApiToolConfig | null>(null);
let editRequest = 0;

const formData = reactive({
  name: '',
  description: '',
  url: '',
  method: 'GET',
  headers: '{}',
  parametersSchema: '{}',
});

// Test dialog state
const testDialogVisible = ref(false);
const testLoading = ref(false);
const testTarget = ref<ApiConfigInfo | null>(null);
const testParams = ref('{}');
const testResult = ref<TestApiConfigResponse | null>(null);

// --- Table columns ---
const tableColumns = [
  { colKey: 'name', title: '名称', width: 160 },
  { colKey: 'description', title: '描述', ellipsis: true },
  { colKey: 'status', title: '状态', width: 100 },
  { colKey: 'method', title: '方法', width: 80 },
  { colKey: 'url', title: 'URL', ellipsis: true },
  { colKey: 'toolsGenerated', title: '工具数', width: 80 },
  { colKey: 'lastUpdated', title: '最后更新', width: 180 },
  { colKey: 'actions', title: '操作', width: 180, fixed: 'right' as const },
];

const methodOptions = [
  { label: 'GET', value: 'GET' },
  { label: 'POST', value: 'POST' },
  { label: 'PUT', value: 'PUT' },
  { label: 'DELETE', value: 'DELETE' },
  { label: 'PATCH', value: 'PATCH' },
];

// --- Helpers ---
function formatTime(timestamp: string): string {
  if (!timestamp) return '-';
  try {
    return new Date(timestamp).toLocaleString('zh-CN');
  } catch {
    return timestamp;
  }
}

function formatJson(data: unknown): string {
  try {
    return JSON.stringify(data, null, 2);
  } catch {
    return String(data);
  }
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isStringMap(value: Record<string, unknown>): value is Record<string, string> {
  return Object.values(value).every((entry) => typeof entry === 'string');
}

function parseJsonSafe(text: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(text || '{}');
    if (!isJsonObject(value)) {
      MessagePlugin.error('JSON 必须是对象');
      return null;
    }
    return value;
  } catch {
    MessagePlugin.error('JSON 格式错误');
    return null;
  }
}

// --- Data Loading ---
async function fetchConfigs(): Promise<void> {
  loading.value = true;
  try {
    const response = await apiToMcpService.getConfigs();
    configs.value = response.configs;
  } catch (err) {
    const message = err instanceof Error ? err.message : '获取配置列表失败';
    MessagePlugin.error(message);
  } finally {
    loading.value = false;
  }
}

async function fetchStats(): Promise<void> {
  try {
    stats.value = await apiToMcpService.getConfigStats();
  } catch {
    // Stats are non-critical, fail silently
  }
}

// --- Dialog Actions ---
function resetForm(): void {
  editRequest++;
  originalConfig.value = null;
  formData.name = '';
  formData.description = '';
  formData.url = '';
  formData.method = 'GET';
  formData.headers = '{}';
  formData.parametersSchema = '{}';
  isEditing.value = false;
  editingId.value = '';
}

function openAddDialog(): void {
  resetForm();
  configDialogVisible.value = true;
}

async function openEditDialog(row: ApiConfigInfo): Promise<void> {
  resetForm();
  const request = editRequest;
  try {
    const config = await apiToMcpService.getConfigDetails(row.id);
    if (request !== editRequest) return;
    originalConfig.value = config;
    isEditing.value = true;
    editingId.value = config.id;
    formData.name = config.name;
    formData.description = config.description;
    formData.url = config.api.url;
    formData.method = config.api.method;
    formData.headers = JSON.stringify(config.api.headers || {}, null, 2);
    formData.parametersSchema = JSON.stringify(config.parameters, null, 2);
    configDialogVisible.value = true;
  } catch {
    if (request === editRequest) MessagePlugin.error('读取完整API配置失败，请重试');
  }
}

async function handleSaveConfig(): Promise<void> {
  const headers = parseJsonSafe(formData.headers);
  const parameters = parseJsonSafe(formData.parametersSchema);
  if (!headers || !parameters) return;
  if (!isStringMap(headers)) {
    MessagePlugin.error('请求头的值必须是字符串');
    return;
  }
  const parameterSchema = JsonSchemaSchema.safeParse({
    ...parameters,
    type: parameters.type ?? 'object',
    properties: parameters.properties ?? {},
  });
  if (!parameterSchema.success) {
    MessagePlugin.error('参数 Schema 无效，请检查 type 和 properties');
    return;
  }
  const required = parameters.required ?? [];
  if (!Array.isArray(required) || !required.every((name) => typeof name === 'string')) {
    MessagePlugin.error('参数 Schema 的 required 必须是字符串数组');
    return;
  }

  if (!formData.name.trim()) {
    MessagePlugin.warning('请输入配置名称');
    return;
  }
  if (!formData.url.trim()) {
    MessagePlugin.warning('请输入API URL');
    return;
  }

  dialogSaving.value = true;
  try {
    const configPayload: ApiToolConfig = {
      ...originalConfig.value,
      id: isEditing.value
        ? editingId.value
        : `api-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      name: formData.name,
      description: formData.description,
      api: {
        ...originalConfig.value?.api,
        url: formData.url,
        method: formData.method as 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH',
        headers,
      },
      parameters: {
        ...parameterSchema.data,
        required,
      },
      response: originalConfig.value?.response || {},
    };

    if (isEditing.value) {
      await apiToMcpService.updateConfig(editingId.value, configPayload);
      MessagePlugin.success('配置更新成功');
    } else {
      await apiToMcpService.createConfig(configPayload);
      MessagePlugin.success('配置创建成功');
    }

    configDialogVisible.value = false;
    await fetchConfigs();
    await fetchStats();
  } catch (err) {
    const message = err instanceof Error ? err.message : '保存配置失败';
    MessagePlugin.error(message);
  } finally {
    dialogSaving.value = false;
  }
}

async function handleDelete(id: string): Promise<void> {
  try {
    await apiToMcpService.deleteConfig(id);
    MessagePlugin.success('配置删除成功');
    await fetchConfigs();
    await fetchStats();
  } catch (err) {
    const message = err instanceof Error ? err.message : '删除配置失败';
    MessagePlugin.error(message);
  }
}

// --- Test Actions ---
function openTestDialog(row: ApiConfigInfo): void {
  testTarget.value = row;
  testParams.value = '{}';
  testResult.value = null;
  testDialogVisible.value = true;
}

async function handleTestConfig(): Promise<void> {
  if (!testTarget.value) return;

  const params = parseJsonSafe(testParams.value);
  if (!params) return;

  testLoading.value = true;
  testResult.value = null;

  try {
    const response = await apiToMcpService.testConfig(testTarget.value.id, params);
    testResult.value = response;
  } catch (err) {
    const message = err instanceof Error ? err.message : '测试失败';
    MessagePlugin.error(message);
    testResult.value = {
      success: false,
      error: message,
      executionTime: 0,
    };
  } finally {
    testLoading.value = false;
  }
}

// --- Import / Export ---
function handleExport(): void {
  MessagePlugin.info('导出功能开发中...');
}

function handleImport(): void {
  MessagePlugin.info('导入功能开发中...');
}

// --- Lifecycle ---
onMounted(async () => {
  await fetchConfigs();
  await fetchStats();
});
</script>

<style scoped>
.api-to-mcp-page__header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--space-4);
}

.api-to-mcp-page__header-content {
  flex: 1;
}

.api-to-mcp-page__stats {
  margin-top: var(--space-4);
}

.api-to-mcp-page__table-card {
  margin-top: var(--space-4);
  padding: var(--space-4);
}

.api-to-mcp-page__url {
  font-family: var(--font-mono);
  font-size: var(--text-sm);
  color: var(--text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.api-to-mcp-page__actions {
  display: flex;
  align-items: center;
  gap: var(--space-1);
}

.api-to-mcp-page__json-textarea :deep(textarea) {
  font-family: var(--font-mono) !important;
  font-size: var(--text-sm) !important;
}

/* Test section */
.api-to-mcp-page__test-section {
  padding: var(--space-2) 0;
}

.api-to-mcp-page__test-result {
  margin-top: var(--space-3);
}

.api-to-mcp-page__test-result-header {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin-bottom: var(--space-2);
}

.api-to-mcp-page__test-result-title {
  font-size: var(--text-sm);
  font-weight: var(--weight-semibold);
  color: var(--text-primary);
}

@media (max-width: 640px) {
  .api-to-mcp-page__header {
    flex-direction: column;
    gap: var(--space-3);
  }
}
</style>
