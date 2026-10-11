/**
 * CLI MCP服务器实现
 * 使用核心包的McpServiceManager和MCP SDK 的 serveStdio 入口
 */

import { McpServiceManager } from '@mcp-core/mcp-knot-core';
import { defaultCompatibilityOptions, InboundProtocolAdapter } from '@mcp-core/mcp-knot-protocol';
import { createCliLogger } from '@mcp-core/mcp-knot-share';
import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod/v4';

import { McpProtocolHandler } from '../protocol/mcp-protocol-handler.js';

import type { CliConfig } from '../types';
import type { CompatibilityOptions } from '@mcp-core/mcp-knot-protocol';
import type { CallToolResult } from '@modelcontextprotocol/server';
import type { StdioServerHandle } from '@modelcontextprotocol/server/stdio';

/**
 * CLI MCP服务器类
 * 聚合多个MCP服务并通过stdio提供统一的MCP接口
 *
 * 使用 MCP SDK v2 的 `serveStdio` 入口管理传输层：它负责 era 决策、传输层
 * 生命周期和消息分发，并以 `legacy: 'reject'` 拒绝 2025-era 旧协议，强制使用
 * 2026-07-28 现代协议。
 */
export class CliMcpServer {
  private server: McpServer | null = null;
  private stdioHandle: StdioServerHandle | null = null;
  private coreService: McpServiceManager | null = null;
  private protocolHandler: McpProtocolHandler | null = null;
  private config: CliConfig | null = null;
  private compat: CompatibilityOptions = defaultCompatibilityOptions;
  private isInitialized = false;
  private isStarted = false;
  private logger = createCliLogger({ component: 'McpServer' });

  /**
   * 创建工具处理器
   *
   * 返回 `CallToolResult`（MCP SDK v2 的 handler 结果形态）。`resultType` 是
   * wire-only 字段，由 SDK 的 codec 层在出站时统一添加，handler 不需要也不应该
   * 手动设置——这与迁移指南“Server-side authoring is era-independent”一致。
   *
   * v2 兼容性：handler 内部 try/catch 兜底，任何 throw（含底层未知工具的
   * -32602 rejection，经 protocolHandler 转译后仍可能抛）都被转成带
   * isError:true 的 CallToolResult，不会泄漏到 SDK 传输层。
   */
  private createToolHandler(toolName: string) {
    return async (args: Record<string, unknown> | undefined): Promise<CallToolResult> => {
      try {
        if (!this.protocolHandler) {
          throw new Error('协议处理器未初始化');
        }

        // 使用协议处理器执行工具调用
        return await this.protocolHandler.handleCallTool(toolName, args);
      } catch (error) {
        // 使用协议处理器处理错误
        if (this.protocolHandler) {
          return this.protocolHandler.handleProtocolError(error);
        }

        // 降级错误处理：保守地返回 isError:true，不向 SDK 抛出
        return {
          content: [
            {
              type: 'text',
              text: `工具执行失败: ${(error as Error).message}`,
            },
          ],
          isError: true,
        };
      }
    };
  }

  /**
   * 创建服务管理器（可被测试覆盖）
   */
  private createServiceManager(): McpServiceManager {
    return new McpServiceManager();
  }

  /**
   * 初始化CLI MCP服务器
   *
   * @param config CLI 配置
   * @param compat 协议兼容层选项（由启动 flag 映射而来），缺省走全开默认
   */
  async initialize(config: CliConfig, compat?: CompatibilityOptions): Promise<void> {
    if (this.isInitialized) {
      this.logger.warn('CLI MCP服务器已初始化，跳过重复初始化');
      return;
    }

    this.logger.info('开始初始化CLI MCP服务器');

    try {
      this.config = config;
      this.compat = compat ?? defaultCompatibilityOptions;

      // 创建和初始化核心服务管理器
      this.coreService = this.createServiceManager();
      await this.coreService.initializeFromConfig({
        servers: config.servers,
      });

      // 创建协议处理器
      this.protocolHandler = new McpProtocolHandler(this.coreService!);

      // 创建MCP服务器实例
      this.server = new McpServer(
        {
          name: 'mcp-knot-cli',
          version: '1.0.0',
        },
        {
          capabilities: {
            tools: {},
          },
          instructions: 'MCP Knot CLI - 聚合多个MCP服务的命令行界面',
        },
      );

      // 延迟注册工具到启动时
      // await this.registerTools();

      // serveStdio 在启动时负责创建并管理 StdioServerTransport，这里无需预创建。

      this.isInitialized = true;
      this.logger.info('CLI MCP服务器初始化完成');
    } catch (error) {
      this.logger.error('CLI MCP服务器初始化失败', error as Error);
      await this.cleanup();
      throw error;
    }
  }

  /**
   * 启动MCP服务器
   *
   * 通过 `serveStdio` 把 stdio 传输层交给 SDK 管理：工厂返回已注册工具的
   * `McpServer` 实例，SDK 在每次连接建立时调用工厂、启动传输层并完成 era
   * 协商。legacy 取值由 `InboundProtocolAdapter` 据兼容层配置决定（默认
   * inbound.enabled=true + legacyMode='shim' → stdio 下为 'serve'；当
   * `--no-legacy-inbound` 关闭入站时退化为 'reject'）。
   */
  async start(): Promise<void> {
    if (!this.isInitialized) {
      throw new Error('CLI MCP服务器必须先初始化');
    }

    if (this.isStarted) {
      this.logger.warn('CLI MCP服务器已启动');
      return;
    }

    this.logger.info('启动CLI MCP服务器');

    try {
      if (!this.server) {
        throw new Error('服务器未初始化');
      }

      // 在启动时注册工具（延迟到真正需要时）
      await this.registerTools();

      // 由协议兼容层适配器据当前配置解析 legacy 取值。
      // resolveLegacyMode 的返回类型是三种 transport 的并集（'stateless' |
      // 'serve' | 'reject'），但 stdio 仅接受 'serve' | 'reject'；kind='stdio'
      // 下适配器不可能返回 'stateless'，这里收窄到 stdio 的合法集合。
      const adapter = new InboundProtocolAdapter(this.compat);
      const legacy = adapter.resolveLegacyMode('stdio');
      const serverRef = this.server;
      this.stdioHandle = serveStdio(() => serverRef, {
        legacy: legacy === 'reject' ? 'reject' : 'serve',
        onerror: (error) => {
          this.logger.error('serveStdio 传输层错误', error);
        },
      });

      this.isStarted = true;
      this.logger.info('CLI MCP服务器启动成功，等待客户端连接...');
    } catch (error) {
      this.logger.error('CLI MCP服务器启动失败', error as Error);
      throw error;
    }
  }

  /**
   * 关闭服务器（带超时保护）
   */
  async shutdown(): Promise<void> {
    this.logger.info('开始关闭CLI MCP服务器');

    const SHUTDOWN_TIMEOUT = 5000; // 5 秒超时

    try {
      let timeoutId: NodeJS.Timeout | undefined;
      await Promise.race([
        this.performShutdown(),
        new Promise<void>((_, reject) => {
          timeoutId = setTimeout(() => reject(new Error('关闭超时')), SHUTDOWN_TIMEOUT);
          timeoutId.unref?.();
        }),
      ]);
      if (timeoutId) {
        clearTimeout(timeoutId);
      }

      this.logger.info('CLI MCP服务器关闭完成');
    } catch (error) {
      this.logger.error('关闭失败或超时，强制清理资源', error as Error);
      // 至少清理引用，防止内存泄漏
      await this.cleanup();
      throw error;
    }
  }

  /**
   * 执行实际的关闭逻辑
   */
  private async performShutdown(): Promise<void> {
    try {
      // serveStdio 的 handle 负责 teardown：关闭 pinned 实例与底层传输层。
      if (this.stdioHandle) {
        await this.stdioHandle.close();
      } else if (this.server) {
        // 兜底：未走 serveStdio 路径（理论上不会发生）时直接关闭 server。
        await this.server.close();
      }

      // 关闭核心服务
      if (this.coreService) {
        await this.coreService.shutdown();
        this.coreService = null;
      }

      await this.cleanup();
    } catch (error) {
      this.logger.error('CLI MCP服务器关闭时出错', error as Error);
      throw error;
    }
  }

  /**
   * 注册工具到MCP服务器
   */
  private async registerTools(): Promise<void> {
    if (!this.server || !this.coreService) {
      throw new Error('服务器或核心服务未初始化');
    }

    try {
      // 获取所有可用工具
      const toolInfos = await this.coreService.getAllTools();

      this.logger.debug(`注册 ${toolInfos.length} 个工具`);

      // 为每个工具注册处理器
      for (const toolInfo of toolInfos) {
        const toolHandler = this.createToolHandler(toolInfo.name);
        this.server!.registerTool(
          toolInfo.name,
          {
            description: toolInfo.description || `来自服务器 ${toolInfo.serverId} 的工具`,
            inputSchema: z.object({
              // 使用通用的输入模式，允许任意参数
              args: z.record(z.string(), z.unknown()).optional(),
            }),
          },
          toolHandler,
        );
      }

      this.logger.debug('所有工具注册完成');
    } catch (error) {
      this.logger.error('注册工具失败', error as Error);
      throw error;
    }
  }

  /**
   * 清理资源（显式清理所有引用）
   */
  private async cleanup(): Promise<void> {
    try {
      // 1. 显式清理 stdioHandle 引用
      this.stdioHandle = null;

      // 2. 清理 protocol handler 引用
      // （McpProtocolHandler 没有 cleanup 方法，只需置空引用）
      this.protocolHandler = null;

      // 3. 清理 server 引用
      this.server = null;

      // 4. 清理 config 引用
      this.config = null;

      // 5. 重置状态标志
      this.isInitialized = false;
      this.isStarted = false;

      // 6. 提示 GC（如果在开发环境且启用了 --expose-gc）
      if (global.gc) {
        try {
          global.gc();
          this.logger.debug('已触发垃圾回收');
        } catch (_error) {
          // GC 调用失败不影响其他清理逻辑
          this.logger.debug('垃圾回收调用失败（可能未启用 --expose-gc）');
        }
      }

      this.logger.debug('资源清理完成');
    } catch (error) {
      this.logger.error('清理资源时出错', error as Error);
    }
  }

  /**
   * 获取服务器状态
   */
  getStatus() {
    return {
      initialized: this.isInitialized,
      started: this.isStarted,
      coreServiceStatus: this.coreService?.getServiceStatus(),
      protocolHandlerStatus: this.protocolHandler?.getStatus(),
      config: this.config
        ? {
            serverCount: Object.keys(this.config.servers).length,
            loggingLevel: this.config.logging.level,
          }
        : null,
    };
  }
}
