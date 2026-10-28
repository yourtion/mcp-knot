import { ConfigError, ConnectionError, ErrorCode, ServiceError } from '@mcp-core/mcp-knot-core';
import { OutboundProtocolAdapter, defaultCompatibilityOptions } from '@mcp-core/mcp-knot-protocol';
import {
  Client,
  SSEClientTransport,
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

import { getProgressCallback } from '../middleware/progress-context.js';
import { getCurrentTraceContext, hasTraceContext } from '../middleware/trace-context.js';
import { ServerStatus } from '../types/mcp-knot.js';
import { logger } from '../utils/logger.js';
import { createServerAuthProvider } from './mcp-server-auth-provider.js';

import type { ServerManager as IServerManager, ServerConnection, Tool } from '../types/mcp-knot.js';
import type { UpstreamEra } from '../types/mcp-knot.js';
import type { CompatibilityOptions } from '@mcp-core/mcp-knot-protocol';
import type { ServerConfig } from '@mcp-core/mcp-knot-share';
import type { Client as SdkClient } from '@modelcontextprotocol/client';

/**
 * 探测上游协议 era。connect 成功后调用，记录到 ServerConnection.era。
 *
 * 用 SDK client.getProtocolEra()（'modern' | 'legacy' | undefined）：
 *   - 'modern' / 'legacy' → 原样记录
 *   - undefined（未连接/协商未完成）→ 记录 'modern' 占位（MVP 不破坏现有 modern 链路，
 *     Task 12 e2e 验证 legacy upstream 时完善），并记 warn 日志便于诊断
 *
 * 探测本身不抛错（fail-open）：失败时退化为 'modern' 假设，保证现有链路无回归。
 */
function probeUpstreamEra(client: SdkClient, serverId: string): UpstreamEra {
  try {
    const sdkEra = client.getProtocolEra();
    if (sdkEra === 'modern' || sdkEra === 'legacy') {
      return sdkEra;
    }
    // undefined：协商未完成或 SDK 未暴露——按 modern 假设（MVP 占位，不破坏现有链路）
    logger.warn('上游 era 探测返回 undefined，按 modern 假设处理（P7 MVP 占位）', { serverId });
    return 'modern';
  } catch (error) {
    // 防御性：getProtocolEra 不应抛错，但 fail-open 保证不阻断连接
    logger.warn('探测上游 era 失败，按 modern 假设处理', {
      serverId,
      error: error instanceof Error ? error.message : String(error),
    });
    return 'modern';
  }
}

/**
 * P5: 上游工具集变更检测器接入点。
 * 只依赖 Detector 的结构性子集（saveSnapshot / onUpstreamNotification），
 * 便于测试注入部分 mock，也避免与 UpstreamChangeDetector 实现强耦合。
 */
export interface ServerManagerOptions {
  compatibility?: CompatibilityOptions;
  changeDetector?: {
    saveSnapshot: (serverId: string, tools: { name: string }[]) => void;
    onUpstreamNotification: (serverId: string) => void;
  };
}

export class ServerManager implements IServerManager {
  private readonly outboundAdapter: OutboundProtocolAdapter;
  private readonly compatibility: CompatibilityOptions;
  private servers: Map<string, ServerConnection> = new Map();
  private serverConfigs: Map<string, ServerConfig> = new Map();

  // Method to track MCP messages (to be set by the hub service)
  private messageTracker:
    | ((
        serverId: string,
        type: 'request' | 'response' | 'notification',
        method: string,
        content: unknown,
      ) => void)
    | null = null;

  // Set the message tracker function
  public setMessageTracker(
    tracker: (
      serverId: string,
      type: 'request' | 'response' | 'notification',
      method: string,
      content: unknown,
    ) => void,
  ): void {
    this.messageTracker = tracker;
  }

  constructor(
    serverConfigs: Record<string, ServerConfig>,
    private readonly options: ServerManagerOptions = {},
  ) {
    this.compatibility = options.compatibility ?? defaultCompatibilityOptions;
    this.outboundAdapter = new OutboundProtocolAdapter(this.compatibility);
    // Store server configurations
    for (const [serverId, config] of Object.entries(serverConfigs)) {
      this.serverConfigs.set(serverId, config);
    }
  }

  async initialize(): Promise<void> {
    logger.info('Initializing ServerManager', {
      serverCount: this.serverConfigs.size,
    });

    const initPromises = Array.from(this.serverConfigs.entries()).map(([serverId, config]) =>
      this.initializeServer(serverId, config),
    );

    // Initialize all servers concurrently, but don't fail if some fail
    await Promise.allSettled(initPromises);

    const connectedCount = Array.from(this.servers.values()).filter(
      (server) => server.status === ServerStatus.CONNECTED,
    ).length;

    logger.info('ServerManager initialization completed', {
      totalServers: this.serverConfigs.size,
      connectedServers: connectedCount,
    });
  }

  private async initializeServer(serverId: string, config: ServerConfig): Promise<void> {
    // Skip disabled servers
    if (config.enabled === false) {
      logger.info('Skipping disabled server', { serverId });
      return;
    }

    logger.info('Initializing server', { serverId, type: config.type });

    const serverConnection: ServerConnection = {
      id: serverId,
      config,
      client: new Client(
        {
          name: `mcp-knot-${serverId}`,
          version: '1.0.0',
        },
        {
          // P5 MRTR：声明上游交互能力（elicitation/sampling/roots）。
          // Hub 是 MRTR 中转层：上游可能用 inputRequired({ inputRequests: { …: elicit/… } })
          // 返回 input_required，要求调用方（即 Hub 的上游客户端）在声明这些能力时
          // 才允许发出（modern 服务端按 _meta.clientCapabilities 做 -32021 能力门禁）。
          // Hub 自身不就地 fulfil 这些请求，而是把 input_required 透传给下游客户端由其
          // 向真实用户 fulfil（见 group-service.ts 的 isInputRequiredResult + relay）。
          // 故此处声明是「中转承诺」，使上游门禁放行——与 Hub 入站声明这些能力语义对称。
          capabilities: { elicitation: {}, sampling: {}, roots: {} },
          // 出站保留兼容：探测到 modern server（2026-07-28）走 server/discover，
          // 否则回退到 legacy initialize。SDK 默认是 'legacy'（只发旧握手），
          // 默认 auto 兼容两种 era；禁用 legacy 时固定到 modern 协议。
          versionNegotiation: {
            mode:
              this.compatibility.outbound.modernOnly || !this.compatibility.outbound.enabled
                ? { pin: '2026-07-28' }
                : 'auto',
          },
          // P5 MRTR：禁用上游客户端的 input_required 自动 fulfil。Hub 是中转层，
          // 不就地处理上游的 elicitation/sampling/roots 请求，而是把 input_required
          // 透传给下游客户端（真实用户交互）。auto-fulfil（默认）会试图调本地 handler，
          // Hub 未注册 → 失败且吞掉 input_required 语义。autoFulfill:false + 下游
          // callTool 的 allowInputRequired:true 让 input_required 正确回到 Hub handler。
          inputRequired: { autoFulfill: false },
        },
      ),
      status: ServerStatus.CONNECTING,
      tools: [],
      reconnectAttempts: 0,
    };

    this.servers.set(serverId, serverConnection);

    try {
      await this.connectServer(serverConnection);
    } catch (error) {
      logger.error('Failed to initialize server', error as Error, { serverId });
      serverConnection.status = ServerStatus.ERROR;
      serverConnection.lastError = error as Error;
    }
  }

  private async connectServer(serverConnection: ServerConnection): Promise<void> {
    const { id: serverId, config } = serverConnection;

    try {
      serverConnection.status = ServerStatus.CONNECTING;
      logger.info('Server connecting', { serverId });

      if (config.type === 'stdio' || (!config.type && 'command' in config)) {
        await this.connectStdioServer(serverConnection);
      } else if (config.type === 'sse') {
        await this.connectSseServer(serverConnection);
      } else if (config.type === 'streaming') {
        await this.connectStreamingServer(serverConnection);
      } else {
        throw new ConfigError(
          ErrorCode.INVALID_SERVER_CONFIG,
          `Unsupported server type: ${config.type}`,
        );
      }

      serverConnection.status = ServerStatus.CONNECTED;
      serverConnection.lastConnected = new Date();
      serverConnection.reconnectAttempts = 0;

      // P7：探测上游协议 era（modern/legacy），记录到 server 元数据供 callTool 翻译用。
      // 探测 fail-open：失败/undefined 时退化为 'modern'（不破坏现有 modern 链路）。
      serverConnection.era = probeUpstreamEra(serverConnection.client, serverId);
      try {
        this.outboundAdapter.effectiveEra(serverConnection.era);
      } catch (error) {
        await serverConnection.client.close();
        throw error;
      }
      logger.info('上游 era 探测完成（P7）', { serverId, era: serverConnection.era });

      logger.logServerConnection(serverId, 'connected');

      // P5: 注册上游 listChanged 通知 handler，收到推送时回调 Detector.onUpstreamNotification。
      // 必须在 discoverServerTools 之前注册，确保订阅就绪后再拉取首份工具列表；
      // 闭包捕获 serverId，handler 内部即可定位到正确的 server。
      if (this.options.changeDetector) {
        serverConnection.client.setNotificationHandler('notifications/tools/list_changed', () => {
          this.options.changeDetector!.onUpstreamNotification(serverId);
        });
      }

      // Discover tools after successful connection
      await this.discoverServerTools(serverConnection);
    } catch (error) {
      serverConnection.status = ServerStatus.ERROR;
      serverConnection.lastError = error as Error;
      logger.logServerConnection(serverId, 'failed', {
        error: (error as Error).message,
      });
      throw error;
    }
  }

  private async connectStdioServer(serverConnection: ServerConnection): Promise<void> {
    const { config, client } = serverConnection;

    if (config.type !== 'stdio' && !('command' in config)) {
      throw new ConfigError(
        ErrorCode.INVALID_SERVER_CONFIG,
        'Invalid server type for stdio connection',
      );
    }

    // Prepare environment variables
    const env: Record<string, string> = {
      ...(Object.fromEntries(
        Object.entries(process.env).filter(([, value]) => value !== undefined),
      ) as Record<string, string>),
      ...config.env,
    };

    // Create stdio transport
    const transport = new StdioClientTransport({
      command: config.command,
      args: config.args || [],
      env,
    });

    // Connect the client
    await client.connect(transport);
  }

  private async connectSseServer(serverConnection: ServerConnection): Promise<void> {
    const { config, client } = serverConnection;

    if (config.type !== 'sse' || !('url' in config)) {
      throw new ConfigError(
        ErrorCode.INVALID_SERVER_CONFIG,
        'Invalid server config for SSE connection',
      );
    }

    const headers: Record<string, string> = { ...config.headers };
    const authProvider = createServerAuthProvider(config.auth);
    const transport = new SSEClientTransport(new URL(config.url), {
      requestInit: { headers },
      authProvider,
    });

    await client.connect(transport);
  }

  private async connectStreamingServer(serverConnection: ServerConnection): Promise<void> {
    const { config, client } = serverConnection;

    if (config.type !== 'streaming' || !('url' in config)) {
      throw new ConfigError(
        ErrorCode.INVALID_SERVER_CONFIG,
        'Invalid server config for streaming connection',
      );
    }

    const headers: Record<string, string> = { ...config.headers };
    const authProvider = createServerAuthProvider(config.auth);
    const transport = new StreamableHTTPClientTransport(new URL(config.url), {
      requestInit: { headers },
      authProvider,
    });

    await client.connect(transport);
  }

  private async discoverServerTools(serverConnection: ServerConnection): Promise<void> {
    const { id: serverId, client } = serverConnection;

    try {
      // Track the request
      if (this.messageTracker) {
        this.messageTracker(serverId, 'request', 'listTools', {});
      }

      const startTime = Date.now();
      const response = await client.listTools();
      const executionTime = Date.now() - startTime;

      const tools: Tool[] = response.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema as Record<string, unknown>,
        serverId,
      }));

      serverConnection.tools = tools;
      logger.logToolDiscovery(serverId, tools.length);

      // P5: 保存工具集快照供 UpstreamChangeDetector 比对（listChanged 实时 + 轮询兜底）。
      // 仅记录 name 集合，描述等非结构性变化不触发变更。
      this.options.changeDetector?.saveSnapshot(
        serverId,
        tools.map((t) => ({ name: t.name })),
      );

      // Track the response
      if (this.messageTracker) {
        this.messageTracker(serverId, 'response', 'listTools', {
          ...response,
          executionTime,
          toolCount: tools.length,
        });
      }
    } catch (error) {
      logger.error('Failed to discover tools for server', error as Error, {
        serverId,
      });
      serverConnection.tools = [];

      // Track the error response
      if (this.messageTracker) {
        this.messageTracker(serverId, 'response', 'listTools', {
          error: (error as Error).message,
          isError: true,
        });
      }
    }
  }

  getServerStatus(serverId: string): ServerStatus {
    const server = this.servers.get(serverId);
    return server?.status || ServerStatus.DISCONNECTED;
  }

  getAllServers(): Map<string, ServerConnection> {
    return new Map(this.servers);
  }

  async executeToolOnServer(
    serverId: string,
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    const server = this.servers.get(serverId);
    if (!server) {
      throw new ServiceError(ErrorCode.SERVER_UNAVAILABLE, `Server ${serverId} not found`);
    }

    if (server.status !== ServerStatus.CONNECTED) {
      throw new ConnectionError(
        ErrorCode.SERVER_DISCONNECTED,
        `Server ${serverId} is not connected (status: ${server.status})`,
      );
    }

    try {
      logger.debug('Executing tool on server', {
        serverId,
        toolName,
        args,
      });

      // Track the request
      if (this.messageTracker) {
        this.messageTracker(serverId, 'request', 'callTool', {
          name: toolName,
          arguments: args,
        });
      }

      const startTime = Date.now();
      // MCP SDK v2 行为变化：未知工具不再返回 isError:true 的 CallToolResult，
      // 而是抛 JSON-RPC -32602 (InvalidParams)。下方的 try/catch 将其捕获并在
      // messageTracker 中记为 isError，再 throw 给上游 executeToolWithRetry，
      // 后者转成 createErrorResult(isError:true)。因此本路径已兼容 v2。
      const callParams: {
        name: string;
        arguments: Record<string, unknown>;
        _meta?: Record<string, string>;
      } = {
        name: toolName,
        arguments: args,
      };
      // P6/SEP-414：从当前请求作用域（ALS）读取 trace context，注入到上游 callTool 的 _meta。
      // 无 context 时不加 _meta，保持无 trace 请求的零回归。
      const traceCtx = getCurrentTraceContext();
      if (hasTraceContext(traceCtx)) {
        callParams._meta = Object.fromEntries(
          Object.entries(traceCtx).filter(([, v]) => v !== undefined),
        ) as Record<string, string>;
      }
      const onprogress = getProgressCallback();
      const response = onprogress
        ? await server.client.callTool(callParams, { onprogress })
        : await server.client.callTool(callParams);
      const executionTime = Date.now() - startTime;

      logger.debug('Tool execution completed', {
        serverId,
        toolName,
        executionTime,
      });

      // Track the response
      if (this.messageTracker) {
        this.messageTracker(serverId, 'response', 'callTool', {
          ...response,
          executionTime,
        });
      }

      return response;
    } catch (error) {
      logger.error('Tool execution failed', error as Error, {
        serverId,
        toolName,
      });

      // Track the error response
      if (this.messageTracker) {
        this.messageTracker(serverId, 'response', 'callTool', {
          error: (error as Error).message,
          isError: true,
        });
      }

      throw error;
    }
  }

  /**
   * P5 MRTR + P7 出站翻译：带重试上下文（inputResponses + requestState）的工具调用。
   *
   * 复用 executeToolOnServer 的连接查找 / 状态校验 / message tracker / trace
   * _meta 注入逻辑；区别在于上游 callTool 的 request params 经
   * OutboundProtocolAdapter.translateCall 据 server.era 翻译：
   *   - modern era：inputResponses/requestState 是顶层成员（与 name/arguments 平级，
   *     由 retryParamsShape / RETRY_PARAMS_KEYS 定义），trace 三件套仍走 params._meta。
   *   - legacy era：仅 name/arguments（legacy 协议层无 MRTR/重试字段）。
   *
   * retryContext.requestState 是上游原始 state（即 HubState.upstreamRequestState），
   * 按规范字节级原样回传（modern era）。
   */
  async executeToolOnServerWithContext(
    serverId: string,
    toolName: string,
    args: Record<string, unknown>,
    retryContext: { inputResponses?: Record<string, unknown>; requestState?: string },
  ): Promise<unknown> {
    const server = this.servers.get(serverId);
    if (!server) {
      throw new ServiceError(ErrorCode.SERVER_UNAVAILABLE, `Server ${serverId} not found`);
    }

    if (server.status !== ServerStatus.CONNECTED) {
      throw new ConnectionError(
        ErrorCode.SERVER_DISCONNECTED,
        `Server ${serverId} is not connected (status: ${server.status})`,
      );
    }

    try {
      logger.debug('Executing tool on server (with retry context)', {
        serverId,
        toolName,
        args,
        hasInputResponses: retryContext.inputResponses !== undefined,
        hasRequestState: retryContext.requestState !== undefined,
      });

      // Track the request
      if (this.messageTracker) {
        this.messageTracker(serverId, 'request', 'callTool', {
          name: toolName,
          arguments: args,
          // 重试上下文透传给 message tracker（调试 MRTR 多轮用）
          ...(retryContext.inputResponses !== undefined
            ? { inputResponses: retryContext.inputResponses }
            : {}),
          ...(retryContext.requestState !== undefined
            ? { requestState: retryContext.requestState }
            : {}),
        });
      }

      const startTime = Date.now();
      // P7：经 OutboundProtocolAdapter.translateCall 据 upstream era 翻译 wire callTool params。
      // modern era：name/arguments/(requestState/inputResponses 顶层) —— 与原手写一致。
      // legacy era：仅 name/arguments（legacy 协议层无 input_required/重试字段），
      //   MRTR 字段在 legacy upstream 会被剥离（adapter 由 era 决策）。
      // trace _meta 是 backend 自有透传关注点（adapter 不处理 _meta），单独注入。
      const mrtr: { requestState?: string; inputResponses?: Record<string, unknown> } = {};
      if (retryContext.requestState !== undefined) {
        mrtr.requestState = retryContext.requestState;
      }
      if (retryContext.inputResponses !== undefined) {
        mrtr.inputResponses = retryContext.inputResponses;
      }
      const wire = this.outboundAdapter.translateCall(
        {
          toolName,
          arguments: args,
          ...(Object.keys(mrtr).length > 0 ? { mrtr } : {}),
        },
        server.era ?? 'modern',
      );
      // callTool params：adapter wire + trace _meta（backend 自有透传）
      const callParams: {
        name: string;
        arguments: unknown;
        _meta?: Record<string, string>;
        inputResponses?: Record<string, unknown>;
        requestState?: string;
      } = { ...wire };
      // P6/SEP-414：trace context 仍注入 _meta（与 executeToolOnServer 一致）
      const traceCtx = getCurrentTraceContext();
      if (hasTraceContext(traceCtx)) {
        callParams._meta = Object.fromEntries(
          Object.entries(traceCtx).filter(([, v]) => v !== undefined),
        ) as Record<string, string>;
      }
      // SDK callTool 要求 arguments 为 { [x: string]: unknown }（adapter wire 为 unknown 形态，
      // args 本身已是 Record<string, unknown>，断言还原）
      const onprogress = getProgressCallback();
      const response = await server.client.callTool(
        callParams as Parameters<typeof server.client.callTool>[0],
        {
          // P5 MRTR：允许上游返回 input_required 交回 Hub（而非被 auto-fulfil 驱动吞掉）。
          // 配合 ClientOptions.inputRequired.autoFulfill:false，上游的 input_required
          // 结果以 InputRequiredResult 形态回到这里，再由 group-service.ts 的
          // isInputRequiredResult 分支识别并 mint Hub state 中转给下游。
          allowInputRequired: true,
          ...(onprogress ? { onprogress } : {}),
        },
      );
      const executionTime = Date.now() - startTime;

      logger.debug('Tool execution (with retry context) completed', {
        serverId,
        toolName,
        executionTime,
      });

      // Track the response
      if (this.messageTracker) {
        this.messageTracker(serverId, 'response', 'callTool', {
          ...response,
          executionTime,
        });
      }

      return response;
    } catch (error) {
      logger.error('Tool execution (with retry context) failed', error as Error, {
        serverId,
        toolName,
      });

      // Track the error response
      if (this.messageTracker) {
        this.messageTracker(serverId, 'response', 'callTool', {
          error: (error as Error).message,
          isError: true,
        });
      }

      throw error;
    }
  }

  async getServerTools(serverId: string): Promise<Tool[]> {
    const server = this.servers.get(serverId);
    if (!server) {
      throw new ServiceError(ErrorCode.SERVER_UNAVAILABLE, `Server ${serverId} not found`);
    }

    if (server.status !== ServerStatus.CONNECTED) {
      return [];
    }

    return [...server.tools];
  }

  /**
   * P5: 重新向上游拉取工具列表，更新缓存并保存变更检测快照。
   *
   * 用于上游 listChanged 实时路径与轮询兜底路径：
   *   - 收到上游 listChanged → fanout 链路 → refreshGroupTools → 先 refetch 再 refreshTools。
   *   - 轮询 getToolsFn 直接调用本方法，获取最新工具供 Detector 比对。
   *
   * 返回最新工具列表（仅 name 视角供 Detector）。失败时记日志并返回空数组，
   * 不抛错（变更检测应单 server 故障隔离）。
   */
  async refetchServerTools(serverId: string): Promise<Tool[]> {
    const server = this.servers.get(serverId);
    if (!server || server.status !== ServerStatus.CONNECTED) {
      return [];
    }

    try {
      const response = await server.client.listTools();
      const tools: Tool[] = response.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema as Record<string, unknown>,
        serverId,
      }));
      server.tools = tools;
      logger.logToolDiscovery(serverId, tools.length);

      // P5: 同步推进快照，保证 listChanged 实时路径与轮询比对的是同一份「当前」值。
      this.options.changeDetector?.saveSnapshot(
        serverId,
        tools.map((t) => ({ name: t.name })),
      );
      return tools;
    } catch (error) {
      logger.warn('refetchServerTools 失败（保留旧缓存）', {
        serverId,
        error: (error as Error).message,
      });
      return [...server.tools];
    }
  }

  async shutdown(): Promise<void> {
    logger.info('Shutting down ServerManager');

    const SHUTDOWN_TIMEOUT = 5000; // 5 秒超时

    const shutdownPromises = Array.from(this.servers.values()).map(async (server) => {
      try {
        if (server.status === ServerStatus.CONNECTED) {
          // 使用 Promise.race 添加超时保护
          let timeoutId: NodeJS.Timeout | undefined;
          await Promise.race([
            server.client.close(),
            new Promise<void>((_, reject) => {
              timeoutId = setTimeout(() => reject(new Error('关闭超时')), SHUTDOWN_TIMEOUT);
              timeoutId.unref?.();
            }),
          ]);
          if (timeoutId) {
            clearTimeout(timeoutId);
          }
          logger.logServerConnection(server.id, 'disconnected');
        }
      } catch (error) {
        logger.error('Error during server shutdown', error as Error, {
          serverId: server.id,
        });

        // 强制清理：如果是 stdio transport，尝试杀死进程
        const errorMessage = (error as Error).message;
        if (errorMessage === '关闭超时' || errorMessage.includes('timeout')) {
          logger.warn('服务器关闭超时，尝试强制终止进程', {
            serverId: server.id,
          });

          // 尝试访问并杀死子进程
          try {
            const transport = (
              server.client as {
                transport?: {
                  process?: { kill: (sig: string) => void; pid?: number };
                };
              }
            ).transport;
            if (transport?.process) {
              transport.process.kill('SIGKILL');
              logger.warn('已强制杀死服务器进程', {
                serverId: server.id,
                pid: transport.process.pid,
              });
            } else {
              logger.warn('无法访问服务器进程，可能已经终止', {
                serverId: server.id,
              });
            }
          } catch (killError) {
            logger.error('强制终止进程失败', killError as Error, {
              serverId: server.id,
            });
          }
        }
      }
    });

    await Promise.allSettled(shutdownPromises);
    this.servers.clear();
    logger.info('ServerManager shutdown completed');
  }
}
