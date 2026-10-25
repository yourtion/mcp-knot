<template>
  <div class="mcp-page debug-page">
    <!-- Page Header -->
    <div class="mcp-page__header">
      <div class="mcp-page__header-content">
        <h1 class="mcp-page__title">调试工具</h1>
        <p class="mcp-page__desc">MCP协议调试与诊断</p>
      </div>
    </div>

    <!-- Tabs -->
    <t-tabs v-model="activeTab" class="debug-page__tabs">
      <!-- Tab: Tool Debugger -->
      <t-tab-panel value="tool" label="工具调试器">
        <div class="mcp-card debug-page__panel">
          <div class="debug-page__controls">
            <t-input
              v-model="toolTest.toolName"
              placeholder="工具名称"
              clearable
              style="width: 240px"
            />
            <t-input
              v-model="toolTest.serverId"
              placeholder="服务器ID（可选）"
              clearable
              style="width: 200px"
            />
            <t-button
              variant="outline"
              :loading="schemaLoading"
              :disabled="!!selectedTool"
              @click="loadToolParameters"
            >
              加载参数
            </t-button>
            <t-button
              theme="primary"
              :loading="toolTest.loading"
              :disabled="!selectedTool || schemaLoading"
              @click="handleTestTool"
            >
              <template #icon><PlayIcon /></template>
              执行
            </t-button>
          </div>

          <div class="debug-page__field">
            <div v-if="schemaError" role="alert">
              <p>{{ schemaError }}</p>
              <t-button @click="loadToolParameters">重试</t-button>
            </div>
            <t-loading v-else-if="schemaLoading" text="加载参数定义…" />
            <ToolParameterEditor
              v-else-if="selectedTool"
              ref="parameterEditor"
              :key="parameterSession"
              v-model="toolArguments"
              :schema="selectedTool.inputSchema"
              :disabled="toolTest.loading"
              @change="toolTest.result = null"
            />
            <p v-else role="status">输入工具名称后加载参数；修改工具或服务器后请重新加载。</p>
          </div>

          <div v-if="toolTest.result !== null" class="debug-page__output">
            <div class="debug-page__output-header">
              <span class="debug-page__output-title">执行结果</span>
              <t-tag v-if="toolTest.executionTime > 0" variant="light" size="small">
                {{ toolTest.executionTime }}ms
              </t-tag>
            </div>
            <pre class="mcp-code">{{ formatJson(toolTest.result) }}</pre>
          </div>
        </div>
      </t-tab-panel>

      <!-- Tab: Error Analyzer -->
      <t-tab-panel value="errors" label="错误分析">
        <div class="mcp-card debug-page__panel">
          <div class="debug-page__controls">
            <t-button :loading="errorAnalysis.loading" @click="fetchErrorAnalysis">
              <template #icon><RefreshIcon /></template>
              刷新错误分析
            </t-button>
          </div>

          <div v-if="errorAnalysis.data" class="debug-page__error-section">
            <!-- Overview stats -->
            <div class="debug-page__error-stats">
              <div class="debug-page__stat-item">
                <span class="debug-page__stat-value">{{
                  errorAnalysis.data.analysis.totalErrors
                }}</span>
                <span class="debug-page__stat-label">总错误数</span>
              </div>
              <div class="debug-page__stat-item">
                <span class="debug-page__stat-value"
                  >{{ (errorAnalysis.data.analysis.errorRate * 100).toFixed(1) }}%</span
                >
                <span class="debug-page__stat-label">错误率</span>
              </div>
            </div>

            <!-- Most common errors -->
            <div v-if="commonErrors.length > 0" class="debug-page__field">
              <label class="debug-page__label">常见错误</label>
              <t-table
                :data="commonErrors"
                :columns="errorColumns"
                row-key="message"
                hover
                stripe
                size="small"
              />
            </div>

            <!-- Recent errors -->
            <div v-if="errorAnalysis.data.errors.length > 0" class="debug-page__field">
              <label class="debug-page__label">最近错误</label>
              <t-table
                :data="errorAnalysis.data.errors"
                :columns="recentErrorColumns"
                row-key="id"
                hover
                stripe
                size="small"
              >
                <template #timestamp="{ row }">
                  {{ formatTime(row.timestamp) }}
                </template>
                <template #content="{ row }">
                  <pre class="mcp-code debug-page__error-content">{{
                    formatJson(row.content)
                  }}</pre>
                </template>
              </t-table>
            </div>
          </div>

          <div v-else-if="!errorAnalysis.loading" class="mcp-empty">
            <BugIcon class="mcp-empty__icon" />
            <p class="mcp-empty__title">暂无错误数据</p>
            <p class="mcp-empty__desc">点击"刷新错误分析"获取最新数据</p>
          </div>
        </div>
      </t-tab-panel>

      <!-- Tab: Performance Analyzer -->
      <t-tab-panel value="performance" label="性能分析">
        <div class="mcp-card debug-page__panel">
          <div class="debug-page__controls">
            <t-button :loading="performance.loading" @click="fetchPerformanceStats">
              <template #icon><RefreshIcon /></template>
              刷新性能数据
            </t-button>
          </div>

          <div v-if="performance.data" class="debug-page__perf-section">
            <!-- Overview stats -->
            <div class="debug-page__perf-stats">
              <div class="debug-page__stat-card mcp-card">
                <span class="debug-page__stat-value">{{
                  performance.data.stats.totalRequests
                }}</span>
                <span class="debug-page__stat-label">总请求数</span>
              </div>
              <div class="debug-page__stat-card mcp-card">
                <span class="debug-page__stat-value"
                  >{{ performance.data.stats.averageResponseTime.toFixed(1) }}ms</span
                >
                <span class="debug-page__stat-label">平均响应时间</span>
              </div>
              <div class="debug-page__stat-card mcp-card">
                <span class="debug-page__stat-value"
                  >{{ (performance.data.stats.errorRate * 100).toFixed(1) }}%</span
                >
                <span class="debug-page__stat-label">错误率</span>
              </div>
            </div>

            <!-- Top tools -->
            <div v-if="performance.data.stats.topTools.length > 0" class="debug-page__field">
              <label class="debug-page__label">热门工具</label>
              <t-table
                :data="performance.data.stats.topTools"
                :columns="topToolColumns"
                row-key="name"
                hover
                stripe
                size="small"
              >
                <template #avgTime="{ row }"> {{ row.avgTime.toFixed(1) }}ms </template>
              </t-table>
            </div>
          </div>

          <div v-else-if="!performance.loading" class="mcp-empty">
            <ChartBarIcon class="mcp-empty__icon" />
            <p class="mcp-empty__title">暂无性能数据</p>
            <p class="mcp-empty__desc">点击"刷新性能数据"获取最新统计</p>
          </div>
        </div>
      </t-tab-panel>

      <!-- Tab: Message Monitor -->
      <t-tab-panel value="messages" label="消息监控">
        <div class="mcp-card debug-page__panel">
          <div class="debug-page__controls">
            <t-input
              v-model="messageMonitor.serverId"
              placeholder="服务器ID（可选）"
              clearable
              style="width: 200px"
            />
            <t-select
              v-model="messageMonitor.type"
              placeholder="消息类型"
              clearable
              style="width: 160px"
              :options="messageTypeOptions"
            />
            <t-button :loading="messageMonitor.loading" @click="fetchMessages">
              <template #icon><RefreshIcon /></template>
              获取消息
            </t-button>
            <t-button variant="outline" @click="clearMessages"> 清空 </t-button>
          </div>

          <div v-if="messageMonitor.messages.length > 0" class="debug-page__messages">
            <div
              v-for="msg in messageMonitor.messages"
              :key="msg.id"
              class="debug-page__message-item"
            >
              <div class="debug-page__message-meta">
                <t-tag variant="light" size="small" :theme="messageTypeTheme(msg.type)">
                  {{ msg.type }}
                </t-tag>
                <span class="debug-page__message-method">{{ msg.method }}</span>
                <span class="debug-page__message-server">{{ msg.serverId }}</span>
                <span class="debug-page__message-time">{{ formatTime(msg.timestamp) }}</span>
              </div>
              <pre class="mcp-code debug-page__message-content">{{ formatJson(msg.content) }}</pre>
            </div>
          </div>

          <div v-else-if="!messageMonitor.loading" class="mcp-empty">
            <ChatIcon class="mcp-empty__icon" />
            <p class="mcp-empty__title">暂无消息记录</p>
            <p class="mcp-empty__desc">点击"获取消息"加载MCP协议消息</p>
          </div>
        </div>
      </t-tab-panel>
    </t-tabs>
  </div>
</template>

<script setup lang="ts">
import { PlayIcon, RefreshIcon, BugIcon, ChartBarIcon, ChatIcon } from 'tdesign-icons-vue-next';
import {
  Tabs as TTabs,
  TabPanel as TTabPanel,
  Input as TInput,
  Loading as TLoading,
  Button as TButton,
  Table as TTable,
  Tag as TTag,
  Select as TSelect,
  MessagePlugin,
} from 'tdesign-vue-next';
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';

import ToolParameterEditor from '@/components/tools/ToolParameterEditor.vue';
import { testTool, getErrorAnalysis, getPerformanceStats, getMcpMessages } from '@/services/debug';
import { getTools } from '@/services/tool';
import { initialArguments } from '@/utils/tool-parameters';

import type {
  McpMessage,
  ToolTestResponse,
  DebugErrorAnalysisResponse,
  DebugPerformanceStatsResponse,
} from '@/types/debug';
import type { ToolInfo } from '@/types/tool';
import type { Arguments, ParameterEditorInstance } from '@/utils/tool-parameters';

const activeTab = ref('tool');

// --- Tool Debugger State ---
const toolTest = reactive({
  toolName: '',
  serverId: '',
  result: null as unknown,
  executionTime: 0,
  loading: false,
});

const selectedTool = ref<ToolInfo | null>(null);
const schemaLoading = ref(false);
const schemaError = ref('');
const toolArguments = ref<Arguments>({});
const parameterEditor = ref<ParameterEditorInstance>();
const parameterSession = ref(0);

function resetParameters() {
  parameterSession.value++;
  selectedTool.value = null;
  schemaLoading.value = false;
  schemaError.value = '';
  toolArguments.value = {};
  toolTest.result = null;
  toolTest.executionTime = 0;
  toolTest.loading = false;
}

watch([() => toolTest.toolName, () => toolTest.serverId], resetParameters, { flush: 'sync' });
onBeforeUnmount(resetParameters);

async function loadToolParameters() {
  if (schemaLoading.value || selectedTool.value) return;
  resetParameters();
  const name = toolTest.toolName.trim();
  const serverId = toolTest.serverId.trim();
  if (!name) {
    schemaError.value = '请输入工具名称。';
    return;
  }
  const session = parameterSession.value;
  schemaLoading.value = true;
  try {
    const response = await getTools({ groupId: 'default', serverId: serverId || undefined });
    if (session !== parameterSession.value) return;
    const tool = response.tools.find(
      (candidate) => candidate.name === name && (!serverId || candidate.serverId === serverId),
    );
    if (!tool) throw new Error('未找到匹配的工具，请检查工具名称、服务器和默认组配置。');
    const args = initialArguments(tool.inputSchema);
    selectedTool.value = tool;
    toolArguments.value = args;
  } catch (err) {
    if (session === parameterSession.value) {
      schemaError.value = err instanceof Error ? err.message : '加载参数定义失败，请重试。';
    }
  } finally {
    if (session === parameterSession.value) schemaLoading.value = false;
  }
}

// --- Error Analysis State ---
const errorAnalysis = reactive({
  data: null as DebugErrorAnalysisResponse | null,
  loading: false,
});

// --- Performance State ---
const performance = reactive({
  data: null as DebugPerformanceStatsResponse | null,
  loading: false,
});

// --- Message Monitor State ---
const messageMonitor = reactive({
  messages: [] as McpMessage[],
  serverId: '',
  type: undefined as 'request' | 'response' | 'notification' | undefined,
  loading: false,
});

// --- Computed ---
const commonErrors = computed(() => {
  if (!errorAnalysis.data) return [];
  return Object.entries(errorAnalysis.data.analysis.mostCommonErrors).map(([message, count]) => ({
    message,
    count,
  }));
});

const messageTypeOptions = [
  { label: '请求', value: 'request' },
  { label: '响应', value: 'response' },
  { label: '通知', value: 'notification' },
];

// --- Table Columns ---
const errorColumns = [
  { colKey: 'message', title: '错误信息', ellipsis: true },
  { colKey: 'count', title: '次数', width: 100 },
];

const recentErrorColumns = [
  { colKey: 'id', title: 'ID', width: 100, ellipsis: true },
  { colKey: 'serverId', title: '服务器', width: 140 },
  { colKey: 'method', title: '方法', width: 160 },
  { colKey: 'timestamp', title: '时间', width: 180 },
  { colKey: 'content', title: '内容' },
];

const topToolColumns = [
  { colKey: 'name', title: '工具名称', ellipsis: true },
  { colKey: 'calls', title: '调用次数', width: 120 },
  { colKey: 'avgTime', title: '平均时间', width: 120 },
];

// --- Helpers ---
function formatTime(timestamp: string): string {
  return new Date(timestamp).toLocaleString('zh-CN');
}

function formatJson(data: unknown): string {
  try {
    return JSON.stringify(data, null, 2);
  } catch {
    return String(data);
  }
}

function messageTypeTheme(type: string): 'primary' | 'success' | 'warning' {
  switch (type) {
    case 'request':
      return 'primary';
    case 'response':
      return 'success';
    case 'notification':
      return 'warning';
    default:
      return 'primary';
  }
}

// --- Actions ---
async function handleTestTool(): Promise<void> {
  if (toolTest.loading || schemaLoading.value || !selectedTool.value) return;
  const args = parameterEditor.value?.getArguments();
  if (!args) return;
  const session = parameterSession.value;
  const tool = selectedTool.value;

  toolTest.loading = true;
  toolTest.result = null;
  toolTest.executionTime = 0;

  try {
    const response: ToolTestResponse = await testTool({
      toolName: tool.name,
      serverId: tool.serverId,
      groupId: 'default',
      arguments: args,
    });
    if (session !== parameterSession.value) return;
    toolTest.result = response.result;
    toolTest.executionTime = response.executionTime;
    MessagePlugin.success('工具执行完成');
  } catch (err) {
    if (session !== parameterSession.value) return;
    const message = err instanceof Error ? err.message : '工具执行失败';
    MessagePlugin.error(message);
    toolTest.result = { error: message };
  } finally {
    if (session === parameterSession.value) toolTest.loading = false;
  }
}

async function fetchErrorAnalysis(): Promise<void> {
  errorAnalysis.loading = true;
  try {
    errorAnalysis.data = await getErrorAnalysis();
  } catch (err) {
    const message = err instanceof Error ? err.message : '获取错误分析失败';
    MessagePlugin.error(message);
  } finally {
    errorAnalysis.loading = false;
  }
}

async function fetchPerformanceStats(): Promise<void> {
  performance.loading = true;
  try {
    performance.data = await getPerformanceStats();
  } catch (err) {
    const message = err instanceof Error ? err.message : '获取性能数据失败';
    MessagePlugin.error(message);
  } finally {
    performance.loading = false;
  }
}

async function fetchMessages(): Promise<void> {
  messageMonitor.loading = true;
  try {
    const response = await getMcpMessages(
      100,
      messageMonitor.serverId || undefined,
      messageMonitor.type,
    );
    messageMonitor.messages = response.messages;
  } catch (err) {
    const message = err instanceof Error ? err.message : '获取消息失败';
    MessagePlugin.error(message);
  } finally {
    messageMonitor.loading = false;
  }
}

function clearMessages(): void {
  messageMonitor.messages = [];
}

// --- Lifecycle ---
onMounted(async () => {
  // Auto-load performance stats on mount
  await fetchPerformanceStats();
});
</script>

<style scoped>
.debug-page__tabs {
  margin-top: var(--space-4);
}

.debug-page__panel {
  padding: var(--space-5);
}

.debug-page__controls {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  margin-bottom: var(--space-4);
  flex-wrap: wrap;
}

.debug-page__field {
  margin-bottom: var(--space-4);
}

.debug-page__label {
  display: block;
  font-size: var(--text-sm);
  font-weight: var(--weight-medium);
  color: var(--text-secondary);
  margin-bottom: var(--space-2);
}

/* Output area */
.debug-page__output {
  margin-top: var(--space-4);
}

.debug-page__output-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: var(--space-2);
}

.debug-page__output-title {
  font-size: var(--text-sm);
  font-weight: var(--weight-semibold);
  color: var(--text-primary);
}

/* Error analysis */
.debug-page__error-stats {
  display: flex;
  gap: var(--space-6);
  margin-bottom: var(--space-5);
}

.debug-page__stat-item {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}

.debug-page__stat-value {
  font-size: var(--text-xl);
  font-weight: var(--weight-bold);
  color: var(--text-primary);
}

.debug-page__stat-label {
  font-size: var(--text-xs);
  color: var(--text-secondary);
}

.debug-page__error-content {
  max-height: 120px;
  overflow-y: auto;
  margin: 0;
}

/* Performance */
.debug-page__perf-stats {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: var(--space-4);
  margin-bottom: var(--space-5);
}

.debug-page__stat-card {
  padding: var(--space-5);
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

/* Messages */
.debug-page__messages {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.debug-page__message-item {
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  overflow: hidden;
}

.debug-page__message-meta {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
  background: var(--bg-secondary);
  border-bottom: 1px solid var(--border-light);
  font-size: var(--text-xs);
}

.debug-page__message-method {
  font-family: var(--font-mono);
  font-weight: var(--weight-medium);
  color: var(--text-primary);
}

.debug-page__message-server {
  color: var(--text-secondary);
}

.debug-page__message-time {
  color: var(--text-tertiary);
  margin-left: auto;
  font-family: var(--font-mono);
}

.debug-page__message-content {
  margin: 0;
  max-height: 200px;
  overflow-y: auto;
}

@media (max-width: 640px) {
  .debug-page__perf-stats {
    grid-template-columns: 1fr;
  }
}
</style>
