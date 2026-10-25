/**
 * 组管理业务逻辑（纯函数模块）
 *
 * 本模块从 index.ts 抽离，负责 7 个组 CRUD/health/servers 端点的业务逻辑：
 * - 获取组列表（GET /）
 * - 获取组详情（GET /:groupId）
 * - 获取组健康状态（GET /:groupId/health）
 * - 获取组服务器列表（GET /:groupId/servers）
 * - 创建组（POST /）
 * - 更新组（PUT /:groupId）
 * - 删除组（DELETE /:groupId）
 *
 * 设计约束：
 * - 纯函数，不持有 Hono Context，不构造 HTTP 响应。
 * - 依赖（service-registry / config / logger / performanceMonitor / validation）
 *   按现状 import 方式获取。
 * - 校验失败 / 资源不存在等业务错误以结构化 GroupServiceError 抛出，
 *   由 handler 转换为与原实现逐字一致的 HTTP 响应（响应结构沿用 Task 10/11 模式）。
 *
 * 注意：原 handler 的 success 响应通过 successResponse(c, data[, status]) 构造；
 * 本 service 返回 { data, status? } 部分（原样），由 handler 包裹。
 */

import {
  getCoreServiceManager,
  reloadCoreServiceManager,
} from '../../services/service-registry.js';
import { getSkillRepository } from '../../services/skills-service.js';
import { getAllConfig, saveConfig } from '../../utils/config.js';
import { logger } from '../../utils/logger.js';
import { performanceMonitor } from '../../utils/performance-monitor.js';
import { validateGroupData, validateGroupId } from './validation.js';

import type { ToolInfo } from '@mcp-core/mcp-knot-core';
import type { CreateGroupRequest, GroupConfig, UpdateGroupRequest } from '@mcp-core/mcp-knot-share';

/**
 * 业务错误码（与原 handler 的响应 error.code 逐字对应）
 */
export type GroupServiceErrorCode =
  | 'INVALID_GROUP_ID'
  | 'VALIDATION_ERROR'
  | 'GROUP_NOT_FOUND'
  | 'GROUP_ALREADY_EXISTS'
  | 'CANNOT_DELETE_DEFAULT_GROUP';

/**
 * 结构化业务错误。
 * handler 捕获后用 code/message/status/details 重建原 c.json 响应。
 *
 * details 字段仅 VALIDATION_ERROR 用到（对应原响应 error.details），
 * 其它错误不出现 details 字段（保持原响应结构逐字一致）。
 */
export class GroupServiceError extends Error {
  readonly code: GroupServiceErrorCode;
  readonly status: 400 | 403 | 404 | 409;
  readonly details?: string[];

  constructor(
    code: GroupServiceErrorCode,
    message: string,
    status: 400 | 403 | 404 | 409,
    details?: string[],
  ) {
    super(message);
    this.name = 'GroupServiceError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

/**
 * 组配置项（与 index.ts 中的 GroupConfigItem 一致，含 servers/tools/validation 字段）。
 * servers/tools 为非可选，与 share 包 GroupConfig Schema 保持一致（原 handler
 * 直接访问 .servers.length / .tools.length，类型亦是如此）。
 */
type GroupItem = {
  id?: string;
  name?: string;
  description?: string;
  servers: string[];
  tools: string[];
  validation?: {
    enabled: boolean;
    validationKey?: string;
    createdAt?: string;
    lastUpdated?: string;
  };
  skills?: CreateGroupRequest['skills'];
  [key: string]: unknown;
};

/**
 * 所有组配置的类型（与 getAllConfig 返回的 groups 字段一致，DeepReadonly）。
 */
type GroupsConfig = Awaited<ReturnType<typeof getAllConfig>>['groups'];

/**
 * 通过 as 访问 readonly 组配置，与 index.ts 原实现访问方式一致。
 */
function getGroup(groupId: string, groups: GroupsConfig): GroupItem | undefined {
  return (groups as unknown as Record<string, GroupItem>)[groupId];
}

/**
 * 读取单个组配置，不存在则抛 GROUP_NOT_FOUND（消息逐字保持原 handler）。
 */
function requireExistingGroup(groupId: string, groups: GroupsConfig): GroupItem {
  const group = getGroup(groupId, groups);
  if (!group) {
    throw new GroupServiceError('GROUP_NOT_FOUND', `组 '${groupId}' 不存在`, 404);
  }
  return group;
}

// ---------------------------------------------------------------------------
// GET /  —— 获取组列表
// ---------------------------------------------------------------------------

/**
 * 获取所有组列表（GET /）
 *
 * 返回原 handler successResponse 的 data 部分（构建逻辑与原实现逐字保持）。
 */
export async function listGroups(): Promise<{
  groups: Array<Record<string, unknown>>;
  totalGroups: number;
  healthyGroups: number;
  unhealthyGroups: number;
  totalServers: number;
  connectedServers: number;
  totalTools: number;
  filteredTools: number;
  averageHealthScore: number;
  groupsWithValidation: number;
  groupsWithToolFilter: number;
  summary: Record<string, unknown>;
}> {
  logger.debug('获取所有组列表');

  const config = await getAllConfig();
  const groups = config.groups;

  const coreServiceManager = await getCoreServiceManager();

  const serverConnections = coreServiceManager.getServerConnections();

  // 构建组列表，包含运行时状态和详细信息
  const groupList = await Promise.all(
    Object.entries(groups).map(async ([groupId, groupConfig]) => {
      try {
        // 计算组内服务器连接状态
        const groupServers = groupConfig.servers || [];
        const connectedServers = groupServers.filter((serverId: string) => {
          const connection = serverConnections.get(serverId);
          return connection && connection.status === 'connected';
        });

        // 获取组内工具数量和详细信息
        let toolCount = 0;
        let availableTools: ToolInfo[] = [];
        try {
          const allTools = await coreServiceManager?.getAllTools();
          availableTools =
            allTools?.filter((tool) => tool.serverId && groupServers.includes(tool.serverId)) || [];
          toolCount = availableTools.length;
        } catch (error) {
          logger.warn('获取组工具数量失败', {
            groupId,
            error: (error as Error).message,
          });
        }

        // 应用工具过滤
        const toolFilter = groupConfig.tools || [];
        let filteredTools = availableTools;
        if (toolFilter.length > 0) {
          filteredTools = availableTools.filter((tool) => toolFilter.includes(tool.name));
        }

        return {
          id: groupId,
          name: groupConfig.name || groupId,
          description: groupConfig.description || '',
          servers: groupServers,
          serverCount: groupServers.length,
          connectedServers: connectedServers.length,
          toolCount,
          filteredToolCount: filteredTools.length,
          tools: groupConfig.tools || [],
          ...(groupConfig.skills !== undefined && { skills: groupConfig.skills }),
          toolFilterMode: toolFilter.length > 0 ? 'whitelist' : 'none',
          isHealthy: connectedServers.length > 0,
          healthScore:
            groupServers.length > 0
              ? Math.round((connectedServers.length / groupServers.length) * 100)
              : 0,
          validation: {
            enabled: groupConfig.validation?.enabled || false,
            hasKey: !!groupConfig.validation?.validationKey,
            createdAt: groupConfig.validation?.createdAt,
            lastUpdated: groupConfig.validation?.lastUpdated,
          },
          stats: {
            totalServers: groupServers.length,
            availableServers: connectedServers.length,
            totalTools: toolCount,
            filteredTools: filteredTools.length,
            healthPercentage:
              groupServers.length > 0
                ? Math.round((connectedServers.length / groupServers.length) * 100)
                : 0,
          },
          lastUpdated: groupConfig.validation?.lastUpdated || new Date().toISOString(),
        };
      } catch (error) {
        logger.error('处理组信息时出错', error as Error, { groupId });
        return {
          id: groupId,
          name: groupConfig.name || groupId,
          description: groupConfig.description || '',
          servers: groupConfig.servers || [],
          serverCount: (groupConfig.servers || []).length,
          connectedServers: 0,
          toolCount: 0,
          filteredToolCount: 0,
          tools: groupConfig.tools || [],
          toolFilterMode: 'none',
          isHealthy: false,
          healthScore: 0,
          validation: {
            enabled: false,
            hasKey: false,
          },
          stats: {
            totalServers: (groupConfig.servers || []).length,
            availableServers: 0,
            totalTools: 0,
            filteredTools: 0,
            healthPercentage: 0,
          },
          lastUpdated: new Date().toISOString(),
          error: (error as Error).message,
        };
      }
    }),
  );

  const response = {
    groups: groupList,
    totalGroups: groupList.length,
    healthyGroups: groupList.filter((g) => g.isHealthy).length,
    totalServers: groupList.reduce((sum, g) => sum + g.serverCount, 0),
    connectedServers: groupList.reduce((sum, g) => sum + g.connectedServers, 0),
    totalTools: groupList.reduce((sum, g) => sum + g.toolCount, 0),
    filteredTools: groupList.reduce((sum, g) => sum + g.filteredToolCount, 0),
    averageHealthScore:
      groupList.length > 0
        ? Math.round(groupList.reduce((sum, g) => sum + g.healthScore, 0) / groupList.length)
        : 0,
    groupsWithValidation: groupList.filter((g) => g.validation.enabled).length,
    groupsWithToolFilter: groupList.filter((g) => g.toolFilterMode !== 'none').length,
    summary: {
      status:
        groupList.filter((g) => g.isHealthy).length === groupList.length && groupList.length > 0
          ? 'healthy'
          : groupList.filter((g) => g.isHealthy).length > 0
            ? 'partial'
            : 'unhealthy',
      issues: [
        ...(groupList.some((g) => g.healthScore < 50) ? ['部分组健康度较低'] : []),
        ...(groupList.filter((g) => g.error).length > 0 ? ['部分组存在错误'] : []),
      ],
    },
    timestamp: new Date().toISOString(),
  };

  logger.info('组列表查询完成', {
    totalGroups: response.totalGroups,
    healthyGroups: response.healthyGroups,
    totalTools: response.totalTools,
  });

  // 与原 handler successResponse 包裹的 data 部分逐字一致
  return {
    groups: response.groups,
    totalGroups: response.totalGroups,
    healthyGroups: response.healthyGroups,
    unhealthyGroups: response.totalGroups - response.healthyGroups,
    totalServers: response.totalServers,
    connectedServers: response.connectedServers,
    totalTools: response.totalTools,
    filteredTools: response.filteredTools,
    averageHealthScore: response.averageHealthScore,
    groupsWithValidation: response.groupsWithValidation,
    groupsWithToolFilter: response.groupsWithToolFilter,
    summary: response.summary,
  };
}

// ---------------------------------------------------------------------------
// GET /:groupId  —— 获取组详情
// ---------------------------------------------------------------------------

/**
 * 获取特定组的详细信息（GET /:groupId）
 *
 * 原 handler 不校验组 ID 格式，仅校验组存在性，本函数保持一致。
 *
 * 返回原 handler successResponse 的 data 部分。
 */
export async function getGroupDetail(groupId: string): Promise<Record<string, unknown>> {
  logger.debug('获取组详细信息', { groupId });

  const config = await getAllConfig();
  const groups = config.groups;
  const groupConfig = requireExistingGroup(groupId, groups);

  const coreServiceManager = await getCoreServiceManager();

  const serverConnections = coreServiceManager.getServerConnections();
  const groupServers = groupConfig.servers || [];

  // 获取服务器详细状态
  const serverDetails = groupServers.map((serverId: string) => {
    const connection = serverConnections.get(serverId);
    return {
      id: serverId,
      status: connection?.status || 'unknown',
      lastConnected: connection?.lastConnected?.toISOString(),
      toolCount: connection?.tools?.length || 0,
      error: connection?.lastError?.message,
    };
  });

  // 获取组内所有工具
  let groupTools: ToolInfo[] = [];
  try {
    const allTools = await coreServiceManager.getAllTools();
    groupTools = allTools
      .filter((tool) => tool.serverId && groupServers.includes(tool.serverId))
      .map((tool) => ({
        name: tool.name,
        description: tool.description,
        serverId: tool.serverId,
        parameters: tool.parameters,
        category: tool.category,
      }));

    // 如果组配置了特定工具过滤，应用过滤
    if (groupConfig.tools && groupConfig.tools.length > 0) {
      groupTools = groupTools.filter((tool) => groupConfig.tools!.includes(tool.name));
    }
  } catch (error) {
    logger.warn('获取组工具失败', {
      groupId,
      error: (error as Error).message,
    });
  }

  const connectedServers = serverDetails.filter(
    (s: { status: string }) => s.status === 'connected',
  );

  const response = {
    id: groupId,
    name: groupConfig.name || groupId,
    description: groupConfig.description || '',
    servers: serverDetails,
    serverCount: groupServers.length,
    connectedServers: connectedServers.length,
    tools: groupTools,
    toolCount: groupTools.length,
    toolFilter: groupConfig.tools || [],
    ...(groupConfig.skills !== undefined && { skills: groupConfig.skills }),
    toolFilterMode: groupConfig.tools && groupConfig.tools.length > 0 ? 'whitelist' : 'none',
    isHealthy: connectedServers.length > 0,
    healthScore:
      groupServers.length > 0
        ? Math.round((connectedServers.length / groupServers.length) * 100)
        : 0,
    validation: {
      enabled: groupConfig.validation?.enabled || false,
      hasKey: !!groupConfig.validation?.validationKey,
      validationKey: groupConfig.validation?.validationKey ? '***' : undefined,
      createdAt: groupConfig.validation?.createdAt,
      lastUpdated: groupConfig.validation?.lastUpdated,
    },
    stats: {
      totalServers: groupServers.length,
      availableServers: connectedServers.length,
      totalTools: groupTools.length,
      healthPercentage:
        groupServers.length > 0
          ? Math.round((connectedServers.length / groupServers.length) * 100)
          : 0,
    },
    performance: (() => {
      const mcpStats = performanceMonitor.getStatsByPathPrefix(`/${groupId}/mcp`);
      return {
        averageResponseTime: Math.round(mcpStats.averageResponseTime),
        totalRequests: mcpStats.totalRequests,
        successRate: Math.round(mcpStats.successRate),
      };
    })(),
    accessControl: {
      requiresValidation: groupConfig.validation?.enabled || false,
      toolAccessRestricted: groupConfig.tools && groupConfig.tools.length > 0,
    },
    lastUpdated: groupConfig.validation?.lastUpdated || new Date().toISOString(),
    timestamp: new Date().toISOString(),
  };

  logger.info('组详细信息查询完成', {
    groupId,
    serverCount: response.serverCount,
    connectedServers: response.connectedServers,
    toolCount: response.toolCount,
  });

  return response;
}

// ---------------------------------------------------------------------------
// GET /:groupId/health  —— 获取组健康状态
// ---------------------------------------------------------------------------

/**
 * 组健康检查结果（含 success data 和自定义 HTTP 状态码）。
 * 原 handler 用 successResponse(c, response, statusCode)，statusCode 为 200/503。
 */
export interface GroupHealthResult {
  data: Record<string, unknown>;
  status: 200 | 503;
}

/**
 * 获取组的健康检查状态（GET /:groupId/health）
 *
 * 原 handler 不校验组 ID 格式，仅校验组存在性，本函数保持一致。
 *
 * 返回 { data, status }：data 为原 successResponse 的 data 部分，
 * status 为原 handler 根据健康度推导的 HTTP 状态码（200 健康 / 503 不健康）。
 */
export async function getGroupHealth(groupId: string): Promise<GroupHealthResult> {
  logger.debug('执行组健康检查', { groupId });

  const config = await getAllConfig();
  const groups = config.groups;
  const groupConfig = requireExistingGroup(groupId, groups);

  const coreServiceManager = await getCoreServiceManager();

  const serverConnections = coreServiceManager.getServerConnections();
  const groupServers = groupConfig.servers || [];

  // 检查服务器连接状态
  const serverHealth = groupServers.map((serverId: string) => {
    const connection = serverConnections.get(serverId);
    const isHealthy = connection && connection.status === 'connected';

    return {
      serverId,
      healthy: isHealthy,
      status: connection?.status || 'unknown',
      lastConnected: connection?.lastConnected?.toISOString(),
      error: connection?.lastError?.message,
      toolCount: connection?.tools?.length || 0,
    };
  });

  const healthyServers = serverHealth.filter((s) => s.healthy === true);
  const healthScore =
    groupServers.length > 0 ? Math.round((healthyServers.length / groupServers.length) * 100) : 0;

  // 检查工具可用性
  let toolHealth = { available: 0, total: 0 };
  try {
    const allTools = await coreServiceManager.getAllTools();
    const groupTools = allTools.filter((tool) => groupServers.includes(tool.serverId || ''));

    toolHealth = {
      available: groupTools.length,
      total: groupConfig.tools?.length || groupTools.length,
    };
  } catch (error) {
    logger.warn('检查组工具健康状态失败', {
      groupId,
      error: (error as Error).message,
    });
  }

  const isHealthy = healthyServers.length > 0 && toolHealth.available > 0;
  const statusCode = isHealthy ? 200 : 503;

  const response = {
    groupId,
    healthy: isHealthy,
    healthScore,
    servers: {
      total: groupServers.length,
      healthy: healthyServers.length,
      unhealthy: groupServers.length - healthyServers.length,
      details: serverHealth,
    },
    tools: toolHealth,
    issues: [
      ...(healthyServers.length === 0 ? ['没有可用的服务器连接'] : []),
      ...(toolHealth.available === 0 ? ['没有可用的工具'] : []),
      ...(healthScore < 50 ? [`服务器健康度较低: ${healthScore}%`] : []),
    ],
  };

  logger.info('组健康检查完成', {
    groupId,
    healthy: isHealthy,
    healthScore,
    healthyServers: healthyServers.length,
    totalServers: groupServers.length,
  });

  return { data: response, status: statusCode };
}

// ---------------------------------------------------------------------------
// GET /:groupId/servers  —— 获取组服务器列表
// ---------------------------------------------------------------------------

/**
 * 获取组的服务器列表（GET /:groupId/servers）
 *
 * 原 handler 不校验组 ID 格式，仅校验组存在性，本函数保持一致。
 *
 * 返回原 handler successResponse 的 data 部分。
 */
export async function getGroupServers(groupId: string): Promise<Record<string, unknown>> {
  logger.debug('获取组服务器列表', { groupId });

  const config = await getAllConfig();
  const groups = config.groups;
  const groupConfig = requireExistingGroup(groupId, groups);

  const coreServiceManager = await getCoreServiceManager();

  const serverConnections = coreServiceManager.getServerConnections();
  const groupServers = groupConfig.servers || [];

  // 获取服务器详细信息
  const serverDetails = await Promise.all(
    groupServers.map(async (serverId: string) => {
      const connection = serverConnections.get(serverId);

      // 获取服务器工具
      let serverTools: ToolInfo[] = [];
      try {
        serverTools = (await coreServiceManager?.getServerTools(serverId)) || [];
      } catch (error) {
        logger.warn('获取服务器工具失败', {
          serverId,
          error: (error as Error).message,
        });
      }

      return {
        id: serverId,
        status: connection?.status || 'unknown',
        lastConnected: connection?.lastConnected?.toISOString(),
        lastError: connection?.lastError?.message,
        tools: serverTools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          category: tool.category,
        })),
        toolCount: serverTools.length,
        isHealthy: connection?.status === 'connected',
      };
    }),
  );

  const connectedServers = serverDetails.filter((s) => s.isHealthy);

  const response = {
    groupId,
    servers: serverDetails,
    totalServers: serverDetails.length,
    connectedServers: connectedServers.length,
    disconnectedServers: serverDetails.length - connectedServers.length,
    totalTools: serverDetails.reduce((sum, s) => sum + s.toolCount, 0),
    healthScore:
      serverDetails.length > 0
        ? Math.round((connectedServers.length / serverDetails.length) * 100)
        : 0,
  };

  logger.info('组服务器列表查询完成', {
    groupId,
    totalServers: response.totalServers,
    connectedServers: response.connectedServers,
    totalTools: response.totalTools,
  });

  return response;
}

// ---------------------------------------------------------------------------
// POST /  —— 创建组
// ---------------------------------------------------------------------------

/**
 * 创建新组（POST /）
 *
 * 校验顺序与原 handler 逐字保持：
 * 1. validateGroupData → VALIDATION_ERROR(400, 带 details)
 * 2. validateGroupId(body.id) → INVALID_GROUP_ID(400)
 * 3. 组已存在 → GROUP_ALREADY_EXISTS(409)
 * 4. 服务器不存在仅 warn，不阻止创建（与原实现一致）
 *
 * 副作用：saveConfig('group.json', ...) + reloadCoreServiceManager（重新初始化失败仅 warn）。
 *
 * 返回原 handler successResponse 的 data 部分。
 */
export async function createGroup(body: CreateGroupRequest): Promise<Record<string, unknown>> {
  logger.debug('创建新组请求', { body });

  // 验证请求数据
  const validation = validateGroupData(body);
  if (!validation.isValid) {
    throw new GroupServiceError('VALIDATION_ERROR', '请求数据验证失败', 400, validation.errors);
  }

  // 验证组ID
  const idValidation = validateGroupId(body.id);
  if (!idValidation.isValid) {
    throw new GroupServiceError('INVALID_GROUP_ID', idValidation.error ?? '', 400);
  }

  // 检查组是否已存在
  const config = await getAllConfig();
  const groups = config.groups as Record<string, unknown>;

  if (groups[body.id]) {
    throw new GroupServiceError('GROUP_ALREADY_EXISTS', `组 '${body.id}' 已存在`, 409);
  }

  // 验证服务器是否存在
  const servers = config.mcps.servers as Record<string, unknown>;
  const invalidServers = body.servers.filter((serverId) => !servers[serverId]);

  if (invalidServers.length > 0) {
    logger.warn('创建组时发现不存在的服务器', {
      groupId: body.id,
      invalidServers,
    });
    // 不阻止创建，但记录警告
  }

  // 创建新组配置
  const newGroup = {
    id: body.id,
    name: body.name,
    description: body.description || '',
    servers: body.servers || [],
    tools: body.tools || [],
    ...(body.skills !== undefined && { skills: body.skills }),
  };

  if (newGroup.servers.length === 0 && !newGroup.skills?.include.length)
    throw new GroupServiceError('VALIDATION_ERROR', '组至少需要服务器或已发布技能', 400);
  if (body.skills) {
    try {
      await getSkillRepository().catalog(body.skills, body.id);
    } catch (error) {
      throw new GroupServiceError('VALIDATION_ERROR', '技能发布引用无效', 400, [
        (error as Error).message,
      ]);
    }
  }

  // 保存到配置文件
  const updatedGroups = {
    ...groups,
    [body.id]: newGroup,
  };

  await saveConfig('group.json', updatedGroups as GroupConfig);

  // 重新初始化核心服务管理器以应用新配置
  try {
    await reloadCoreServiceManager();
  } catch (error) {
    logger.warn('重新初始化核心服务管理器失败', {
      error: (error as Error).message,
    });
  }

  logger.info('组创建成功', {
    groupId: body.id,
    groupName: body.name,
    serverCount: body.servers.length,
    toolCount: body.tools.length,
  });

  return {
    id: body.id,
    name: body.name,
    description: body.description || '',
    servers: body.servers || [],
    tools: body.tools || [],
    ...(body.skills !== undefined && { skills: body.skills }),
    toolFilterMode: body.tools && body.tools.length > 0 ? 'whitelist' : 'none',
    validation: {
      enabled: false,
      hasKey: false,
    },
    stats: {
      totalServers: body.servers.length,
      availableServers: 0, // 需要连接后重新计算
      totalTools: body.tools.length,
      filteredTools: body.tools.length,
      healthPercentage: 0, // 需要连接后重新计算
    },
    accessControl: {
      requiresValidation: false,
      toolAccessRestricted: body.tools && body.tools.length > 0,
    },
    lastUpdated: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// PUT /:groupId  —— 更新组
// ---------------------------------------------------------------------------

/**
 * 更新组配置（PUT /:groupId）
 *
 * 校验顺序与原 handler 逐字保持：
 * 1. validateGroupId(groupId) → INVALID_GROUP_ID(400)
 * 2. validateGroupData(body) → VALIDATION_ERROR(400, 带 details)
 * 3. 组不存在 → GROUP_NOT_FOUND(404)
 * 4. 服务器不存在仅 warn，不阻止更新（与原实现一致）
 *
 * 副作用：saveConfig('group.json', ...) + reloadCoreServiceManager（重新初始化失败仅 warn）。
 *
 * 返回原 handler successResponse 的 data 部分。
 */
export async function updateGroup(
  groupId: string,
  body: UpdateGroupRequest,
): Promise<Record<string, unknown>> {
  logger.debug('更新组配置请求', { groupId, body });

  // 验证组ID
  const idValidation = validateGroupId(groupId);
  if (!idValidation.isValid) {
    throw new GroupServiceError('INVALID_GROUP_ID', idValidation.error ?? '', 400);
  }

  // 验证请求数据
  const validation = validateGroupData(body);
  if (!validation.isValid) {
    throw new GroupServiceError('VALIDATION_ERROR', '请求数据验证失败', 400, validation.errors);
  }

  // 检查组是否存在
  const config = await getAllConfig();
  const groups = config.groups;
  const existingGroup = requireExistingGroup(groupId, groups);

  // 验证服务器是否存在（如果提供了服务器列表）
  if (body.servers) {
    const servers = config.mcps.servers as Record<string, unknown>;
    const invalidServers = body.servers.filter((serverId) => !servers[serverId]);

    if (invalidServers.length > 0) {
      logger.warn('更新组时发现不存在的服务器', {
        groupId,
        invalidServers,
      });
      // 不阻止更新，但记录警告
    }
  }

  // 更新组配置
  const updatedGroup = {
    ...existingGroup,
    ...(body.name !== undefined && { name: body.name }),
    ...(body.description !== undefined && { description: body.description }),
    ...(body.servers !== undefined && { servers: body.servers }),
    ...(body.tools !== undefined && { tools: body.tools }),
    ...(body.skills !== undefined && { skills: body.skills }),
  };

  if (updatedGroup.servers.length === 0 && !updatedGroup.skills?.include.length)
    throw new GroupServiceError('VALIDATION_ERROR', '组至少需要服务器或已发布技能', 400);
  if (body.skills) {
    try {
      await getSkillRepository().catalog(body.skills, groupId);
    } catch (error) {
      throw new GroupServiceError('VALIDATION_ERROR', '技能发布引用无效', 400, [
        (error as Error).message,
      ]);
    }
  }

  // 保存到配置文件
  const updatedGroups = {
    ...groups,
    [groupId]: updatedGroup,
  };

  await saveConfig('group.json', updatedGroups as GroupConfig);

  // 重新初始化核心服务管理器以应用新配置
  try {
    await reloadCoreServiceManager();
  } catch (error) {
    logger.warn('重新初始化核心服务管理器失败', {
      error: (error as Error).message,
    });
  }

  logger.info('组更新成功', {
    groupId,
    groupName: updatedGroup.name,
    serverCount: updatedGroup.servers.length,
    toolCount: updatedGroup.tools.length,
  });

  return {
    id: groupId,
    name: updatedGroup.name,
    description: updatedGroup.description || '',
    servers: updatedGroup.servers || [],
    tools: updatedGroup.tools || [],
    ...(updatedGroup.skills !== undefined && { skills: updatedGroup.skills }),
    toolFilterMode: updatedGroup.tools && updatedGroup.tools.length > 0 ? 'whitelist' : 'none',
    validation: {
      enabled: updatedGroup.validation?.enabled || false,
      hasKey: !!updatedGroup.validation?.validationKey,
      createdAt: updatedGroup.validation?.createdAt,
      lastUpdated: updatedGroup.validation?.lastUpdated,
    },
    stats: {
      totalServers: updatedGroup.servers.length,
      availableServers: 0, // 需要重新计算
      totalTools: updatedGroup.tools.length,
      filteredTools: updatedGroup.tools.length,
      healthPercentage: 0, // 需要重新计算
    },
    accessControl: {
      requiresValidation: updatedGroup.validation?.enabled || false,
      toolAccessRestricted: updatedGroup.tools && updatedGroup.tools.length > 0,
    },
    lastUpdated: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// DELETE /:groupId  —— 删除组
// ---------------------------------------------------------------------------

/**
 * 删除组（DELETE /:groupId）
 *
 * 校验顺序与原 handler 逐字保持：
 * 1. validateGroupId(groupId) → INVALID_GROUP_ID(400)
 * 2. 组不存在 → GROUP_NOT_FOUND(404)
 * 3. groupId === 'default' → CANNOT_DELETE_DEFAULT_GROUP(403)
 *
 * 副作用：saveConfig('group.json', ...) + reloadCoreServiceManager（重新初始化失败仅 warn）。
 *
 * 返回原 handler successResponse 的 data 部分。
 */
export async function deleteGroup(groupId: string): Promise<Record<string, unknown>> {
  logger.debug('删除组请求', { groupId });

  // 验证组ID
  const idValidation = validateGroupId(groupId);
  if (!idValidation.isValid) {
    throw new GroupServiceError('INVALID_GROUP_ID', idValidation.error ?? '', 400);
  }

  // 检查组是否存在
  const config = await getAllConfig();
  const groups = config.groups;
  const existingGroup = requireExistingGroup(groupId, groups);

  // 检查是否为默认组（可选的保护机制）
  if (groupId === 'default') {
    throw new GroupServiceError('CANNOT_DELETE_DEFAULT_GROUP', '不能删除默认组', 403);
  }

  // 从配置中删除组
  const updatedGroups = { ...groups };
  delete (updatedGroups as Record<string, unknown>)[groupId];

  await saveConfig('group.json', updatedGroups as GroupConfig);

  // 重新初始化核心服务管理器以应用新配置
  try {
    await reloadCoreServiceManager();
  } catch (error) {
    logger.warn('重新初始化核心服务管理器失败', {
      error: (error as Error).message,
    });
  }

  logger.info('组删除成功', {
    groupId,
    groupName: existingGroup.name,
  });

  return {
    id: groupId,
    name: existingGroup.name,
    deleted: true,
  };
}
