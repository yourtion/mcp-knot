<template>
  <t-dialog
    :visible="visible"
    header="导入技能"
    width="640px"
    :confirm-on-enter="false"
    :confirm-btn="{ content: registered ? '重试导入' : '登记并导入', loading: saving }"
    :cancel-btn="{ disabled: saving }"
    :close-btn="!saving"
    :close-on-overlay-click="!saving"
    :close-on-esc-keydown="!saving"
    @confirm="submit"
    @close="close"
  >
    <t-alert v-if="error" theme="error" :message="error" class="import-alert" />
    <t-alert
      v-if="registered"
      theme="info"
      message="来源已登记。导入失败时可重试，也可关闭窗口后在来源列表中重新同步。"
      class="import-alert"
    />
    <t-form label-align="top">
      <t-form-item label="来源 ID">
        <t-input
          v-model="form.id"
          :disabled="saving || registered"
          placeholder="如 team-review，小写字母、数字、下划线或连字符"
        />
      </t-form-item>
      <t-form-item label="来源类型">
        <t-select v-model="form.type" :options="sourceTypes" :disabled="saving || registered" />
      </t-form-item>
      <template v-if="form.type === 'command'">
        <t-form-item label="skills CLI 命令">
          <t-textarea
            v-model="form.command"
            :disabled="saving || registered"
            placeholder="npx skills@latest add owner/repo --skill=review"
          />
        </t-form-item>
      </template>
      <template v-else>
        <t-form-item v-if="form.type === 'local'" label="服务器上的技能目录">
          <t-input
            v-model="form.directory"
            :disabled="saving || registered"
            placeholder="/srv/team-skills（Hub 服务器上的目录）"
          />
        </t-form-item>
        <t-form-item v-else label="公共仓库">
          <t-input
            v-model="form.repository"
            :disabled="saving || registered"
            :placeholder="form.type === 'git' ? 'https://github.com/owner/repo.git' : 'owner/repo'"
          />
        </t-form-item>
        <t-form-item v-if="form.type === 'git'" label="分支、标签或 Commit">
          <t-input v-model="form.ref" :disabled="saving || registered" placeholder="HEAD" />
        </t-form-item>
        <t-form-item v-if="form.type === 'skills-cli'" label="skills CLI 版本">
          <t-input
            v-model="form.cliVersion"
            :disabled="saving || registered"
            placeholder="latest"
          />
        </t-form-item>
        <t-form-item label="技能名称">
          <t-textarea
            v-model="form.skills"
            :disabled="saving || registered"
            placeholder="review-code, design-review（逗号或换行分隔）"
          />
        </t-form-item>
      </template>
    </t-form>
    <p class="import-help">导入会保存完整技能快照。完成后可选择版本发布到 Group。</p>
    <p v-if="saving" role="status" class="import-help">正在获取和校验技能，可能需要数分钟…</p>
  </t-dialog>
</template>

<script setup lang="ts">
import { SkillSourceSchema } from '@mcp-core/mcp-knot-share/config';
import {
  Alert as TAlert,
  Dialog as TDialog,
  Form as TForm,
  FormItem as TFormItem,
  Input as TInput,
  Select as TSelect,
  Textarea as TTextarea,
} from 'tdesign-vue-next';
import { reactive, ref, watch } from 'vue';

import { skillErrorMessage, skillService } from '@/services/skill';

import type { SkillSourceInput } from '@/types/skill';

const props = defineProps<{ visible: boolean }>();
const emit = defineEmits<{
  'update:visible': [visible: boolean];
  changed: [];
  imported: [sourceId: string];
}>();
const sourceTypes = [
  { value: 'git', label: '公共 Git 仓库' },
  { value: 'local', label: '服务器本地目录' },
  { value: 'skills-cli', label: 'skills CLI 仓库' },
  { value: 'command', label: 'skills CLI 命令' },
];
const initialForm = () => ({
  id: '',
  type: 'git',
  repository: '',
  directory: '',
  ref: 'HEAD',
  cliVersion: 'latest',
  skills: '',
  command: '',
});
const form = reactive(initialForm());
const saving = ref(false);
const registered = ref(false);
const error = ref('');

watch(
  () => props.visible,
  (visible) => {
    if (visible) {
      Object.assign(form, initialForm());
      registered.value = false;
      error.value = '';
    }
  },
);

function sourceInput(): SkillSourceInput {
  const id = form.id.trim();
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(id))
    throw new Error('来源 ID 需为 1–64 位小写字母、数字、下划线或连字符，并以字母或数字开头');
  if (form.type === 'command') {
    if (!form.command.trim()) throw new Error('请输入 skills CLI 命令');
    return { id, command: form.command.trim() };
  }
  const skills = form.skills
    .split(/[,，\n]+/)
    .map((name) => name.trim())
    .filter(Boolean);
  if (!skills.length) throw new Error('请至少填写一个技能名称');
  const common = { id, skills };
  const input =
    form.type === 'local'
      ? { ...common, type: 'local', directory: form.directory.trim() }
      : form.type === 'git'
        ? {
            ...common,
            type: 'git',
            repository: form.repository.trim(),
            ref: form.ref.trim() || 'HEAD',
          }
        : {
            ...common,
            type: 'skills-cli',
            repository: form.repository.trim(),
            cliVersion: form.cliVersion.trim() || 'latest',
          };
  const result = SkillSourceSchema.safeParse(input);
  if (!result.success)
    throw new Error(
      result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('；'),
    );
  return result.data;
}

async function submit() {
  if (saving.value) return;
  error.value = '';
  saving.value = true;
  try {
    const input = sourceInput();
    if (!registered.value) {
      await skillService.saveSource(input);
      registered.value = true;
      emit('changed');
    }
    await skillService.syncSource(input.id);
    emit('imported', input.id);
    emit('update:visible', false);
  } catch (cause) {
    error.value = skillErrorMessage(cause);
  } finally {
    saving.value = false;
  }
}

function close() {
  if (!saving.value) emit('update:visible', false);
}
</script>

<style scoped>
.import-alert {
  margin-bottom: var(--space-4);
}
.import-help {
  color: var(--text-secondary);
  margin-top: var(--space-3);
}
</style>
