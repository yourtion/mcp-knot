<script setup lang="ts">
import { computed, ref, toRaw, watch } from 'vue';
import { JsonEditor } from 'vue-json-ui-editor';

import { parameterWidgets } from './parameter-widgets';
import {
  cloneArguments,
  formSchema,
  parameterErrors,
  parameterSupport,
  parameterValidator,
} from '@/utils/tool-parameters';

import type { Arguments, ParameterEditorInstance } from '@/utils/tool-parameters';
import type { JsonSchema } from 'vue-json-ui-editor';

const props = defineProps<{ schema: JsonSchema; modelValue: Arguments; disabled?: boolean }>();
const emit = defineEmits<{ 'update:modelValue': [value: Arguments]; change: [] }>();
const draft = ref(cloneArguments(props.modelValue));
const raw = ref(JSON.stringify(draft.value, null, 2));
const preferJson = ref(false);
const errors = ref<string[]>([]);
const editorKey = ref(0);
const support = computed(() => parameterSupport(props.schema));
const validator = computed(() => parameterValidator(props.schema));
const useJson = computed(
  () => preferJson.value || !support.value.supported || !!validator.value.error,
);
const required = computed(() => props.schema.required || []);
const enabled = ref<string[]>([...new Set([...required.value, ...Object.keys(draft.value)])]);
const optional = computed(() =>
  Object.entries(props.schema.properties || {}).filter(([name]) => !required.value.includes(name)),
);
const renderedSchema = computed(() => ({
  ...formSchema(props.schema, [...new Set([...required.value, ...enabled.value])]),
  disabled: props.disabled,
}));
let lastEmitted: Arguments | undefined;

function notify() {
  errors.value = [];
  lastEmitted = cloneArguments(draft.value);
  emit('update:modelValue', lastEmitted);
  emit('change');
}

watch(
  () => props.modelValue,
  (value) => {
    if (toRaw(value) === lastEmitted) return;
    if (JSON.stringify(value) === JSON.stringify(draft.value)) return;
    draft.value = cloneArguments(value);
    enabled.value = [...new Set([...required.value, ...Object.keys(value)])];
    raw.value = JSON.stringify(value, null, 2);
    editorKey.value++;
    errors.value = [];
  },
  { deep: true },
);

function setOptional(name: string, event: Event) {
  if ((event.target as HTMLInputElement).checked) enabled.value.push(name);
  else {
    enabled.value = enabled.value.filter((key) => key !== name);
    delete draft.value[name];
  }
  notify();
}

function parseRaw(): Arguments | null {
  try {
    const value: unknown = JSON.parse(raw.value);
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      errors.value = ['参数必须是 JSON 对象。'];
      return null;
    }
    return value as Arguments;
  } catch {
    errors.value = ['JSON 格式有误，请检查引号、逗号和括号。'];
    return null;
  }
}

function toggleMode() {
  errors.value = [];
  if (!useJson.value) {
    raw.value = JSON.stringify(draft.value, null, 2);
    preferJson.value = true;
  } else {
    const value = parseRaw();
    if (!value) return;
    draft.value = value;
    enabled.value = [...new Set([...required.value, ...Object.keys(value)])];
    preferJson.value = false;
    editorKey.value++;
    notify();
  }
}

function getArguments(): Arguments | null {
  errors.value = [];
  if (!validator.value.validate) {
    errors.value = [validator.value.error || '参数定义无效。'];
    return null;
  }
  const args = useJson.value ? parseRaw() : cloneArguments(draft.value);
  if (!args) return null;
  if (!validator.value.validate(args)) {
    errors.value = parameterErrors(validator.value.validate.errors);
    return null;
  }
  return cloneArguments(args);
}

defineExpose<ParameterEditorInstance>({ getArguments });
</script>

<template>
  <div class="parameter-editor">
    <div class="parameter-editor__toolbar">
      <span>{{ useJson ? 'JSON 参数' : '表单参数' }}</span>
      <button
        v-if="support.supported && !validator.error"
        type="button"
        :disabled="disabled"
        @click="toggleMode"
      >
        {{ useJson ? '切换表单' : '编辑 JSON' }}
      </button>
    </div>
    <p v-if="!support.supported" class="parameter-editor__hint" role="status">
      此参数定义包含复杂类型，请使用 JSON 编辑。
    </p>
    <details v-if="!support.supported" class="parameter-editor__hint">
      <summary>查看涉及的参数</summary>
      <ul>
        <li v-for="issue in support.issues" :key="`${issue.path}:${issue.keyword}`">
          {{ issue.path }}（{{ issue.keyword }}）
        </li>
      </ul>
    </details>
    <p v-if="validator.error" role="alert">{{ validator.error }}</p>
    <fieldset :disabled="disabled" class="parameter-editor__body">
      <template v-if="!useJson">
        <div v-if="optional.length" class="parameter-editor__optional">
          <span>可选参数</span>
          <label v-for="[name, property] in optional" :key="name">
            <input
              type="checkbox"
              :checked="enabled.includes(name)"
              :aria-label="`启用 ${name}`"
              @change="setOptional(name, $event)"
            />
            {{ property.title || name }}
          </label>
        </div>
        <p class="parameter-editor__hint">JSON 模式可精确控制嵌套参数是否传入。</p>
        <JsonEditor
          :key="editorKey"
          v-model="draft"
          :schema="renderedSchema"
          :components="parameterWidgets"
          input-wrapping-class="parameter-editor__field"
          no-validate
          @update:model-value="notify"
        >
          <span />
        </JsonEditor>
      </template>
      <textarea
        v-else
        v-model="raw"
        aria-label="JSON 参数"
        rows="14"
        spellcheck="false"
        @input="
          errors = [];
          emit('change');
        "
      />
    </fieldset>
    <ul v-if="errors.length" role="alert" class="parameter-editor__errors">
      <li v-for="error in errors" :key="error">{{ error }}</li>
    </ul>
  </div>
</template>

<style scoped>
.parameter-editor {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}
.parameter-editor__toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.parameter-editor__body {
  min-width: 0;
  border: 0;
  padding: 0;
  margin: 0;
}
.parameter-editor__optional {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-3);
}
.parameter-editor__optional label {
  display: flex;
  align-items: center;
  gap: var(--space-1);
}
.parameter-editor__hint {
  color: var(--text-secondary);
  font-size: var(--text-sm);
  margin: var(--space-2) 0;
  overflow-wrap: anywhere;
}
.parameter-editor__errors,
[role='alert'] {
  color: var(--danger);
  overflow-wrap: anywhere;
}
textarea {
  width: 100%;
  box-sizing: border-box;
  padding: var(--space-3);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg-primary);
  color: var(--text-primary);
  font-family: monospace;
  resize: vertical;
}
button,
:deep(.json-editor-array button) {
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: var(--space-1) var(--space-3);
  color: var(--text-primary);
  background: var(--bg-primary);
  cursor: pointer;
}
:deep(.parameter-editor__field) {
  margin: var(--space-4) 0;
}
:deep(.parameter-editor__field > label) {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}
:deep([data-required-field='true']::after) {
  content: ' *';
  color: var(--danger);
}
:deep(small) {
  color: var(--text-secondary);
}
:deep(.sub),
:deep(.json-editor-array-row) {
  padding: var(--space-3);
  margin: var(--space-2) 0;
  border-left: 2px solid var(--border);
}
:deep(.sub-title),
:deep(.json-editor-array-title) {
  font-weight: var(--weight-semibold);
}
:deep(.json-editor-array-header) {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
</style>
