/**
 * 组特定MCP服务包装器
 * 使用核心包功能为特定组提供MCP服务
 */

import { ConfigError, ErrorCode, ServiceError } from '@mcp-core/mcp-knot-core';
import { registerSkills } from '@mcp-core/mcp-knot-core/skills';
import { isInputRequiredResult, McpServer } from '@modelcontextprotocol/server';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod/v4';

import { extractFromMeta, runWithTraceContext } from '../../middleware/trace-context.js';
import { MrtrRelayService } from '../../services/mrtr-relay-service.js';
import { getSkillRepository } from '../../services/skills-service.js';

import type { HubState } from '../../services/mrtr-relay-service.js';
import type { McpServiceManagerInterface } from '@mcp-core/mcp-knot-core';
import type { CallToolResult, InputRequiredResult } from '@modelcontextprotocol/server';
// JSON Schema types
interface JsonSchema {
  type: string;
  properties?: Record<string, JsonSchemaProperty>;
  required?: string[];
  description?: string;
}

interface JsonSchemaProperty {
  type: string;
  description?: string;
  enum?: string[];
  default?: unknown;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  items?: JsonSchemaProperty;
  properties?: Record<string, JsonSchemaProperty>;
  required?: string[];
}

// 读取 package.json
const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf-8'));

/**
 * 协议层 cacheHint 默认值：tools/list 结果缓存 1 分钟，
 * cacheScope=public（工具列表跨用户一致）。
 * 见 spec §1.2。
 *
 * P2 复查钩子：当 P2 入站 OAuth 落地、且 Hub 实现按用户权限过滤工具时，
 * cacheScope 必须改 private，否则会泄露工具元数据给未授权用户（见 spec §3.1）。
 */
const DEFAULT_GROUP_CACHE_HINTS = {
  ttlMs: 60_000,
  cacheScope: 'public' as const,
};

import { getAllConfig } from '../../utils/config.js';
import { logger } from '../../utils/logger.js';

import type { Group } from '@mcp-core/mcp-knot-share';

/**
 * 组MCP服务状态
 */
export interface GroupServiceStatus {
  groupId: string;
  isInitialized: boolean;
  serverCount: number;
  connectedServers: number;
  availableTools: number;
  lastUpdate: string;
}

/**
 * 工具信息
 */
export interface GroupToolInfo {
  name: string;
  description?: string;
  serverId: string;
  inputSchema?: Record<string, unknown>;
  status?: 'available' | 'unavailable';
}

/**
 * 组特定MCP服务包装器
 */
export class GroupMcpService {
  private mcpServer!: McpServer;
  private isInitialized = false;
  private groupConfig: Group | null = null;
  private availableTools: GroupToolInfo[] = [];
  /**
   * P5: 已注册动态工具的 RegisteredTool 句柄，key 为注册名（`${serverId}_${toolName}`）。
   * 用于 refreshTools 时调用 .remove() 注销指定 server 的旧工具。
   * SDK GA (2.0.0) 的 registerTool 返回带 remove()/update()/enable()/disable() 的句柄，
   * 提供运行时细粒度工具管理（无需重建整个 McpServer）。
   */
  private registeredToolHandles = new Map<string, { remove: () => void }>();
  /** 解析后的组级 cacheHints（initialize 内 buildMcpServer 时由 resolveCacheHints 覆盖） */
  private groupCacheHints: { ttlMs: number; cacheScope: 'public' | 'private' } = {
    ...DEFAULT_GROUP_CACHE_HINTS,
  };

  constructor(
    private groupId: string,
    private coreServiceManager: McpServiceManagerInterface,
    /**
     * P5 MRTR：多轮中转中继服务。可选注入——未启用 MRTR 时为 undefined，
     * handler 对 input_required 仍做识别（不再无脑包成 text），但不会 mint Hub state。
     */
    private mrtrRelay?: MrtrRelayService,
  ) {
    // McpServer 构造延迟到 initialize()，以便读取组配置里的 cacheHints
  }

  /**
   * 初始化组服务
   */
  async initialize(): Promise<void> {
    if (this.isInitialized) {
      logger.warn('组MCP服务已初始化，跳过重复初始化', {
        groupId: this.groupId,
      });
      return;
    }

    try {
      logger.info('初始化组MCP服务', { groupId: this.groupId });

      // 加载组配置
      await this.loadGroupConfig();

      // 读配置后构造 McpServer（应用组级 cacheHints）
      this.buildMcpServer();

      // 注册组管理工具
      await this.registerGroupManagementTools();

      // 注册组特定的动态工具
      await this.registerGroupDynamicTools();

      // 注册 Hub 元数据 resources（协议层 cacheHint 在 resources/read 的落点）
      await this.registerGroupResources();

      if (this.groupConfig?.skills) {
        const catalog = await getSkillRepository().catalog(this.groupConfig.skills, this.groupId);
        registerSkills(this.mcpServer, catalog);
      }

      this.isInitialized = true;
      logger.info('组MCP服务初始化完成', {
        groupId: this.groupId,
        toolCount: this.availableTools.length,
      });
    } catch (error) {
      logger.error('组MCP服务初始化失败', error as Error, {
        groupId: this.groupId,
      });
      throw error;
    }
  }

  /**
   * 构造 McpServer 并应用组级 cacheHints。
   * 必须在 loadGroupConfig() 之后调用，以便读取组配置里的 cacheHints 覆盖。
   */
  private buildMcpServer(): void {
    this.groupCacheHints = this.resolveCacheHints(this.groupConfig);
    this.mcpServer = new McpServer(
      { name: `${pkg.name}-group-${this.groupId}`, version: pkg.version },
      {
        cacheHints: {
          'tools/list': {
            ttlMs: this.groupCacheHints.ttlMs,
            cacheScope: this.groupCacheHints.cacheScope,
          },
        },
        // P5 MRTR：注入 requestState.verify 钩子（HMAC-SHA256 验签客户端回传的 Hub state）。
        // SDK 事实（核实见 task-8-report）：此字段属 ServerOptions（McpServer 构造第二参数），
        // 由 McpServer 构造函数读取（mcp-DXXb3Vv3.mjs:725 this._requestStateVerify = options?.requestState?.verify），
        // 不是 createMcpHandler options（后者 index.mjs:1205 只解构 legacy/onerror/responseMode，不读 requestState）。
        // mrtrRelay 未注入时省略 verify——SDK 保持 passthrough（ctx.mcpReq.requestState() 返回原始 wire 字符串，
        // 视为 attacker-controlled；handler 走「识别但不中转」保底路径）。
        ...(this.mrtrRelay && {
          requestState: { verify: this.mrtrRelay.verify },
        }),
      },
    );
  }

  /**
   * 解析组级 cacheHints，应用默认值。
   * 默认：ttlMs=60_000（1 分钟），cacheScope='public'（工具列表跨用户一致）。
   * 组级覆盖缺失的字段回落到默认值。
   */
  private resolveCacheHints(groupConfig: Group | null): {
    ttlMs: number;
    cacheScope: 'public' | 'private';
  } {
    const overrides = groupConfig?.cacheHints;
    return {
      ttlMs: overrides?.toolsListTtlMs ?? DEFAULT_GROUP_CACHE_HINTS.ttlMs,
      cacheScope: overrides?.toolsListCacheScope ?? DEFAULT_GROUP_CACHE_HINTS.cacheScope,
    };
  }

  /**
   * HTTP serving owns and mutates each returned server (protocol era, client
   * identity and transport). Never hand the cached service's server to it.
   * Rebuild registrations over the shared upstream manager; no new upstream
   * connections or polling loops are created by GroupMcpService.initialize().
   */
  async createRequestServer(): Promise<McpServer> {
    const requestService = new GroupMcpService(
      this.groupId,
      this.coreServiceManager,
      this.mrtrRelay,
    );
    await requestService.initialize();
    return requestService.getMcpServer();
  }

  /**
   * 获取MCP服务器实例
   */
  getMcpServer(): McpServer {
    if (!this.isInitialized) {
      throw new ServiceError(
        ErrorCode.SERVICE_UNAVAILABLE,
        `组 '${this.groupId}' 的MCP服务未初始化`,
      );
    }
    return this.mcpServer;
  }

  /**
   * 获取组服务状态
   */
  async getStatus(): Promise<GroupServiceStatus> {
    try {
      const _serviceStatus = this.coreServiceManager.getServiceStatus();
      const serverConnections = this.coreServiceManager.getServerConnections();

      // 计算该组的服务器连接状态
      const groupServers = this.groupConfig?.servers || [];
      const connectedServers = Array.from(serverConnections.values()).filter(
        (conn) => groupServers.includes(conn.id) && conn.status === 'connected',
      ).length;

      return {
        groupId: this.groupId,
        isInitialized: this.isInitialized,
        serverCount: groupServers.length,
        connectedServers,
        availableTools: this.availableTools.length,
        lastUpdate: new Date().toISOString(),
      };
    } catch (error) {
      logger.error('获取组服务状态失败', error as Error, {
        groupId: this.groupId,
      });
      throw error;
    }
  }

  /**
   * 获取组可用工具列表
   */
  async getAvailableTools(): Promise<GroupToolInfo[]> {
    if (!this.isInitialized) {
      await this.initialize();
    }
    return [...this.availableTools];
  }

  /**
   * 关闭组服务
   */
  async shutdown(): Promise<void> {
    try {
      logger.info('关闭组MCP服务', { groupId: this.groupId });

      // 关闭MCP服务器连接（防御性：未初始化时 mcpServer 可能为 undefined）
      this.mcpServer?.close();

      this.isInitialized = false;
      this.availableTools = [];

      logger.info('组MCP服务关闭完成', { groupId: this.groupId });
    } catch (error) {
      logger.error('关闭组MCP服务时出错', error as Error, {
        groupId: this.groupId,
      });
      throw error;
    }
  }

  /**
   * 加载组配置
   */
  private async loadGroupConfig(): Promise<void> {
    try {
      const config = await getAllConfig();
      this.groupConfig = config.groups[this.groupId] as Group;
      if (!this.groupConfig) {
        throw new ConfigError(ErrorCode.CONFIG_FILE_NOT_FOUND, `组 '${this.groupId}' 的配置未找到`);
      }

      logger.debug('组配置加载成功', {
        groupId: this.groupId,
        serverCount: this.groupConfig.servers?.length || 0,
        toolFilter: this.groupConfig.tools?.length || 0,
      });
    } catch (error) {
      logger.error('加载组配置失败', error as Error, { groupId: this.groupId });
      throw error;
    }
  }

  /**
   * 注册组管理工具
   */
  private async registerGroupManagementTools(): Promise<void> {
    // 组状态工具
    this.mcpServer.registerTool(
      'group_status',
      {
        description: `查询组 '${this.groupId}' 的运行时状态（服务器连接状态、工具数量等）`,
        inputSchema: z.object({}),
      },
      async () => {
        try {
          const status = await this.getStatus();
          return {
            content: [
              {
                type: 'text',
                text: `组 '${this.groupId}' 状态:\n${JSON.stringify(status, null, 2)}`,
              },
            ],
          };
        } catch (error) {
          logger.error('获取组状态工具执行失败', error as Error, {
            groupId: this.groupId,
          });
          return {
            content: [
              {
                type: 'text',
                text: `获取组状态失败: ${(error as Error).message}`,
              },
            ],
          };
        }
      },
    );

    // 组工具列表工具
    this.mcpServer.registerTool(
      'list_group_tools',
      {
        description: `列出组 '${this.groupId}' 聚合的所有可用工具（含来源 server 与描述）`,
        inputSchema: z.object({}),
      },
      async () => {
        try {
          const tools = await this.getAvailableTools();
          const toolList = tools
            .map(
              (tool) => `- ${tool.name} (来自 ${tool.serverId}): ${tool.description || '无描述'}`,
            )
            .join('\n');

          return {
            content: [
              {
                type: 'text',
                text: `组 '${this.groupId}' 可用工具 (${tools.length} 个):\n${toolList}`,
              },
            ],
          };
        } catch (error) {
          logger.error('列出组工具失败', error as Error, {
            groupId: this.groupId,
          });
          return {
            content: [
              {
                type: 'text',
                text: `列出组工具失败: ${(error as Error).message}`,
              },
            ],
          };
        }
      },
    );

    logger.debug('组管理工具注册完成', { groupId: this.groupId });
  }

  /**
   * 注册组特定的动态工具
   */
  private async registerGroupDynamicTools(): Promise<void> {
    try {
      // 获取组的服务器列表
      const groupServers = this.groupConfig?.servers || [];
      if (groupServers.length === 0) {
        logger.warn('组没有配置服务器', { groupId: this.groupId });
        return;
      }

      // 获取组内所有可用工具
      const allTools = await this.coreServiceManager.getAllTools();
      const groupTools = allTools.filter(
        (tool) => tool.serverId && groupServers.includes(tool.serverId),
      );

      // 应用组工具过滤规则
      const filteredTools = this.applyToolFilter(groupTools as GroupToolInfo[]);

      // 确定性排序（先 serverId 后 toolName 字典序），保证 tools/list 顺序稳定，
      // 使客户端能稳定缓存 tools/list 结果、提升 LLM prompt cache 命中率。
      const sortedTools = [...filteredTools].toSorted((a, b) => {
        const byServer = (a.serverId ?? '').localeCompare(b.serverId ?? '');
        if (byServer !== 0) return byServer;
        return (a.name ?? '').localeCompare(b.name ?? '');
      });

      // 注册每个工具
      for (const tool of sortedTools) {
        await this.registerDynamicTool(tool);
      }

      this.availableTools = sortedTools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        serverId: tool.serverId,
        inputSchema: tool.inputSchema,
      }));

      logger.info('组动态工具注册完成', {
        groupId: this.groupId,
        totalTools: groupTools.length,
        filteredTools: filteredTools.length,
      });
    } catch (error) {
      logger.error('注册组动态工具失败', error as Error, {
        groupId: this.groupId,
      });
      // 不抛出错误，允许服务继续运行
    }
  }

  /**
   * 获取组的服务器列表与连接状态。
   *
   * group://servers resource 的内容源：仅返回本组配置的服务器，
   * 不透传所有上游 server，从而保证 group 隔离边界。
   * 连接状态从 coreServiceManager.getServerConnections() 读取，
   * 缺失条目按 disconnected 处理。
   */
  private async getGroupServersStatus(): Promise<{
    groupId: string;
    servers: Array<{ id: string; status: string }>;
    timestamp: string;
  }> {
    const groupServers = this.groupConfig?.servers ?? [];
    const serverConnections = this.coreServiceManager.getServerConnections();
    return {
      groupId: this.groupId,
      servers: groupServers.map((id) => ({
        id,
        status: serverConnections.get(id)?.status ?? 'disconnected',
      })),
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * 注册 Hub 自身元数据 resources（协议层 cacheHint 在 resources/read 的落点）。
   *
   * 注册 4 个 resource：
   *   - group://{groupId}/status  —— 组运行时状态（短 ttl, private；状态频繁变化，且每用户隔离）
   *   - group://{groupId}/servers —— 服务器列表与连接状态（同上，private 短 ttl）
   *   - hub://config              —— 全局配置概要（长 ttl, public；跨用户/跨组一致）
   *   - hub://version             —— 版本信息（极长 ttl, public；进程生命周期内不变）
   *
   * cacheScope 取值理由：private 短 ttl 用于运行时状态（含连接状态、初始化进度，
   * 因 group 而异、随时间漂移）；public 长 ttl 用于全局静态信息（配置/版本）。
   *
   * 注意：SDK readCallback 签名为 (uri: URL, ctx: ServerContext) => ...；
   * 本实现用闭包内的 uri 字符串构造响应，不读取入参，故 callback 显式声明
   * `_uri: URL` 以匹配 SDK 签名（下划线前缀表示有意未使用）。
   */
  private async registerGroupResources(): Promise<void> {
    const statusUri = `group://${this.groupId}/status`;
    this.mcpServer.registerResource(
      'group_status_resource',
      statusUri,
      {
        description: `组 '${this.groupId}' 的运行时状态`,
        mimeType: 'application/json',
        cacheHint: { ttlMs: 5_000, cacheScope: 'private' },
      },
      async (_uri: URL) => {
        try {
          const status = await this.getStatus();
          return {
            contents: [
              {
                uri: statusUri,
                mimeType: 'application/json',
                text: JSON.stringify(status, null, 2),
              },
            ],
          };
        } catch (error) {
          logger.error('读取 group://status resource 失败', error as Error, {
            groupId: this.groupId,
          });
          return {
            contents: [
              {
                uri: statusUri,
                mimeType: 'application/json',
                text: JSON.stringify({ error: (error as Error).message, groupId: this.groupId }),
              },
            ],
          };
        }
      },
    );

    const serversUri = `group://${this.groupId}/servers`;
    this.mcpServer.registerResource(
      'group_servers',
      serversUri,
      {
        description: `组 '${this.groupId}' 的服务器列表与连接状态`,
        mimeType: 'application/json',
        cacheHint: { ttlMs: 5_000, cacheScope: 'private' },
      },
      async (_uri: URL) => {
        try {
          const payload = await this.getGroupServersStatus();
          return {
            contents: [
              {
                uri: serversUri,
                mimeType: 'application/json',
                text: JSON.stringify(payload, null, 2),
              },
            ],
          };
        } catch (error) {
          logger.error('读取 group://servers resource 失败', error as Error, {
            groupId: this.groupId,
          });
          return {
            contents: [
              {
                uri: serversUri,
                mimeType: 'application/json',
                text: JSON.stringify({ error: (error as Error).message, groupId: this.groupId }),
              },
            ],
          };
        }
      },
    );

    this.mcpServer.registerResource(
      'hub_config',
      'hub://config',
      {
        description: 'Hub 全局配置概要',
        mimeType: 'application/json',
        cacheHint: { ttlMs: 300_000, cacheScope: 'public' },
      },
      async (_uri: URL) => {
        try {
          const config = await getAllConfig();
          const payload = {
            version: pkg.version,
            groups: Object.keys(config.groups ?? {}),
            serverCount: Object.keys(config.mcps?.servers ?? {}).length,
          };
          return {
            contents: [
              {
                uri: 'hub://config',
                mimeType: 'application/json',
                text: JSON.stringify(payload, null, 2),
              },
            ],
          };
        } catch (error) {
          logger.error('读取 hub://config resource 失败', error as Error);
          return {
            contents: [
              {
                uri: 'hub://config',
                mimeType: 'application/json',
                text: JSON.stringify({ error: (error as Error).message, scope: 'global' }),
              },
            ],
          };
        }
      },
    );

    this.mcpServer.registerResource(
      'hub_version',
      'hub://version',
      {
        description: 'Hub 版本信息',
        mimeType: 'application/json',
        cacheHint: { ttlMs: 86_400_000, cacheScope: 'public' },
      },
      async (_uri: URL) => {
        try {
          return {
            contents: [
              {
                uri: 'hub://version',
                mimeType: 'application/json',
                text: JSON.stringify({ name: pkg.name, version: pkg.version }, null, 2),
              },
            ],
          };
        } catch (error) {
          logger.error('读取 hub://version resource 失败', error as Error);
          return {
            contents: [
              {
                uri: 'hub://version',
                mimeType: 'application/json',
                text: JSON.stringify({ error: (error as Error).message, scope: 'global' }),
              },
            ],
          };
        }
      },
    );

    logger.debug('组 resources 注册完成', { groupId: this.groupId, count: 4 });
  }

  /**
   * 应用组工具过滤规则
   */
  private applyToolFilter(tools: GroupToolInfo[]): GroupToolInfo[] {
    const toolFilter = this.groupConfig?.tools;

    // 如果没有配置工具过滤，返回所有工具
    if (!toolFilter || toolFilter.length === 0) {
      return tools;
    }

    // 如果配置了特定工具列表，只返回这些工具
    return tools.filter((tool) => toolFilter.includes(tool.name));
  }

  /**
   * 注册单个动态工具
   */
  private async registerDynamicTool(tool: GroupToolInfo): Promise<void> {
    try {
      // 创建工具名称（避免冲突）
      const toolName = `${tool.serverId}_${tool.name}`;

      // 转换输入模式为Zod模式
      const zodSchema = this.convertToZodSchema(
        (tool.inputSchema || {
          type: 'object',
          properties: {},
        }) as unknown as JsonSchema,
      );

      // 注册工具
      // v2: registerTool(name, { inputSchema }, handler)，zodSchema 是 raw shape 需用 z.object() 包装
      // P5: registerTool 返回 RegisteredTool 句柄（带 remove()），保存以便 refreshTools 注销。
      const registered = this.mcpServer.registerTool(
        toolName,
        { description: tool.description, inputSchema: z.object(zodSchema) },
        async (args, extra) => {
          // P6/SEP-414：从请求 _meta 提取 trace context，注入 AsyncLocalStorage，
          // 使下游 server_manager.executeToolOnServer 的出站 callTool 能读到并注入上游 _meta。
          // SDK v2 (2026-07-28 protocol) handler ctx 为 ServerContext，入站 _meta 在 ctx.mcpReq._meta；
          // optional chaining 防御 ctx 或 mcpReq 缺失（SDK 版本差异）。
          const traceCtx = extractFromMeta(extra?.mcpReq?._meta);
          return runWithTraceContext(traceCtx, async () => {
            try {
              logger.debug('执行组动态工具', {
                groupId: this.groupId,
                toolName: tool.name,
                serverId: tool.serverId,
                args,
              });

              // P5 MRTR：判断是否为重试请求。SDK seam 在 handler 前已对客户端回传的
              // requestState 跑过 verify（ServerOptions.requestState.verify），结果经
              // ctx.mcpReq.requestState<HubState>() 读回。mrtrRelay 未注入时退化为初次调用。
              const hubState = extra?.mcpReq?.requestState<HubState>();
              const resume = this.mrtrRelay?.resume(hubState);

              // 重试时把客户端应答 + 上游原始 state 透传给上游 callTool 的 request params
              // （顶层 inputResponses / requestState）。初次调用传空 retryContext。
              const retryContext = resume?.isResume
                ? {
                    inputResponses: extra?.mcpReq?.inputResponses,
                    requestState: resume.upstreamRequestState,
                  }
                : {};

              const result = await this.coreServiceManager.executeToolCallWithContext(
                tool.name,
                args,
                tool.serverId,
                retryContext,
              );

              // P5：识别上游 InputRequiredResult（修原 bug——原实现只看 'content' in result，
              // 把无 content 的 input_required 错误包成 text，吞掉 MRTR 语义）。
              // 用 SDK 的类型守卫 isInputRequiredResult 判定，避免硬编码字段名。
              const isInputRequired = isInputRequiredResult(result);

              if (isInputRequired) {
                // 识别到上游 InputRequiredResult。委托 MrtrRelayService mint Hub 级
                // requestState（HMAC-SHA256），把 serverId/toolName/upstreamRequestState/
                // step 印封进 state 返回客户端，作为多轮中转的 opaque 句柄。
                //
                // mrtrRelay 未注入（MRTR 未启用）时：不再走下面的 content/text 分支
                // （那会把无 content 的 input_required 错误包成 text、吞掉 MRTR 语义），
                // 而是直传上游 InputRequiredResult——它本身是结构合法的 SDK 结果，
                // 客户端可按上游原生 state 重试。这是「不吞语义」的保底行为。
                if (this.mrtrRelay) {
                  const upstream = result as {
                    inputRequests?: unknown;
                    requestState?: string;
                  };
                  // step：初次（resume.isResume === false）=1；重试 = (resume.step ?? 0) + 1
                  const step = resume?.isResume ? (resume.step ?? 0) + 1 : 1;
                  // RelayResult 与 SDK InputRequiredResult 结构等价（resultType/inputRequests/
                  // requestState）；inputRequests 在 Hub 侧按 opaque 透传（上游 schema 不可知），
                  // 此处断言以满足 registerTool handler 的联合返回类型。
                  return (await this.mrtrRelay.relay(
                    tool.serverId,
                    tool.name,
                    upstream,
                    step,
                  )) as unknown as InputRequiredResult;
                }
                return result as unknown as InputRequiredResult;
              }

              // 正常结果：带 content 直传
              if (result && typeof result === 'object' && 'content' in result) {
                return result as unknown as CallToolResult;
              }

              // 转换结果格式（保留原逻辑给非标准返回）
              return {
                content: [
                  {
                    type: 'text' as const,
                    text: typeof result === 'string' ? result : JSON.stringify(result, null, 2),
                  },
                ],
              };
            } catch (error) {
              logger.error('组动态工具执行失败', error as Error, {
                groupId: this.groupId,
                toolName: tool.name,
                serverId: tool.serverId,
              });

              return {
                isError: true,
                content: [
                  {
                    type: 'text' as const,
                    text: `工具执行失败: ${(error as Error).message}`,
                  },
                ],
              };
            }
          });
        },
      );

      // P5: 保存 RegisteredTool 句柄，供 refreshTools 调 .remove() 注销。
      // SDK GA 的 registerTool 返回带 remove() 的对象；防御性处理：仅当返回值可调用 remove 时保存。
      if (registered && typeof registered.remove === 'function') {
        this.registeredToolHandles.set(toolName, registered);
      }

      logger.debug('动态工具注册成功', {
        groupId: this.groupId,
        toolName,
        originalName: tool.name,
        serverId: tool.serverId,
      });
    } catch (error) {
      logger.error('注册动态工具失败', error as Error, {
        groupId: this.groupId,
        toolName: tool.name,
        serverId: tool.serverId,
      });
    }
  }

  /**
   * P5: 重新注册指定 server 的工具（上游工具集变更 fan-out 时调用）。
   *
   * 策略（SDK GA 2.0.0 确认）：registerTool 返回的 RegisteredTool 句柄带 remove()，
   * 支持运行时细粒度注销。故 refreshTools：
   *   1. 取该 server 最新工具列表（getServerTools，需上游已 refetch 并更新缓存）
   *   2. remove 掉该 server 的旧工具句柄（名称前缀 `${serverId}_`）
   *   3. 对最新工具重新 registerDynamicTool
   *   4. 同步更新 availableTools（移除旧 server 工具、合入新工具）
   *
   * 只动该 server 的工具，不触碰其他 server。异常不抛出（fan-out 异常隔离由调用方处理）。
   *
   * 注意：本方法读取的 getServerTools 是 ServerManager 缓存。调用方（fanout）须在
   * 调本方法前先 refetch 上游（ServerManager.refetchServerTools），保证缓存已更新。
   */
  async refreshTools(serverId: string): Promise<void> {
    if (!this.isInitialized) {
      logger.warn('refreshTools 调用时服务未初始化，跳过', { groupId: this.groupId, serverId });
      return;
    }

    try {
      // 1. 取最新工具列表
      const latestTools = (await this.coreServiceManager.getServerTools(
        serverId,
      )) as GroupToolInfo[];
      // 应用组工具过滤规则，保持与初始注册一致
      const filteredTools = this.applyToolFilter(latestTools);
      // 确定性排序（与 registerGroupDynamicTools 一致）
      const sortedTools = [...filteredTools].toSorted((a, b) => {
        const byServer = (a.serverId ?? '').localeCompare(b.serverId ?? '');
        if (byServer !== 0) return byServer;
        return (a.name ?? '').localeCompare(b.name ?? '');
      });

      // 2. 注销该 server 的旧工具句柄（按 `${serverId}_` 前缀匹配）
      const staleNames: string[] = [];
      for (const [toolName, handle] of this.registeredToolHandles) {
        if (toolName.startsWith(`${serverId}_`)) {
          try {
            handle.remove();
          } catch (removeErr) {
            logger.warn('注销旧工具失败（继续重注册）', {
              groupId: this.groupId,
              toolName,
              error: String(removeErr),
            });
          }
          staleNames.push(toolName);
          this.registeredToolHandles.delete(toolName);
        }
      }

      // 3. 重新注册最新工具
      for (const tool of sortedTools) {
        if (tool.serverId !== serverId) continue;
        await this.registerDynamicTool(tool);
      }

      // 4. 同步 availableTools：剔除该 server 的旧条目，合入新条目
      const others = this.availableTools.filter((t) => t.serverId !== serverId);
      const refreshed = sortedTools
        .filter((t) => t.serverId === serverId)
        .map((tool) => ({
          name: tool.name,
          description: tool.description,
          serverId: tool.serverId,
          inputSchema: tool.inputSchema,
        }));
      this.availableTools = [...others, ...refreshed];

      logger.debug('refreshTools 完成', {
        groupId: this.groupId,
        serverId,
        removedCount: staleNames.length,
        registeredCount: refreshed.length,
      });
    } catch (error) {
      logger.error('refreshTools 失败', error as Error, {
        groupId: this.groupId,
        serverId,
      });
    }
  }

  /**
   * 转换JSON Schema到Zod Schema
   */
  private convertToZodSchema(inputSchema: JsonSchema): Record<string, z.ZodType> {
    if (!inputSchema || !inputSchema.properties) {
      return {};
    }

    const zodSchema: Record<string, z.ZodType> = {};

    for (const [propName, propDef] of Object.entries(inputSchema.properties)) {
      const prop = propDef as JsonSchemaProperty;

      // 基本类型转换
      switch (prop.type) {
        case 'string':
          zodSchema[propName] = z.string();
          break;
        case 'number':
          zodSchema[propName] = z.number();
          break;
        case 'boolean':
          zodSchema[propName] = z.boolean();
          break;
        case 'object':
          zodSchema[propName] = z.record(z.string(), z.any());
          break;
        case 'array':
          zodSchema[propName] = z.array(z.any());
          break;
        default:
          zodSchema[propName] = z.any();
      }

      // 添加描述
      if (prop.description) {
        zodSchema[propName] = zodSchema[propName].describe(prop.description);
      }

      // 处理可选属性
      if (!inputSchema.required || !inputSchema.required.includes(propName)) {
        zodSchema[propName] = zodSchema[propName].optional();
      }
    }

    return zodSchema;
  }
}
