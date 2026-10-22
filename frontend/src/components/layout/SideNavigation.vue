<template>
  <div class="side-navigation">
    <div class="side-navigation__logo">
      <ViewModuleIcon class="side-navigation__logo-icon" />
      <transition name="fade">
        <span v-if="!collapsed" class="side-navigation__logo-text">MCP Knot</span>
      </transition>
    </div>
    <Menu :value="activeRoute" :collapsed="collapsed" theme="dark" @change="handleMenuChange">
      <MenuItem v-for="item in navItems" :key="item.path" :value="item.path">
        <template #icon>
          <component :is="item.icon" />
        </template>
        {{ item.label }}
      </MenuItem>
    </Menu>
  </div>
</template>

<script setup lang="ts">
import {
  ViewModuleIcon,
  ServerIcon,
  PreciseMonitorIcon,
  FolderIcon,
  BookOpenIcon,
  ApiIcon,
  BugIcon,
  SettingIcon,
} from 'tdesign-icons-vue-next';
import { Menu, MenuItem } from 'tdesign-vue-next';
import { computed, type Component } from 'vue';
import { useRoute, useRouter } from 'vue-router';

interface NavItem {
  path: string;
  label: string;
  icon: Component;
}

defineProps<{
  collapsed: boolean;
}>();

const route = useRoute();
const router = useRouter();

const navItems: NavItem[] = [
  { path: '/dashboard', label: '仪表板', icon: ViewModuleIcon },
  { path: '/servers', label: '服务器管理', icon: ServerIcon },
  { path: '/tools', label: '工具管理', icon: PreciseMonitorIcon },
  { path: '/skills', label: '技能管理', icon: BookOpenIcon },
  { path: '/groups', label: '组管理', icon: FolderIcon },
  { path: '/api-to-mcp', label: 'API到MCP管理', icon: ApiIcon },
  { path: '/debug', label: '调试工具', icon: BugIcon },
  { path: '/config', label: '系统配置', icon: SettingIcon },
];

const activeRoute = computed(() => {
  const matched = route.path;
  const exactMatch = navItems.find((item) => item.path === matched);
  if (exactMatch) {
    return exactMatch.path;
  }
  const prefixMatch = navItems.find((item) => matched.startsWith(item.path) && item.path !== '/');
  return prefixMatch?.path ?? '/dashboard';
});

const handleMenuChange = (value: string | number) => {
  router.push(value as string);
};
</script>

<style scoped>
.side-navigation {
  display: flex;
  flex-direction: column;
  height: 100%;
  background-color: var(--bg-primary);
  overflow-x: hidden;
  overflow-y: auto;
}

.side-navigation__logo {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  height: var(--header-height);
  padding: 0 var(--space-4);
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
}

.side-navigation__logo-icon {
  width: 24px;
  height: 24px;
  color: var(--accent);
  flex-shrink: 0;
}

.side-navigation__logo-text {
  font-size: var(--text-lg);
  font-weight: var(--weight-bold);
  color: var(--text-primary);
  white-space: nowrap;
  overflow: hidden;
}

.fade-enter-active,
.fade-leave-active {
  transition: opacity var(--transition-fast);
}

.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}
</style>
