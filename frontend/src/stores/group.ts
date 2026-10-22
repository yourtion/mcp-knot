// 组状态管理

import { defineStore } from 'pinia';
import { computed, ref } from 'vue';

import * as GroupService from '@/services/group';

import type {
  ConfigureGroupToolsRequest,
  CreateGroupRequest,
  GroupDetailInfo,
  GroupInfo,
  GroupKeyValidationRequest,
  SetGroupValidationKeyRequest,
  UpdateGroupRequest,
} from '@/types/group';

export const useGroupStore = defineStore('group', () => {
  // 状态
  const groups = ref<Map<string, GroupInfo>>(new Map());
  const loading = ref(false);
  const error = ref<string | null>(null);
  const summary = ref({
    totalGroups: 0,
    healthyGroups: 0,
    unhealthyGroups: 0,
    totalServers: 0,
    connectedServers: 0,
    totalTools: 0,
    filteredTools: 0,
    averageHealthScore: 0,
    groupsWithValidation: 0,
    groupsWithToolFilter: 0,
    summaryStatus: 'healthy' as 'healthy' | 'partial' | 'unhealthy',
    issues: [] as string[],
  });

  // 计算属性
  const groupList = computed(() => Array.from(groups.value.values()));
  const healthyGroups = computed(() => groupList.value.filter((group) => group.isHealthy));
  const unhealthyGroups = computed(() => groupList.value.filter((group) => !group.isHealthy));
  const groupsWithValidation = computed(() =>
    groupList.value.filter((group) => group.validation.enabled),
  );
  const groupsWithToolFilter = computed(() =>
    groupList.value.filter((group) => group.toolFilterMode !== 'none'),
  );

  // 获取组列表
  const fetchGroups = async () => {
    try {
      loading.value = true;
      error.value = null;

      const response = await GroupService.getGroups();

      // 更新组列表
      groups.value.clear();
      response.groups.forEach((group) => {
        groups.value.set(group.id, group);
      });

      // 更新统计信息
      summary.value = {
        totalGroups: response.totalGroups,
        healthyGroups: response.healthyGroups,
        unhealthyGroups: response.unhealthyGroups ?? response.totalGroups - response.healthyGroups,
        totalServers: response.totalServers,
        connectedServers: response.connectedServers,
        totalTools: response.totalTools,
        filteredTools: response.filteredTools,
        averageHealthScore: response.averageHealthScore,
        groupsWithValidation: response.groupsWithValidation,
        groupsWithToolFilter: response.groupsWithToolFilter,
        summaryStatus: response.summary.status,
        issues: response.summary.issues,
      };
    } catch (err) {
      error.value = err instanceof Error ? err.message : '获取组列表失败';
      console.error('获取组列表失败:', err);
    } finally {
      loading.value = false;
    }
  };

  // 获取特定组详细信息
  const fetchGroup = async (groupId: string): Promise<GroupDetailInfo> => {
    try {
      const group = await GroupService.getGroup(groupId);
      // 详情包含服务器/工具对象，不能覆盖列表中编辑表单依赖的 ID 与工具白名单。
      return group;
    } catch (err) {
      error.value = err instanceof Error ? err.message : '获取组信息失败';
      throw err;
    }
  };

  // 创建新组
  const createGroup = async (data: CreateGroupRequest) => {
    try {
      loading.value = true;
      error.value = null;

      const response = await GroupService.createGroup(data);

      // 重新获取列表以更新统计信息（createGroup 响应不含完整的 GroupInfo 计数字段，
      // 直接依赖 fetchGroups 刷新本地状态）
      await fetchGroups();

      return response;
    } catch (err) {
      error.value = err instanceof Error ? err.message : '创建组失败';
      throw err;
    } finally {
      loading.value = false;
    }
  };

  // 更新组配置
  const updateGroup = async (groupId: string, data: UpdateGroupRequest) => {
    try {
      loading.value = true;
      error.value = null;

      const response = await GroupService.updateGroup(groupId, data);

      // 更新组信息
      const existingGroup = groups.value.get(groupId);
      if (existingGroup) {
        groups.value.set(groupId, { ...existingGroup, ...response.data });
      }

      // 重新获取列表以更新统计信息
      await fetchGroups();

      return response;
    } catch (err) {
      error.value = err instanceof Error ? err.message : '更新组失败';
      throw err;
    } finally {
      loading.value = false;
    }
  };

  // 删除组
  const deleteGroup = async (groupId: string) => {
    try {
      loading.value = true;
      error.value = null;

      await GroupService.deleteGroup(groupId);

      // 从本地状态中移除
      groups.value.delete(groupId);

      // 重新获取列表以更新统计信息
      await fetchGroups();
    } catch (err) {
      error.value = err instanceof Error ? err.message : '删除组失败';
      throw err;
    } finally {
      loading.value = false;
    }
  };

  // 获取组的健康检查状态
  const getGroupHealth = async (groupId: string) => {
    try {
      return await GroupService.getGroupHealth(groupId);
    } catch (err) {
      error.value = err instanceof Error ? err.message : '获取组健康状态失败';
      throw err;
    }
  };

  // 获取组的工具列表
  const getGroupTools = async (groupId: string) => {
    try {
      return await GroupService.getGroupTools(groupId);
    } catch (err) {
      error.value = err instanceof Error ? err.message : '获取组工具列表失败';
      throw err;
    }
  };

  // 获取组的服务器列表
  const getGroupServers = async (groupId: string) => {
    try {
      return await GroupService.getGroupServers(groupId);
    } catch (err) {
      error.value = err instanceof Error ? err.message : '获取组服务器列表失败';
      throw err;
    }
  };

  // 配置组工具过滤
  const configureGroupTools = async (groupId: string, data: ConfigureGroupToolsRequest) => {
    try {
      loading.value = true;
      error.value = null;

      const response = await GroupService.configureGroupTools(groupId, data);

      // 更新组信息
      const existingGroup = groups.value.get(groupId);
      if (existingGroup) {
        existingGroup.tools = data.tools;
        existingGroup.toolFilterMode = data.tools.length > 0 ? 'whitelist' : 'none';
        groups.value.set(groupId, { ...existingGroup });
      }

      return response;
    } catch (err) {
      error.value = err instanceof Error ? err.message : '配置组工具过滤失败';
      throw err;
    } finally {
      loading.value = false;
    }
  };

  // 获取组可用工具（支持过滤）
  const getGroupAvailableTools = async (groupId: string) => {
    try {
      return await GroupService.getGroupAvailableTools(groupId);
    } catch (err) {
      error.value = err instanceof Error ? err.message : '获取组可用工具失败';
      throw err;
    }
  };

  // 验证工具访问权限
  const validateGroupToolAccess = async (groupId: string, toolName: string) => {
    try {
      return await GroupService.validateGroupToolAccess(groupId, {
        toolName,
      });
    } catch (err) {
      error.value = err instanceof Error ? err.message : '验证工具访问权限失败';
      throw err;
    }
  };

  // 设置组验证密钥
  const setGroupValidationKey = async (groupId: string, data: SetGroupValidationKeyRequest) => {
    try {
      loading.value = true;
      error.value = null;

      const response = await GroupService.setGroupValidationKey(groupId, data);

      // 更新组信息
      const existingGroup = groups.value.get(groupId);
      if (existingGroup) {
        existingGroup.validation = {
          ...existingGroup.validation,
          enabled: response.data.validation.enabled,
          hasKey: response.data.validation.hasKey,
          lastUpdated: response.data.validation.lastUpdated,
        };
        groups.value.set(groupId, { ...existingGroup });
      }

      return response;
    } catch (err) {
      error.value = err instanceof Error ? err.message : '设置组验证密钥失败';
      throw err;
    } finally {
      loading.value = false;
    }
  };

  // 获取组验证密钥状态
  const getGroupValidationKeyStatus = async (groupId: string) => {
    try {
      return await GroupService.getGroupValidationKeyStatus(groupId);
    } catch (err) {
      error.value = err instanceof Error ? err.message : '获取组验证密钥状态失败';
      throw err;
    }
  };

  // 验证组密钥
  const validateGroupKey = async (groupId: string, data: GroupKeyValidationRequest) => {
    try {
      return await GroupService.validateGroupKey(groupId, data);
    } catch (err) {
      error.value = err instanceof Error ? err.message : '验证组密钥失败';
      throw err;
    }
  };

  // 删除组验证密钥
  const deleteGroupValidationKey = async (groupId: string) => {
    try {
      loading.value = true;
      error.value = null;

      const response = await GroupService.deleteGroupValidationKey(groupId);

      // 更新组信息
      const existingGroup = groups.value.get(groupId);
      if (existingGroup) {
        existingGroup.validation = {
          enabled: false,
          hasKey: false,
        };
        groups.value.set(groupId, { ...existingGroup });
      }

      return response;
    } catch (err) {
      error.value = err instanceof Error ? err.message : '删除组验证密钥失败';
      throw err;
    } finally {
      loading.value = false;
    }
  };

  // 生成新的验证密钥
  const generateGroupValidationKey = async (groupId: string) => {
    try {
      loading.value = true;
      error.value = null;

      const response = await GroupService.generateGroupValidationKey(groupId);

      // 更新组信息
      const existingGroup = groups.value.get(groupId);
      if (existingGroup) {
        existingGroup.validation = {
          ...existingGroup.validation,
          enabled: response.data.validation.enabled,
          hasKey: response.data.validation.hasKey,
          lastUpdated: response.data.validation.lastUpdated,
        };
        groups.value.set(groupId, { ...existingGroup });
      }

      return response;
    } catch (err) {
      error.value = err instanceof Error ? err.message : '生成组验证密钥失败';
      throw err;
    } finally {
      loading.value = false;
    }
  };

  // 清除错误
  const clearError = () => {
    error.value = null;
  };

  return {
    // 状态
    groups,
    loading,
    error,
    summary,

    // 计算属性
    groupList,
    healthyGroups,
    unhealthyGroups,
    groupsWithValidation,
    groupsWithToolFilter,

    // 操作
    fetchGroups,
    fetchGroup,
    createGroup,
    updateGroup,
    deleteGroup,
    getGroupHealth,
    getGroupTools,
    getGroupServers,
    configureGroupTools,
    getGroupAvailableTools,
    validateGroupToolAccess,
    setGroupValidationKey,
    getGroupValidationKeyStatus,
    validateGroupKey,
    deleteGroupValidationKey,
    generateGroupValidationKey,
    clearError,
  };
});
