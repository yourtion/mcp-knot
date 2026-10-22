<template>
  <div class="mcp-page">
    <div class="mcp-page__header">
      <div class="test-header">
        <div>
          <t-button variant="text" size="small" @click="goBackToDetail">
            <template #icon><ChevronLeftIcon /></template>
            返回工具详情
          </t-button>
          <h2 class="mcp-page__title test-title">测试工具: {{ tool?.name || toolName }}</h2>
          <p class="mcp-page__desc">{{ tool?.description || '加载中...' }}</p>
        </div>
      </div>
    </div>

    <t-loading :loading="loading" />

    <template v-if="tool && !loading">
      <div class="mcp-grid mcp-grid--2">
        <!-- Dynamic Form -->
        <div class="mcp-card test-form-card">
          <h3 class="test-form-card__title">参数输入</h3>
          <ToolParameterEditor
            ref="parameterEditor"
            :key="editorKey"
            v-model="formData"
            :schema="tool.inputSchema"
            :disabled="testing"
            @change="testResponse = null"
          />

          <div class="test-form-card__actions">
            <t-button theme="primary" :loading="testing" @click="handleTest">
              <template #icon><CheckCircleIcon /></template>
              验证参数
            </t-button>
          </div>
        </div>

        <!-- Test Results -->
        <div class="test-result-card">
          <h3 class="test-result-card__title">验证结果</h3>
          <template v-if="testResponse">
            <div class="test-result-card__content">
              <!-- Validation Status -->
              <div class="test-result-status">
                <span
                  class="test-result-status__badge"
                  :class="
                    testResponse.validation.isValid
                      ? 'test-result-status__badge--valid'
                      : 'test-result-status__badge--invalid'
                  "
                >
                  {{ testResponse.validation.isValid ? '参数有效' : '参数无效' }}
                </span>
                <span
                  class="test-result-status__badge"
                  :class="
                    testResponse.canExecute
                      ? 'test-result-status__badge--valid'
                      : 'test-result-status__badge--invalid'
                  "
                >
                  {{ testResponse.canExecute ? '可执行' : '不可执行' }}
                </span>
              </div>

              <!-- Server Status -->
              <div class="test-result-meta">
                <span class="test-result-meta__label">服务器状态</span>
                <span>{{ testResponse.serverStatus }}</span>
              </div>
              <div class="test-result-meta">
                <span class="test-result-meta__label">服务器 ID</span>
                <span>{{ testResponse.serverId }}</span>
              </div>

              <!-- Errors -->
              <template v-if="testResponse.validation.errors.length > 0">
                <div class="test-result-errors">
                  <h4 class="test-result-errors__title">错误</h4>
                  <ul class="test-result-errors__list">
                    <li
                      v-for="(err, index) in testResponse.validation.errors"
                      :key="index"
                      class="test-result-errors__item test-result-errors__item--error"
                    >
                      {{ err }}
                    </li>
                  </ul>
                </div>
              </template>

              <!-- Warnings -->
              <template v-if="testResponse.validation.warnings.length > 0">
                <div class="test-result-errors">
                  <h4 class="test-result-errors__title">警告</h4>
                  <ul class="test-result-errors__list">
                    <li
                      v-for="(warn, index) in testResponse.validation.warnings"
                      :key="index"
                      class="test-result-errors__item test-result-errors__item--warning"
                    >
                      {{ warn }}
                    </li>
                  </ul>
                </div>
              </template>
            </div>
          </template>
          <template v-else>
            <div class="mcp-empty">
              <div class="mcp-empty__desc">点击 "验证参数" 查看验证结果</div>
            </div>
          </template>
        </div>
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { ChevronLeftIcon, CheckCircleIcon } from 'tdesign-icons-vue-next';
import { MessagePlugin } from 'tdesign-vue-next';
import { ref, watch } from 'vue';

import ToolParameterEditor from '@/components/tools/ToolParameterEditor.vue';
import { useToolForm } from '@/composables/useToolForm';

import type { ToolTestResponse } from '@/types/tool';

const {
  toolName,
  loading,
  tool,
  formData,
  parameterEditor,
  editorKey,
  buildArguments,
  goBackToDetail,
  toolStore,
} = useToolForm();

const testing = ref(false);
const testResponse = ref<ToolTestResponse | null>(null);

watch(editorKey, () => {
  testResponse.value = null;
  testing.value = false;
});

const handleTest = async () => {
  if (testing.value) return;
  const args = buildArguments();
  if (!args) return;
  const session = editorKey.value;
  testResponse.value = null;
  testing.value = true;
  try {
    const result = await toolStore.testTool(toolName.value, { arguments: args });
    if (session !== editorKey.value) return;
    testResponse.value = result;

    if (result.validation.isValid) {
      MessagePlugin.success('参数验证通过');
    } else {
      MessagePlugin.warning('参数验证未通过');
    }
  } catch {
    if (session !== editorKey.value) return;
    MessagePlugin.error('参数验证失败');
  } finally {
    if (session === editorKey.value) testing.value = false;
  }
};
</script>

<style scoped>
.test-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--space-4);
}

.test-title {
  margin-top: var(--space-2);
}

.test-form-card {
  padding: var(--space-5);
}

.test-form-card__title {
  font-size: var(--text-md);
  font-weight: var(--weight-semibold);
  color: var(--text-primary);
  margin-bottom: var(--space-4);
}

.test-form-card__actions {
  margin-top: var(--space-5);
  display: flex;
  gap: var(--space-3);
}

.test-result-card {
  padding: var(--space-5);
  background: var(--bg-primary);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-sm);
}

.test-result-card__title {
  font-size: var(--text-md);
  font-weight: var(--weight-semibold);
  color: var(--text-primary);
  margin-bottom: var(--space-4);
}

.test-result-card__content {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.test-result-status {
  display: flex;
  gap: var(--space-3);
  margin-bottom: var(--space-2);
}

.test-result-status__badge {
  font-size: var(--text-xs);
  font-weight: var(--weight-medium);
  padding: 4px 12px;
  border-radius: var(--radius-full);
}

.test-result-status__badge--valid {
  color: var(--success);
  background: var(--success-light);
}

.test-result-status__badge--invalid {
  color: var(--danger);
  background: var(--danger-light);
}

.test-result-meta {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: var(--space-2) 0;
  border-bottom: 1px solid var(--border-light);
  font-size: var(--text-sm);
}

.test-result-meta__label {
  color: var(--text-secondary);
}

.test-result-errors {
  margin-top: var(--space-2);
}

.test-result-errors__title {
  font-size: var(--text-sm);
  font-weight: var(--weight-semibold);
  margin-bottom: var(--space-2);
}

.test-result-errors__list {
  list-style: none;
  padding: 0;
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}

.test-result-errors__item {
  font-size: var(--text-sm);
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-sm);
}

.test-result-errors__item--error {
  color: var(--danger);
  background: var(--danger-light);
}

.test-result-errors__item--warning {
  color: var(--warning);
  background: var(--warning-light);
}
</style>
