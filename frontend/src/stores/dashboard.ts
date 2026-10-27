// 仪表板状态管理

import { defineStore } from 'pinia';
import { computed, ref } from 'vue';

import { dashboardService } from '@/services/dashboard';
import { type SSEEventType, sseService } from '@/services/sse';

import type {
  Activity,
  DashboardStats,
  LogEntry,
  LogQuery,
  PerformanceStats,
  SSEConnectionStats,
  StatCardData,
  SystemHealth,
  SystemInfo,
} from '@/types/dashboard';

export const useDashboardStore = defineStore('dashboard', () => {
  // 状态
  const stats = ref<DashboardStats | null>(null);
  const systemHealth = ref<SystemHealth | null>(null);
  const performanceStats = ref<PerformanceStats | null>(null);
  const systemInfo = ref<SystemInfo | null>(null);
  const sseStats = ref<SSEConnectionStats | null>(null);
  const logs = ref<LogEntry[]>([]);
  const activities = ref<Activity[]>([]);

  // 加载状态
  const loading = ref({
    stats: false,
    health: false,
    performance: false,
    logs: false,
    activities: false,
    systemInfo: false,
  });

  // 错误状态
  const error = ref<string | null>(null);

  // SSE连接状态
  const sseConnected = ref(false);
  const sseConnectionState = ref<'connecting' | 'open' | 'closed'>('closed');

  // 实时数据更新标志
  const lastUpdated = ref<Record<string, string>>({});

  // 计算属性
  const isHealthy = computed(() => {
    return systemHealth.value?.status === 'healthy';
  });

  const hasWarnings = computed(() => {
    return systemHealth.value?.status === 'warning';
  });

  const hasErrors = computed(() => {
    return systemHealth.value?.status === 'error';
  });

  const recentErrorCount = computed(() => {
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    return activities.value.filter(
      (activity) => activity.severity === 'error' && activity.timestamp > oneHourAgo,
    ).length;
  });

  const serverConnectionRate = computed(() => {
    if (!stats.value) return 0;
    const { totalServers, connectedServers } = stats.value.overview;
    return totalServers > 0 ? (connectedServers / totalServers) * 100 : 0;
  });

  // 统计卡片数据
  const statCards = computed((): StatCardData[] => {
    if (!stats.value) return [];

    return [
      {
        value: stats.value.overview.totalServers,
        label: '总服务器数',
        icon: 'server',
        color: 'blue',
      },
      {
        value: stats.value.overview.connectedServers,
        label: '已连接服务器',
        icon: 'link',
        color: 'green',
        trend: {
          value: serverConnectionRate.value,
          direction:
            serverConnectionRate.value >= 80
              ? 'up'
              : serverConnectionRate.value >= 50
                ? 'stable'
                : 'down',
          period: '连接率',
        },
      },
      {
        value: stats.value.overview.totalTools,
        label: '可用工具数',
        icon: 'tool',
        color: 'purple',
      },
      {
        value: stats.value.overview.totalGroups,
        label: '服务器组数',
        icon: 'folder',
        color: 'orange',
      },
    ];
  });

  // 方法
  const fetchDashboardStats = async () => {
    loading.value.stats = true;
    error.value = null;

    try {
      stats.value = await dashboardService.getDashboardStats();
      lastUpdated.value.stats = new Date().toISOString();
    } catch (err) {
      error.value = err instanceof Error ? err.message : '获取仪表板统计失败';
      console.error('获取仪表板统计失败:', err);
    } finally {
      loading.value.stats = false;
    }
  };

  const fetchSystemHealth = async () => {
    loading.value.health = true;

    try {
      systemHealth.value = await dashboardService.getSystemHealth();
      lastUpdated.value.health = new Date().toISOString();
    } catch (err) {
      console.error('获取系统健康状态失败:', err);
    } finally {
      loading.value.health = false;
    }
  };

  const fetchPerformanceStats = async () => {
    loading.value.performance = true;

    try {
      performanceStats.value = await dashboardService.getPerformanceStats();
      lastUpdated.value.performance = new Date().toISOString();
    } catch (err) {
      console.error('获取性能统计失败:', err);
    } finally {
      loading.value.performance = false;
    }
  };

  const fetchSystemInfo = async () => {
    loading.value.systemInfo = true;

    try {
      systemInfo.value = await dashboardService.getSystemInfo();
      lastUpdated.value.systemInfo = new Date().toISOString();
    } catch (err) {
      console.error('获取系统信息失败:', err);
    } finally {
      loading.value.systemInfo = false;
    }
  };

  const fetchLogs = async (query: LogQuery = {}) => {
    loading.value.logs = true;

    try {
      const result = await dashboardService.queryLogs(query);
      logs.value = result.logs;
      lastUpdated.value.logs = new Date().toISOString();
    } catch (err) {
      console.error('获取日志失败:', err);
    } finally {
      loading.value.logs = false;
    }
  };

  const fetchActivities = async (limit = 50) => {
    loading.value.activities = true;

    try {
      const result = await dashboardService.getRecentActivities(limit);
      activities.value = result.activities;
      lastUpdated.value.activities = new Date().toISOString();
    } catch (err) {
      console.error('获取活动记录失败:', err);
    } finally {
      loading.value.activities = false;
    }
  };

  const fetchSSEStats = async () => {
    try {
      sseStats.value = await dashboardService.getSSEStats();
    } catch (err) {
      console.error('获取SSE统计失败:', err);
    }
  };

  // SSE连接管理
  let stopSSEState = () => {};
  const connectSSE = async (subscriptions: SSEEventType[] = []) => {
    stopSSEState();
    stopSSEState =
      sseService.onConnectionState?.((state) => {
        sseConnectionState.value = state;
        sseConnected.value = state === 'open';
      }) || (() => {});
    try {
      sseConnectionState.value = 'connecting';
      await sseService.connect(subscriptions);
      sseConnected.value = true;
      sseConnectionState.value = 'open';

      // 设置事件监听器
      setupSSEEventListeners();
    } catch (err) {
      sseConnected.value = false;
      sseConnectionState.value = 'closed';
      console.error('SSE连接失败:', err);
    }
  };

  const disconnectSSE = () => {
    stopSSEState();
    sseService.disconnect();
    sseConnected.value = false;
    sseConnectionState.value = 'closed';
  };

  // 设置SSE事件监听器
  const setupSSEEventListeners = () => {
    // 先清除旧监听器，防止重复注册
    sseService.removeAllEventListeners();
    // 服务器状态变更
    sseService.onServerStatus((data) => {
      console.log('收到服务器状态事件:', data);
      // 更新统计数据
      fetchDashboardStats();

      // 添加活动记录
      const activity: Activity = {
        id: `server_${data.serverId}_${Date.now()}`,
        type: data.status === 'connected' ? 'server_connected' : 'server_disconnected',
        message: `服务器 ${data.serverId} ${data.status === 'connected' ? '已连接' : '已断开'}`,
        timestamp: new Date().toISOString(),
        severity: data.status === 'error' ? 'error' : 'info',
        metadata: { serverId: data.serverId, status: data.status },
      };

      activities.value.unshift(activity);
      if (activities.value.length > 100) {
        activities.value = activities.value.slice(0, 100);
      }
    });

    // 工具执行事件
    sseService.onToolExecution((data) => {
      console.log('收到工具执行事件:', data);

      // 更新性能统计
      fetchPerformanceStats();

      // 添加活动记录
      const activity: Activity = {
        id: `tool_${data.toolName}_${Date.now()}`,
        type: 'tool_executed',
        message: `工具 ${data.toolName} ${data.success ? '执行成功' : '执行失败'}`,
        timestamp: new Date().toISOString(),
        severity: data.success ? 'info' : 'error',
        metadata: {
          toolName: data.toolName,
          serverId: data.serverId,
          executionTime: data.executionTime,
          success: data.success,
        },
      };

      activities.value.unshift(activity);
      if (activities.value.length > 100) {
        activities.value = activities.value.slice(0, 100);
      }
    });

    // 系统告警事件
    sseService.onSystemAlert((data) => {
      console.log('收到系统告警事件:', data);

      // 添加活动记录
      const activity: Activity = {
        id: `alert_${Date.now()}`,
        type: 'error',
        message: data.message,
        timestamp: new Date().toISOString(),
        severity: data.severity,
        metadata: { category: data.category, ...data.metadata },
      };

      activities.value.unshift(activity);
      if (activities.value.length > 100) {
        activities.value = activities.value.slice(0, 100);
      }
    });

    // 健康检查事件
    sseService.onHealthCheck((data) => {
      console.log('收到健康检查事件:', data);

      // 更新健康状态 - 创建新对象保持响应式
      if (systemHealth.value) {
        systemHealth.value = {
          ...systemHealth.value,
          status: data.status,
          lastCheck: data.lastCheck || new Date().toISOString(),
        };
      }
    });
  };

  // 初始化仪表板数据
  const initializeDashboard = async () => {
    await Promise.all([
      fetchDashboardStats(),
      fetchSystemHealth(),
      fetchPerformanceStats(),
      fetchSystemInfo(),
      fetchActivities(),
    ]);
  };

  // 刷新所有数据
  const refreshAll = async () => {
    await initializeDashboard();
  };

  // 清理资源
  const cleanup = () => {
    disconnectSSE();
    sseService.removeAllEventListeners();
  };

  return {
    // 状态
    stats,
    systemHealth,
    performanceStats,
    systemInfo,
    sseStats,
    logs,
    activities,
    loading,
    error,
    sseConnected,
    sseConnectionState,
    lastUpdated,

    // 计算属性
    isHealthy,
    hasWarnings,
    hasErrors,
    recentErrorCount,
    serverConnectionRate,
    statCards,

    // 方法
    fetchDashboardStats,
    fetchSystemHealth,
    fetchPerformanceStats,
    fetchSystemInfo,
    fetchLogs,
    fetchActivities,
    fetchSSEStats,
    connectSSE,
    disconnectSSE,
    initializeDashboard,
    refreshAll,
    cleanup,
  };
});
