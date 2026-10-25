<template>
  <t-dialog
    :visible="visible"
    :header="dialogTitle"
    :width="560"
    placement="center"
    :confirm-on-enter="false"
    @close="handleClose"
    @confirm="handleConfirm"
  >
    <t-form ref="formRef" :data="formData" :rules="formRules" label-align="top" :label-width="0">
      <t-form-item label="组 ID" name="id">
        <t-input v-model="formData.id" placeholder="输入唯一组标识符" :disabled="mode === 'edit'" />
      </t-form-item>

      <t-form-item label="名称" name="name">
        <t-input v-model="formData.name" placeholder="输入组名称" />
      </t-form-item>

      <t-form-item label="描述" name="description">
        <t-textarea
          v-model="formData.description"
          placeholder="输入组描述（可选）"
          :autosize="{ minRows: 2, maxRows: 5 }"
        />
      </t-form-item>

      <t-form-item label="服务器" name="servers">
        <t-select
          v-model="formData.servers"
          :options="serverOptions"
          placeholder="选择关联的服务器"
          multiple
          clearable
          filterable
        />
      </t-form-item>

      <t-form-item label="工具" name="tools">
        <t-select
          v-model="formData.tools"
          :options="toolOptions"
          placeholder="选择允许的工具（可选，为空表示全部）"
          multiple
          clearable
          filterable
        />
      </t-form-item>
    </t-form>
  </t-dialog>
</template>

<script setup lang="ts">
import { MessagePlugin } from 'tdesign-vue-next';
import { ref, reactive, watch, computed } from 'vue';

import { useServerStore } from '@/stores/server';
import { useToolStore } from '@/stores/tool';

import type { GroupInfo, CreateGroupRequest, UpdateGroupRequest } from '@/types/group';
import type { FormInstanceFunctions, FormRule } from 'tdesign-vue-next';

const props = defineProps<{
  visible: boolean;
  mode: 'create' | 'edit';
  groupData: GroupInfo | null;
}>();

const emit = defineEmits<{
  'update:visible': [value: boolean];
  submit: [data: CreateGroupRequest | UpdateGroupRequest];
}>();

const serverStore = useServerStore();
const toolStore = useToolStore();
const formRef = ref<FormInstanceFunctions | null>(null);

const dialogTitle = computed(() => (props.mode === 'create' ? '创建组' : '编辑组'));

interface FormState {
  id: string;
  name: string;
  description: string;
  servers: string[];
  tools: string[];
}

const formData = reactive<FormState>({
  id: '',
  name: '',
  description: '',
  servers: [],
  tools: [],
});

const formRules: Record<string, FormRule[]> = {
  id: [{ required: true, message: '请输入组 ID', trigger: 'blur' }],
  name: [{ required: true, message: '请输入组名称', trigger: 'blur' }],
};

// Available server options from server store
const serverOptions = computed(() =>
  serverStore.serverList.map((s) => ({
    label: s.name,
    value: s.id,
  })),
);

// 可选工具列表：从 toolStore 拉取所有已发现工具（按工具名去重）。
// 不再从 groupList.tools 聚合——该字段语义是"工具白名单"（空表示全部允许），
// 用它构建选项会永远为空。
const toolOptions = computed(() => {
  const toolNames = new Set<string>();
  toolStore.toolList.forEach((t) => {
    toolNames.add(t.name);
  });
  return Array.from(toolNames).map((name) => ({
    label: name,
    value: name,
  }));
});

// Watch for visibility to populate or reset form
watch(
  () => props.visible,
  (isVisible) => {
    if (isVisible && props.mode === 'edit' && props.groupData) {
      formData.id = props.groupData.id;
      formData.name = props.groupData.name;
      formData.description = props.groupData.description ?? '';
      formData.servers = Array.isArray(props.groupData.servers) ? [...props.groupData.servers] : [];
      formData.tools = Array.isArray(props.groupData.tools) ? [...props.groupData.tools] : [];
    } else if (isVisible && props.mode === 'create') {
      resetForm();
    }
  },
);

function resetForm() {
  formData.id = '';
  formData.name = '';
  formData.description = '';
  formData.servers = [];
  formData.tools = [];
}

async function handleConfirm() {
  const validateResult = await formRef.value?.validate();
  if (validateResult !== true) return;
  if (!formData.servers.length && !props.groupData?.skills?.include.length) {
    MessagePlugin.warning('组至少需要选择一个服务器或保留已发布技能');
    return;
  }

  if (props.mode === 'create') {
    const data: CreateGroupRequest = {
      id: formData.id,
      name: formData.name,
      description: formData.description || undefined,
      servers: formData.servers,
      tools: formData.tools,
    };
    emit('submit', data);
  } else {
    const data: UpdateGroupRequest = {
      name: formData.name,
      description: formData.description || undefined,
      servers: formData.servers,
      tools: formData.tools,
    };
    emit('submit', data);
  }

  emit('update:visible', false);
}

function handleClose() {
  emit('update:visible', false);
}
</script>

<style scoped>
/* Dialog form styling handled by TDesign defaults and CSS variables */
</style>
