<template>
  <div class="mcp-page dashboard">
    <!-- Page Header -->
    <div class="mcp-page__header">
      <div class="mcp-page__header-content">
        <h1 class="mcp-page__title">仪表板</h1>
        <p class="mcp-page__desc">系统运行状态概览</p>
      </div>
      <div class="mcp-page__actions">
        <t-button variant="outline" :loading="isRefreshing" @click="handleRefresh">
          <template #icon>
            <RefreshIcon />
          </template>
          刷新
        </t-button>
      </div>
    </div>

    <!-- Stat Cards -->
    <div v-if="isLoading" class="mcp-grid mcp-grid--4">
      <div v-for="i in 4" :key="i" class="mcp-card mcp-stat stat-card stat-card--skeleton">
        <div class="skeleton skeleton--icon" />
        <div class="skeleton skeleton--value" />
        <div class="skeleton skeleton--label" />
      </div>
    </div>

    <div v-else class="mcp-grid mcp-grid--4">
      <div v-for="card in statCardConfigs" :key="card.label" class="mcp-card mcp-stat stat-card">
        <div class="stat-card__icon" :class="`stat-card__icon--${card.colorClass}`">
          <component :is="card.icon" />
        </div>
        <div class="mcp-stat__value">{{ card.value }}</div>
        <div class="mcp-stat__label">{{ card.label }}</div>
        <div
          v-if="card.trend"
          class="mcp-stat__trend"
          :class="`mcp-stat__trend--${card.trend.direction}`"
        >
          {{ card.trend.value.toFixed(1) }}% {{ card.trend.period }}
        </div>
      </div>
    </div>

    <!-- Two-column layout -->
    <div class="dashboard__panels">
      <!-- Left: Recent Activities -->
      <div class="mcp-card activities-panel">
        <div class="panel-header">
          <h2 class="panel-header__title">最近活动</h2>
          <t-tooltip content="通过 SSE 实时推送">
            <span class="panel-header__badge">
              <span class="mcp-status__dot" :class="sseDotClass" />
              {{ sseLabel }}
            </span>
          </t-tooltip>
        </div>

        <t-loading :loading="dashboardStore.loading.activities" />
        <div v-if="!dashboardStore.loading.activities">
          <div v-if="activities.length === 0" class="mcp-empty">
            <HelpCircleIcon class="mcp-empty__icon" />
            <p class="mcp-empty__title">暂无活动记录</p>
            <p class="mcp-empty__desc">系统活动将通过 SSE 实时推送到此处</p>
          </div>

          <div v-else class="activities-list">
            <div v-for="activity in activities" :key="activity.id" class="activity-item">
              <span
                class="activity-item__dot"
                :class="`activity-item__dot--${activity.severity}`"
              />
              <div class="activity-item__content">
                <span class="activity-item__message">{{ activity.message }}</span>
                <span class="activity-item__time">{{ formatTimestamp(activity.timestamp) }}</span>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- Right: System Health -->
      <div class="mcp-card health-panel">
        <div class="panel-header">
          <h2 class="panel-header__title">系统健康</h2>
          <t-tag v-if="healthStatus" :theme="healthTagTheme" variant="light" size="small">
            {{ healthStatusLabel }}
          </t-tag>
        </div>

        <t-loading :loading="dashboardStore.loading.health" />
        <div v-if="!dashboardStore.loading.health && healthStatus">
          <div class="health-checks">
            <div v-for="check in healthCheckItems" :key="check.key" class="health-check">
              <span class="health-check__dot" :class="`health-check__dot--${check.status}`" />
              <span class="health-check__name">{{ check.name }}</span>
              <span class="health-check__message">{{ check.message }}</span>
            </div>
          </div>

          <div class="health-footer">
            <div class="health-footer__item">
              <TimeIcon class="health-footer__icon" />
              <span>运行时间: {{ formatUptime(healthStatus.uptime) }}</span>
            </div>
            <div class="health-footer__item">
              <CheckCircleIcon class="health-footer__icon" />
              <span>上次检查: {{ formatTimestamp(healthStatus.lastCheck) }}</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import {
  RefreshIcon,
  ServerIcon,
  LinkIcon,
  PreciseMonitorIcon,
  FolderIcon,
  CheckCircleIcon,
  HelpCircleIcon,
  TimeIcon,
} from 'tdesign-icons-vue-next';
import {
  Button as TButton,
  Tag as TTag,
  Loading as TLoading,
  Tooltip as TTooltip,
} from 'tdesign-vue-next';
import { computed, onMounted, onUnmounted, ref } from 'vue';

import { useDashboardStore } from '@/stores/dashboard';

import type { Activity, SystemHealth } from '@/types/dashboard';
import type { Component } from 'vue';

interface StatCardConfig {
  label: string;
  value: string | number;
  icon: Component;
  colorClass: string;
  trend?: {
    value: number;
    direction: 'up' | 'down' | 'stable';
    period: string;
  };
}

const dashboardStore = useDashboardStore();

// --- Local reactive state ---
const isRefreshing = ref(false);
let refreshTimer: ReturnType<typeof setInterval> | null = null;

// --- Loading state ---
const isLoading = computed(() => dashboardStore.loading.stats);

// --- Stat card configurations ---
const statCardConfigs = computed<StatCardConfig[]>(() => {
  const stats = dashboardStore.stats;
  if (!stats) {
    return [
      { label: '服务器总数', value: '-', icon: ServerIcon, colorClass: 'blue' },
      { label: '已连接', value: '-', icon: LinkIcon, colorClass: 'green' },
      { label: '可用工具', value: '-', icon: PreciseMonitorIcon, colorClass: 'purple' },
      { label: '服务器组', value: '-', icon: FolderIcon, colorClass: 'orange' },
    ];
  }

  const totalServers = stats.overview.totalServers;
  const connectedServers = stats.overview.connectedServers;
  const connectionRate = totalServers > 0 ? (connectedServers / totalServers) * 100 : 0;

  return [
    {
      label: '服务器总数',
      value: totalServers,
      icon: ServerIcon,
      colorClass: 'blue',
    },
    {
      label: '已连接',
      value: connectedServers,
      icon: LinkIcon,
      colorClass: 'green',
      trend: {
        value: connectionRate,
        direction: connectionRate >= 80 ? 'up' : connectionRate >= 50 ? 'stable' : 'down',
        period: '连接率',
      },
    },
    {
      label: '可用工具',
      value: stats.overview.totalTools,
      icon: PreciseMonitorIcon,
      colorClass: 'purple',
    },
    {
      label: '服务器组',
      value: stats.overview.totalGroups,
      icon: FolderIcon,
      colorClass: 'orange',
    },
  ];
});

// --- Activities ---
const activities = computed<Activity[]>(() => dashboardStore.activities);

// --- SSE connection status ---
const sseDotClass = computed(() => {
  switch (dashboardStore.sseConnectionState) {
    case 'open':
      return 'sse-dot--connected';
    case 'connecting':
      return 'sse-dot--connecting';
    default:
      return 'sse-dot--closed';
  }
});

const sseLabel = computed(() => {
  switch (dashboardStore.sseConnectionState) {
    case 'open':
      return '已连接';
    case 'connecting':
      return '连接中...';
    default:
      return '未连接';
  }
});

// --- System Health ---
const healthStatus = computed<SystemHealth | null>(() => dashboardStore.systemHealth);

const healthTagTheme = computed(() => {
  const status = healthStatus.value?.status;
  if (status === 'healthy') return 'success';
  if (status === 'warning') return 'warning';
  return 'danger';
});

const healthStatusLabel = computed(() => {
  const status = healthStatus.value?.status;
  if (status === 'healthy') return '健康';
  if (status === 'warning') return '警告';
  return '异常';
});

const healthCheckItems = computed(() => {
  const checks = healthStatus.value?.checks;
  if (!checks) return [];

  return [
    {
      key: 'servers',
      name: '服务器',
      status: checks.servers.status,
      message: checks.servers.message,
    },
    {
      key: 'groups',
      name: '服务器组',
      status: checks.groups.status,
      message: checks.groups.message,
    },
    {
      key: 'apiTools',
      name: 'API 工具',
      status: checks.apiTools.status,
      message: checks.apiTools.message,
    },
    { key: 'memory', name: '内存', status: checks.memory.status, message: checks.memory.message },
  ];
});

// --- Helpers ---
function formatTimestamp(isoString: string): string {
  try {
    const date = new Date(isoString);
    return date.toLocaleTimeString('zh-CN', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  } catch {
    return isoString;
  }
}

function formatUptime(seconds: number): string {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);

  const parts: string[] = [];
  if (days > 0) parts.push(`${days}天`);
  if (hours > 0) parts.push(`${hours}小时`);
  parts.push(`${minutes}分钟`);

  return parts.join(' ');
}

// --- Actions ---
async function handleRefresh(): Promise<void> {
  isRefreshing.value = true;
  try {
    await dashboardStore.refreshAll();
  } finally {
    isRefreshing.value = false;
  }
}

// --- Lifecycle ---
onMounted(async () => {
  await dashboardStore.initializeDashboard();
  await dashboardStore.connectSSE();

  // Auto-refresh every 30 seconds
  refreshTimer = setInterval(() => {
    dashboardStore.refreshAll();
  }, 30_000);
});

onUnmounted(() => {
  if (refreshTimer !== null) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
  dashboardStore.cleanup();
});
</script>

<style scoped>
/* Page layout */
.dashboard {
  animation: fadeIn var(--transition-slow);
}

.mcp-page__header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--space-4);
}

.mcp-page__header-content {
  flex: 1;
}

/* Stat cards */
.stat-card {
  position: relative;
  transition:
    box-shadow var(--transition-base),
    transform var(--transition-base);
}

.stat-card:hover {
  transform: translateY(-2px);
  box-shadow: var(--shadow-lg);
}

.stat-card__icon {
  width: 40px;
  height: 40px;
  border-radius: var(--radius-md);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 20px;
  margin-bottom: var(--space-3);
}

.stat-card__icon--blue {
  background: var(--info-light);
  color: var(--info);
}

.stat-card__icon--green {
  background: var(--success-light);
  color: var(--success);
}

.stat-card__icon--purple {
  background: var(--accent-light);
  color: var(--accent);
}

.stat-card__icon--orange {
  background: var(--warning-light);
  color: var(--warning);
}

/* Skeleton loading */
.stat-card--skeleton {
  pointer-events: none;
}

.skeleton {
  background: var(--bg-tertiary);
  border-radius: var(--radius-sm);
  animation: skeleton-pulse 1.5s ease-in-out infinite;
}

.skeleton--icon {
  width: 40px;
  height: 40px;
  border-radius: var(--radius-md);
}

.skeleton--value {
  width: 60%;
  height: 28px;
  margin-top: var(--space-3);
}

.skeleton--label {
  width: 80%;
  height: 14px;
  margin-top: var(--space-2);
}

@keyframes skeleton-pulse {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.4;
  }
}

/* Two-column layout */
.dashboard__panels {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: var(--space-4);
  margin-top: var(--space-4);
}

@media (max-width: 1024px) {
  .dashboard__panels {
    grid-template-columns: 1fr;
  }
}

/* Panel shared styles */
.panel-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: var(--space-4) var(--space-5);
  border-bottom: 1px solid var(--border);
}

.panel-header__title {
  font-size: var(--text-md);
  font-weight: var(--weight-semibold);
  color: var(--text-primary);
  margin: 0;
}

.panel-header__badge {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  font-size: var(--text-xs);
  color: var(--text-secondary);
  font-weight: var(--weight-medium);
}

/* SSE dot states */
.sse-dot--connected {
  background: var(--success);
  box-shadow: 0 0 0 3px var(--success-light);
  animation: pulse-dot 2s ease-in-out infinite;
}

.sse-dot--connecting {
  background: var(--warning);
  box-shadow: 0 0 0 3px var(--warning-light);
  animation: pulse-dot 1s ease-in-out infinite;
}

.sse-dot--closed {
  background: var(--text-tertiary);
}

/* Activities panel */
.activities-panel {
  min-height: 300px;
}

.activities-list {
  max-height: 400px;
  overflow-y: auto;
  padding: var(--space-2) 0;
}

.activity-item {
  display: flex;
  align-items: flex-start;
  gap: var(--space-3);
  padding: var(--space-3) var(--space-5);
  border-bottom: 1px solid var(--border-light);
  transition: background-color var(--transition-fast);
}

.activity-item:last-child {
  border-bottom: none;
}

.activity-item:hover {
  background-color: var(--bg-secondary);
}

.activity-item__dot {
  width: 8px;
  height: 8px;
  border-radius: var(--radius-full);
  flex-shrink: 0;
  margin-top: 6px;
}

.activity-item__dot--info {
  background: var(--info);
  box-shadow: 0 0 0 3px var(--info-light);
}

.activity-item__dot--warning {
  background: var(--warning);
  box-shadow: 0 0 0 3px var(--warning-light);
}

.activity-item__dot--error {
  background: var(--danger);
  box-shadow: 0 0 0 3px var(--danger-light);
}

.activity-item__content {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  min-width: 0;
  flex: 1;
}

.activity-item__message {
  font-size: var(--text-sm);
  color: var(--text-primary);
  line-height: var(--leading-normal);
  word-break: break-word;
}

.activity-item__time {
  font-size: var(--text-xs);
  color: var(--text-tertiary);
  font-family: var(--font-mono);
}

/* Health panel */
.health-panel {
  min-height: 300px;
}

.health-checks {
  padding: var(--space-4) var(--space-5);
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.health-check {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  font-size: var(--text-sm);
}

.health-check__dot {
  width: 8px;
  height: 8px;
  border-radius: var(--radius-full);
  flex-shrink: 0;
}

.health-check__dot--healthy {
  background: var(--success);
  box-shadow: 0 0 0 3px var(--success-light);
}

.health-check__dot--warning {
  background: var(--warning);
  box-shadow: 0 0 0 3px var(--warning-light);
}

.health-check__dot--error {
  background: var(--danger);
  box-shadow: 0 0 0 3px var(--danger-light);
}

.health-check__name {
  font-weight: var(--weight-medium);
  color: var(--text-primary);
  min-width: 64px;
}

.health-check__message {
  color: var(--text-secondary);
  flex: 1;
}

.health-footer {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding: var(--space-4) var(--space-5);
  border-top: 1px solid var(--border-light);
  font-size: var(--text-sm);
  color: var(--text-secondary);
}

.health-footer__item {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.health-footer__icon {
  font-size: 16px;
  color: var(--text-tertiary);
}

/* Empty state adjustments */
.activities-panel .mcp-empty {
  padding: var(--space-8) var(--space-6);
}

.activities-panel .mcp-empty__icon {
  font-size: 36px;
}

/* Responsive: single column on mobile */
@media (max-width: 640px) {
  .mcp-page__header {
    flex-direction: column;
    gap: var(--space-3);
  }

  .dashboard__panels {
    grid-template-columns: 1fr;
  }
}
</style>
