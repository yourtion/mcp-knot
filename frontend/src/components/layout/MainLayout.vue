<template>
  <div class="main-layout">
    <aside class="sidebar" :class="{ collapsed }">
      <SideNavigation :collapsed="collapsed" />
    </aside>
    <div class="main-content">
      <AppHeader :collapsed="collapsed" @toggle-sidebar="toggleSidebar" />
      <main class="page-content">
        <router-view v-slot="{ Component }">
          <transition name="page" mode="out-in">
            <component :is="Component" />
          </transition>
        </router-view>
      </main>
    </div>
  </div>
</template>

<script setup lang="ts">
import { useMediaQuery } from '@vueuse/core';
import { ref, watch } from 'vue';

import AppHeader from './AppHeader.vue';
import SideNavigation from './SideNavigation.vue';

const STORAGE_KEY = 'sidebar_collapsed';

const narrow = useMediaQuery('(max-width: 640px)');
const collapsed = ref(false);
watch(
  narrow,
  (isNarrow) => {
    collapsed.value = isNarrow || localStorage.getItem(STORAGE_KEY) === 'true';
  },
  { immediate: true },
);

const toggleSidebar = () => {
  collapsed.value = !collapsed.value;
  if (!narrow.value) localStorage.setItem(STORAGE_KEY, String(collapsed.value));
};
</script>

<style scoped>
.main-layout {
  display: flex;
  width: 100%;
  height: 100vh;
  overflow: hidden;
}

.sidebar {
  width: var(--sidebar-width);
  height: 100vh;
  flex-shrink: 0;
  border-right: 1px solid var(--border);
  transition: width var(--transition-slow);
  overflow: hidden;
}

.sidebar.collapsed {
  width: var(--sidebar-collapsed-width);
}

.main-content {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-width: 0;
  height: 100vh;
  background-color: var(--bg-canvas);
}

.page-content {
  flex: 1;
  overflow-y: auto;
  overflow-x: auto;
}

/* Page transition */
.page-enter-active {
  transition:
    opacity var(--transition-base),
    transform var(--transition-base);
}

.page-leave-active {
  transition:
    opacity var(--transition-fast),
    transform var(--transition-fast);
}

.page-enter-from {
  opacity: 0;
  transform: translateY(4px);
}

.page-leave-to {
  opacity: 0;
  transform: translateY(-4px);
}
</style>
