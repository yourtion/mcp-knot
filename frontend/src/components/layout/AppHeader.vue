<template>
  <header class="app-header">
    <div class="app-header__left">
      <Button
        aria-label="切换导航栏"
        variant="text"
        shape="square"
        size="medium"
        @click="$emit('toggle-sidebar')"
      >
        <template #icon>
          <MenuUnfoldIcon v-if="collapsed" />
          <MenuFoldIcon v-else />
        </template>
      </Button>
      <Breadcrumb />
    </div>
    <div class="app-header__right">
      <div class="app-header__theme-btn">
        <Button
          aria-label="切换主题"
          variant="text"
          shape="square"
          size="medium"
          @click="toggleTheme"
        >
          <template #icon>
            <SunnyIcon v-if="isDark" />
            <MoonIcon v-else />
          </template>
        </Button>
      </div>
      <Dropdown :options="userDropdownOptions" @click="handleDropdownClick">
        <div class="app-header__user-btn">
          <Button variant="text" size="medium">
            <template #icon>
              <UserIcon />
            </template>
            <span v-if="authStore.user" class="app-header__username">
              {{ authStore.user.username }}
            </span>
          </Button>
        </div>
      </Dropdown>
    </div>
  </header>
</template>

<script setup lang="ts">
import {
  MenuFoldIcon,
  MenuUnfoldIcon,
  SunnyIcon,
  MoonIcon,
  UserIcon,
  PoweroffIcon,
} from 'tdesign-icons-vue-next';
import { Button, Dropdown } from 'tdesign-vue-next';
import { computed, h } from 'vue';

import Breadcrumb from './Breadcrumb.vue';
import { useTheme } from '@/composables/useTheme';
import { useAuthStore } from '@/stores/auth';

import type { DropdownOption } from 'tdesign-vue-next';

defineProps<{
  collapsed: boolean;
}>();

defineEmits<{
  (e: 'toggle-sidebar'): void;
}>();

const { toggleTheme, resolvedTheme } = useTheme();
const authStore = useAuthStore();

const isDark = computed(() => resolvedTheme() === 'dark');

const userDropdownOptions = computed<DropdownOption[]>(() => {
  const options: DropdownOption[] = [
    {
      content: '退出登录',
      value: 'logout',
      // TDesign DropdownOption.prefixIcon 期望 TNode（渲染函数/插槽），不能直接传组件对象，
      // 否则会被字符串化为 "[object Object]" 且影响菜单项交互。
      prefixIcon: () => h(PoweroffIcon),
    },
  ];
  return options;
});

const handleDropdownClick = (data: DropdownOption) => {
  if (data.value === 'logout') {
    authStore.logout();
  }
};
</script>

<style scoped>
.app-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  height: var(--header-height);
  padding: 0 var(--space-4);
  background-color: var(--bg-primary);
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
}

.app-header__left {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.app-header__right {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.app-header__theme-btn :deep(.t-button),
.app-header__user-btn :deep(.t-button) {
  color: var(--text-secondary);
  transition: color var(--transition-fast);
}

.app-header__theme-btn:hover :deep(.t-button),
.app-header__user-btn:hover :deep(.t-button) {
  color: var(--text-primary);
}

.app-header__username {
  margin-left: var(--space-1);
  font-size: var(--text-sm);
  color: var(--text-secondary);
}
</style>
