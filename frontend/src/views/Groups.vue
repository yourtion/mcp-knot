<template>
  <div class="mcp-page">
    <div
      class="mcp-page__header"
      style="display: flex; justify-content: space-between; align-items: flex-start"
    >
      <div>
        <h1 class="mcp-page__title">组管理</h1>
        <p class="mcp-page__desc">管理服务器组与访问控制</p>
      </div>
      <div class="mcp-page__actions">
        <t-button theme="primary" @click="showCreateDialog = true">
          <template #icon><AddIcon /></template>
          创建组
        </t-button>
        <t-button variant="outline" @click="groupStore.fetchGroups()" :loading="groupStore.loading">
          <template #icon><RefreshIcon /></template>
          刷新
        </t-button>
      </div>
    </div>

    <!-- Summary tags -->
    <div class="group-summary">
      <t-tag theme="primary" variant="light"> 总计 {{ groupStore.summary.totalGroups }} </t-tag>
      <t-tag theme="success" variant="light"> 健康 {{ groupStore.summary.healthyGroups }} </t-tag>
      <t-tag theme="danger" variant="light"> 异常 {{ groupStore.summary.unhealthyGroups }} </t-tag>
    </div>

    <GroupList
      :groups="groupStore.groupList"
      :loading="groupStore.loading"
      :can-manage-skills="authStore.user?.role === 'admin'"
      @edit="editGroup"
      @delete="handleDelete"
      @manage-tools="openToolManager"
      @manage-validation="openValidationManager"
      @manage-skills="openSkillManager"
    />

    <GroupFormDialog
      v-model:visible="showFormDialog"
      :mode="formMode"
      :group-data="editingGroup"
      @submit="handleSubmit"
    />

    <GroupMemberManager v-model:visible="showMemberManager" :group-id="activeGroupId" />

    <GroupValidationManager v-model:visible="showValidationManager" :group-id="activeGroupId" />
    <SkillPublishDialog
      v-if="showSkillManager"
      v-model:visible="showSkillManager"
      :group-id="activeGroupId"
      @saved="groupStore.fetchGroups()"
    />
  </div>
</template>

<script setup lang="ts">
import { AddIcon, RefreshIcon } from 'tdesign-icons-vue-next';
import { MessagePlugin } from 'tdesign-vue-next';
import { ref, onMounted, watch } from 'vue';

import {
  GroupList,
  GroupFormDialog,
  GroupMemberManager,
  GroupValidationManager,
} from '@/components/groups';
import SkillPublishDialog from '@/components/skills/SkillPublishDialog.vue';
import { useAuthStore } from '@/stores/auth';
import { useGroupStore } from '@/stores/group';
import { useServerStore } from '@/stores/server';
import { useToolStore } from '@/stores/tool';

import type { GroupInfo, CreateGroupRequest, UpdateGroupRequest } from '@/types/group';

const groupStore = useGroupStore();
const authStore = useAuthStore();
// 预加载服务器与工具列表：GroupFormDialog 的"服务器/工具"多选项依赖这两个 store。
const serverStore = useServerStore();
const toolStore = useToolStore();

// Dialog state
const showCreateDialog = ref(false);
const showFormDialog = ref(false);
const formMode = ref<'create' | 'edit'>('create');
const editingGroup = ref<GroupInfo | null>(null);
const activeGroupId = ref('');
const showMemberManager = ref(false);
const showValidationManager = ref(false);
const showSkillManager = ref(false);

function openSkillManager(groupId: string) {
  activeGroupId.value = groupId;
  showSkillManager.value = true;
}

function editGroup(group: GroupInfo) {
  editingGroup.value = group;
  formMode.value = 'edit';
  showFormDialog.value = true;
}

function openToolManager(groupId: string) {
  activeGroupId.value = groupId;
  showMemberManager.value = true;
}

function openValidationManager(groupId: string) {
  activeGroupId.value = groupId;
  showValidationManager.value = true;
}

async function handleSubmit(data: CreateGroupRequest | UpdateGroupRequest) {
  try {
    if (formMode.value === 'create') {
      const createData = data as CreateGroupRequest;
      await groupStore.createGroup(createData);
      MessagePlugin.success('组创建成功');
    } else if (editingGroup.value) {
      const updateData = data as UpdateGroupRequest;
      await groupStore.updateGroup(editingGroup.value.id, updateData);
      MessagePlugin.success('组更新成功');
    }
  } catch (err: unknown) {
    MessagePlugin.error(err instanceof Error ? err.message : '操作失败');
  }
}

async function handleDelete(id: string) {
  try {
    await groupStore.deleteGroup(id);
    MessagePlugin.success('组已删除');
  } catch (err: unknown) {
    MessagePlugin.error(err instanceof Error ? err.message : '删除失败');
  }
}

// Watch showCreateDialog to open the form dialog
watch(showCreateDialog, (val) => {
  if (val) {
    editingGroup.value = null;
    formMode.value = 'create';
    showFormDialog.value = true;
    showCreateDialog.value = false;
  }
});

onMounted(() => {
  groupStore.fetchGroups();
  // 为 GroupFormDialog 的选项提供数据（服务器/工具列表）
  serverStore.fetchServers();
  toolStore.fetchTools();
});
</script>

<style scoped>
.group-summary {
  display: flex;
  gap: 12px;
  margin-bottom: 20px;
  flex-wrap: wrap;
}
</style>
