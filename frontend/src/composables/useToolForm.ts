import { MessagePlugin } from 'tdesign-vue-next';
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';

import { useToolStore } from '@/stores/tool';
import { initialArguments } from '@/utils/tool-parameters';

import type { ToolInfo } from '@/types/tool';
import type { Arguments, ParameterEditorInstance } from '@/utils/tool-parameters';

export function useToolForm() {
  const route = useRoute();
  const router = useRouter();
  const toolStore = useToolStore();
  const toolName = computed(() => route.params.toolName as string);
  const loading = ref(false);
  const error = ref('');
  const tool = ref<ToolInfo | null>(null);
  const formData = ref<Arguments>({});
  const parameterEditor = ref<ParameterEditorInstance>();
  const editorKey = ref(0);
  let requestId = 0;

  const initFormDataDefaults = () => {
    formData.value = tool.value ? initialArguments(tool.value.inputSchema) : {};
    editorKey.value++;
  };

  const fetchTool = async () => {
    const id = ++requestId;
    loading.value = true;
    error.value = '';
    tool.value = null;
    editorKey.value++;
    try {
      const fetched = await toolStore.fetchToolDetail(toolName.value);
      if (id !== requestId) return;
      tool.value = fetched;
      initFormDataDefaults();
    } catch {
      if (id === requestId) {
        error.value = '无法加载工具详情，请确认工具存在且服务器可用后重试。';
        MessagePlugin.error('获取工具详情失败');
      }
    } finally {
      if (id === requestId) loading.value = false;
    }
  };

  watch(toolName, fetchTool, { immediate: true });
  onBeforeUnmount(() => {
    requestId++;
  });

  return {
    toolName,
    loading,
    error,
    retry: fetchTool,
    tool,
    formData,
    parameterEditor,
    editorKey,
    toolStore,
    buildArguments: () => parameterEditor.value?.getArguments() ?? null,
    initFormDataDefaults,
    goBackToDetail: () => router.push({ name: 'ToolDetail', params: { toolName: toolName.value } }),
  };
}
