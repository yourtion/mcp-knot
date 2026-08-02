import { UnifiedErrorNormalizer } from '@mcp-core/mcp-knot-protocol';
/**
 * 组特定MCP路由处理器
 * 处理 /:group/mcp 路由，提供基于组的MCP服务访问
 *
 * v2（协议 2026-07-28）+ P7：POST /:group/mcp 使用 @modelcontextprotocol/server
 * 的 createMcpHandler（legacy 开关由 InboundProtocolAdapter 据 CompatibilityOptions
 * 解析，默认 'stateless'），handler.fetch 桥接 Hono 的 c.req.raw。groupServices 缓存
 * 与 handler 缓存由 mcp-handler-factory 统一管理。错误经 UnifiedErrorNormalizer 归一化
 * code/message（保留 domain-specific 的 data.error 嵌套结构以向后兼容）。
 */
import { Hono } from 'hono';

import { createMcpAuthMiddleware } from '../../middleware/mcp-auth.js';
import { createResourceServer } from '../../services/oauth/resource-server.js';
import { getAllConfig } from '../../utils/config.js';
import { logger } from '../../utils/logger.js';
import { GroupMcpService } from './group-service.js';
import {
  createGroupMcpHandler,
  ensureGroupMcpService,
  getGroupHandlersCache,
  getGroupServicesCache,
} from './mcp-handler-factory.js';

import type { ResourceServerDeps } from '../../services/oauth/resource-server.js';
import type { SystemConfig } from '@mcp-core/mcp-knot-share';
import type { GroupConfig } from '@mcp-core/mcp-knot-share/config';
import type { Context } from 'hono';

export const groupMcpRouter = new Hono();

/**
 * MCP 端点认证中间件（单例）。
 *
 * resourceServer.getConfig 适配 getAllConfig 的返回结构：
 * getAllConfig 返回 DeepReadonly 的 `{ mcps, groups, system: { oauth, ... } }`，
 * 而 ResourceServerDeps.getConfig 期望可变的 `{ oauth, groups }`（oauth 在顶层）。
 * 故这里做一次结构映射（system.oauth 提到顶层）。配置在运行时只读，
 * DeepReadonly → mutable 的转换是安全的（resource-server 不修改配置）。
 */
const resourceServerGetConfig: ResourceServerDeps['getConfig'] = async () => {
  const cfg = await getAllConfig();
  return {
    oauth: cfg.system.oauth as SystemConfig['oauth'],
    groups: cfg.groups as GroupConfig,
  };
};

const mcpAuthMiddleware = createMcpAuthMiddleware({
  resourceServer: createResourceServer({ getConfig: resourceServerGetConfig }),
  resourceMetadataUrlPath: '/.well-known/oauth-protected-resource',
});

// P7：统一错误归一化单例（进程级无状态，单例避免每请求重建）。
// 用于把 JSON-RPC 错误的 code/message 经统一 normalizer 处理，保留 domain-specific
// 的 data.error 嵌套结构以向后兼容（e2e 测试断言 data.error.data.error.code）。
const errorNormalizer = new UnifiedErrorNormalizer();

/**
 * 构造 JSON-RPC 错误响应体。
 *
 * P7：code/message 经 UnifiedErrorNormalizer 归一化（统一 -32602/-32603 等语义），
 * 同时保留 domain-specific 的 data.error 嵌套结构（{ code, message, ... }）以向后兼容。
 *
 * @param rpcCode JSON-RPC 错误码（normalizer 校验/兜底为 -32603）
 * @param message 错误消息（normalizer 兜底为 'Internal error'）
 * @param domainError 嵌入 data.error 的 domain-specific 错误对象（向后兼容）
 * @param id JSON-RPC id（错误响应统一 null）
 */
function buildJsonRpcError(
  rpcCode: number,
  message: string,
  domainError: { code: string; message: string; [k: string]: unknown },
): {
  jsonrpc: '2.0';
  error: { code: number; message: string; data: { error: typeof domainError } };
  id: null;
} {
  // 经 normalizer 归一化 code/message（兜底非法值为 -32603/'Internal error'）
  const normalized = errorNormalizer.normalize({ code: rpcCode, message });
  return {
    jsonrpc: '2.0',
    error: {
      code: normalized.code,
      message: normalized.message,
      data: { error: domainError },
    },
    id: null,
  };
}

// 复用 mcp-handler-factory 中模块级单例缓存（保持原导出名不变）
const groupServices = getGroupServicesCache();

/**
 * 获取或创建组特定的MCP服务
 */
async function getGroupMcpService(groupId: string): Promise<GroupMcpService> {
  return ensureGroupMcpService(groupId);
}

/**
 * 验证组是否存在
 */
async function validateGroupExists(groupId: string): Promise<boolean> {
  try {
    const config = await getAllConfig();
    return groupId in config.groups;
  } catch (error) {
    logger.error('验证组存在性时出错', error as Error, { groupId });
    return false;
  }
}

/**
 * 组验证中间件
 */
async function groupValidationMiddleware(c: Context, next: () => Promise<void>) {
  const groupId = c.req.param('group');

  if (!groupId) {
    logger.warn('组路由请求缺少组ID参数');
    return c.json(
      buildJsonRpcError(-32602, '无效参数：缺少组ID', {
        code: 'MISSING_GROUP_ID',
        message: '请求路径中必须包含组ID',
      }),
      { status: 400 },
    );
  }

  // 验证组是否存在
  const groupExists = await validateGroupExists(groupId);
  if (!groupExists) {
    logger.warn('请求的组不存在', { groupId });
    return c.json(
      buildJsonRpcError(-32602, `组 '${groupId}' 不存在`, {
        code: 'GROUP_NOT_FOUND',
        message: `指定的组 '${groupId}' 在配置中不存在`,
      }),
      { status: 404 },
    );
  }

  // 将组ID添加到上下文中
  c.set('groupId', groupId);
  await next();
}

/**
 * 处理组特定的MCP请求
 *
 * 使用 createMcpHandler 构造的 handler（P7：legacy 开关由 InboundProtocolAdapter 据
 * CompatibilityOptions 解析，默认 'stateless'；inbound.enabled=false 时 'reject'）：
 *   handler.fetch(c.req.raw) 直接返回 Web-standard Response。
 * 直接透传 c.req.raw，由 handler 内部 clone+读取请求体，避免在 Hono 中
 * 预先消耗请求流。
 */
groupMcpRouter.post('/:group/mcp', groupValidationMiddleware, mcpAuthMiddleware, async (c) => {
  const groupId = c.req.param('group')!;

  try {
    logger.info('处理组特定MCP请求', { groupId });

    // 获取（或惰性创建）绑定到该组的 MCP handler
    const handler = await createGroupMcpHandler(groupId);

    // Web-standard 桥接：handler.fetch 接受 Request，返回 Response
    const response = await handler.fetch(c.req.raw);

    return response;
  } catch (error) {
    logger.error('组MCP端点错误', error as Error, { groupId });
    // P7：经 UnifiedErrorNormalizer 归一化 code/message（Error 实例 → -32603 + message），
    // 保留 domain-specific 的 INTERNAL_ERROR 嵌套结构以向后兼容。
    const normalized = errorNormalizer.toJsonRpc(error);
    return c.json(
      buildJsonRpcError(normalized.code, normalized.message, {
        code: 'INTERNAL_ERROR',
        message: (error as Error).message,
        groupId,
      }),
      { status: 500 },
    );
  }
});

/**
 * 获取组状态信息
 */
groupMcpRouter.get('/:group/status', groupValidationMiddleware, async (c) => {
  const groupId = c.req.param('group')!;

  try {
    logger.debug('获取组状态信息', { groupId });

    const groupService = await getGroupMcpService(groupId);
    const status = await groupService.getStatus();

    return c.json({
      groupId,
      status,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    logger.error('获取组状态失败', error as Error, { groupId });
    return c.json(
      {
        error: {
          code: 'STATUS_ERROR',
          message: `获取组 '${groupId}' 状态失败: ${(error as Error).message}`,
        },
      },
      { status: 500 },
    );
  }
});

/**
 * 获取组可用工具列表
 */
groupMcpRouter.get('/:group/tools', groupValidationMiddleware, async (c) => {
  const groupId = c.req.param('group')!;

  try {
    logger.debug('获取组工具列表', { groupId });

    const groupService = await getGroupMcpService(groupId);
    const tools = await groupService.getAvailableTools();

    return c.json({
      groupId,
      tools,
      count: tools.length,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    logger.error('获取组工具列表失败', error as Error, { groupId });
    return c.json(
      {
        error: {
          code: 'TOOLS_ERROR',
          message: `获取组 '${groupId}' 工具列表失败: ${(error as Error).message}`,
        },
      },
      { status: 500 },
    );
  }
});

/**
 * 优雅关闭组路由服务
 */
export async function shutdownGroupMcpRouter(): Promise<void> {
  try {
    logger.info('关闭组MCP路由服务');

    // 先关闭所有 MCP handler（中止在飞的 modern exchanges）
    const groupHandlers = getGroupHandlersCache();
    const handlerClosePromises = Array.from(groupHandlers.values()).map(async (handler) => {
      try {
        await handler.close();
      } catch (error) {
        logger.error('关闭组MCP handler 时出错', error as Error);
      }
    });
    await Promise.allSettled(handlerClosePromises);
    groupHandlers.clear();

    // 再关闭所有组服务实例
    const shutdownPromises = Array.from(groupServices.values()).map(async (service) => {
      try {
        await service.shutdown();
      } catch (error) {
        logger.error('关闭组服务时出错', error as Error);
      }
    });

    await Promise.allSettled(shutdownPromises);
    groupServices.clear();

    // 核心服务管理器由 registry 统一关闭，此处无需处理

    logger.info('组MCP路由服务关闭完成');
  } catch (error) {
    logger.error('关闭组MCP路由服务时出错', error as Error);
    throw error;
  }
}
