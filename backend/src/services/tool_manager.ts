import { ErrorCode, ServiceError } from '@mcp-core/mcp-knot-core';

import { logger } from '../utils/logger.js';
import { validateToolArgsWithSchema } from './tool-arg-validator.js';
import { transformToolResult } from './tool-result-transform.js';

import type {
  Group,
  GroupManager,
  ToolManager as IToolManager,
  ServerManager,
  Tool,
  ToolResult,
} from '../types/mcp-knot.js';
import type { ApiToolIntegrationService } from './api_tool_integration_service.js';

export class ToolManager implements IToolManager {
  private toolCache: Map<string, { tools: Tool[]; lastUpdated: Date }> = new Map();
  private readonly CACHE_TTL_MS = 30000; // 30 seconds cache TTL

  constructor(
    private serverManager: ServerManager,
    private groupManager: GroupManager,
    private apiToolService?: ApiToolIntegrationService,
  ) {}

  async getToolsForGroup(groupId: string): Promise<Tool[]> {
    logger.debug('Getting tools for group', { groupId });

    try {
      // Check cache first
      const cached = this.getCachedTools(groupId);
      if (cached) {
        logger.debug('Returning cached tools for group', {
          groupId,
          toolCount: cached.length,
        });
        return cached;
      }

      // Get tools from group manager (MCP servers)
      const mcpTools = await this.groupManager.getGroupTools(groupId);

      // Get API tools if service is available
      let apiTools: Tool[] = [];
      if (this.apiToolService) {
        try {
          apiTools = await this.apiToolService.getApiTools();
          logger.debug('Retrieved API tools', { count: apiTools.length });
        } catch (error) {
          logger.warn('Failed to get API tools', {
            error: (error as Error).message,
          });
          // Continue without API tools
        }
      }

      // Combine MCP tools and API tools
      const allTools = [...mcpTools, ...apiTools];

      // Cache the results
      this.cacheTools(groupId, allTools);

      logger.debug('Retrieved and cached tools for group', {
        groupId,
        mcpToolCount: mcpTools.length,
        apiToolCount: apiTools.length,
        totalToolCount: allTools.length,
      });

      return allTools;
    } catch (error) {
      logger.error('Failed to get tools for group', error as Error, {
        groupId,
      });
      throw error;
    }
  }

  async executeTool(
    groupId: string,
    toolName: string,
    args: Record<string, unknown>,
    requestedServerId?: string,
  ): Promise<ToolResult> {
    const executionId = `${groupId}-${toolName}-${Date.now()}`;
    logger.info('Starting tool execution', {
      executionId,
      groupId,
      toolName,
      args,
    });

    try {
      // Step 1: Validate group exists and is accessible
      const groupValidation = await this.validateGroupAccess(groupId);
      if (!groupValidation.isValid) {
        const error = new Error(groupValidation.error || `Invalid group '${groupId}'`);
        logger.warn('Group validation failed', {
          executionId,
          groupId,
          error: error.message,
        });
        return this.createErrorResult(error.message);
      }

      // Step 2: Validate tool access in group
      if (!this.groupManager.validateToolAccess(groupId, toolName)) {
        const error = new Error(`Tool '${toolName}' is not accessible in group '${groupId}'`);
        logger.warn('Tool access denied', { executionId, groupId, toolName });
        return this.createErrorResult(error.message);
      }

      // Step 3: Route tool to appropriate server
      const routingResult = await this.routeToolExecution(
        groupId,
        toolName,
        executionId,
        requestedServerId,
      );
      if (!routingResult.success) {
        logger.warn('Tool routing failed', {
          executionId,
          groupId,
          toolName,
          error: routingResult.error,
        });
        return this.createErrorResult(routingResult.error);
      }

      const { serverId, tool, isApiTool } = routingResult;

      // Step 4: Validate tool arguments against schema
      const argsValidation = validateToolArgsWithSchema(tool, args);
      if (!argsValidation.isValid) {
        const error = new Error(
          `Invalid arguments for tool '${toolName}': ${argsValidation.error}`,
        );
        logger.warn('Tool argument validation failed', {
          executionId,
          groupId,
          toolName,
          args,
          error: error.message,
        });
        return this.createErrorResult(error.message);
      }

      // Step 5: Execute the tool with comprehensive error handling
      let result: ToolResult;
      if (isApiTool && this.apiToolService) {
        // Execute API tool
        result = await this.apiToolService.executeApiTool(toolName, args);
      } else {
        // Execute MCP tool
        result = await this.executeToolWithRetry(serverId, toolName, args, executionId);
      }

      logger.info('Tool execution completed successfully', {
        executionId,
        groupId,
        toolName,
        serverId,
      });

      return result;
    } catch (error) {
      logger.error('Unexpected error during tool execution', error as Error, {
        executionId,
        groupId,
        toolName,
        args,
      });

      return this.createErrorResult(`Unexpected error: ${(error as Error).message}`);
    }
  }

  private async routeToolExecution(
    groupId: string,
    toolName: string,
    executionId: string,
    requestedServerId?: string,
  ): Promise<
    | { success: true; serverId: string; tool: Tool; isApiTool?: boolean }
    | { success: false; error: string }
  > {
    logger.debug('Routing tool execution', { executionId, groupId, toolName });

    try {
      // Automatic routing keeps API precedence; an explicit MCP target cannot
      // be replaced by a same-named API tool.
      if (
        (requestedServerId === undefined || requestedServerId === 'api-tools') &&
        this.apiToolService?.isApiTool(toolName)
      ) {
        const apiTool = this.apiToolService.getApiToolDefinition(toolName);
        if (apiTool) {
          logger.debug('Tool routing successful (API tool)', {
            executionId,
            toolName,
            serverId: 'api-tools',
            groupId,
          });

          return {
            success: true,
            serverId: 'api-tools',
            tool: apiTool,
            isApiTool: true,
          };
        }
      }

      // A pinned target must belong to the group. Never fall back to another
      // server if it disconnected or no longer exposes the selected tool.
      if (
        requestedServerId !== undefined &&
        !this.groupManager.getGroup(groupId)?.servers.includes(requestedServerId)
      ) {
        return {
          success: false,
          error: `Server '${requestedServerId}' is not in group '${groupId}'`,
        };
      }
      const serverId = requestedServerId ?? this.findToolServer(toolName, groupId);
      if (!serverId) {
        return {
          success: false,
          error: `Tool '${toolName}' not found in group '${groupId}'`,
        };
      }

      // Verify server is still connected
      const serverConnection = this.serverManager.getAllServers().get(serverId);
      if (!serverConnection || serverConnection.status !== 'connected') {
        return {
          success: false,
          error: `Server '${serverId}' is not available (status: ${
            serverConnection?.status || 'not found'
          })`,
        };
      }

      // Get the tool definition
      const tool = serverConnection.tools.find((t) => t.name === toolName);
      if (!tool) {
        return {
          success: false,
          error: `Tool '${toolName}' definition not found on server '${serverId}'`,
        };
      }

      logger.debug('Tool routing successful (MCP tool)', {
        executionId,
        toolName,
        serverId,
        groupId,
      });

      return { success: true, serverId, tool, isApiTool: false };
    } catch (error) {
      logger.error('Error during tool routing', error as Error, {
        executionId,
        groupId,
        toolName,
      });

      return {
        success: false,
        error: `Routing failed: ${(error as Error).message}`,
      };
    }
  }

  private async executeToolWithRetry(
    serverId: string,
    toolName: string,
    args: Record<string, unknown>,
    executionId: string,
    maxRetries: number = 2,
  ): Promise<ToolResult> {
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        logger.debug('Attempting tool execution', {
          executionId,
          serverId,
          toolName,
          attempt,
          maxRetries,
        });

        const result = await this.serverManager.executeToolOnServer(serverId, toolName, args);

        logger.debug('Tool execution attempt successful', {
          executionId,
          serverId,
          toolName,
          attempt,
        });

        return transformToolResult(result);
      } catch (error) {
        lastError = error as Error;
        logger.warn('Tool execution attempt failed', {
          executionId,
          serverId,
          toolName,
          attempt,
          maxRetries,
          error: lastError.message,
        });

        // Check if this is a retryable error
        if (!this.isRetryableError(lastError) || attempt === maxRetries) {
          break;
        }

        // Wait before retry (exponential backoff)
        const delay = Math.min(1000 * 2 ** (attempt - 1), 5000);
        logger.debug('Waiting before retry', {
          executionId,
          attempt,
          delay,
        });
        await new Promise((resolve) => {
          setTimeout(resolve, delay);
        });
      }
    }

    // All retries failed
    const errorMessage = `Tool execution failed after ${maxRetries} attempts: ${
      lastError?.message || 'Unknown error'
    }`;

    logger.error(
      'Tool execution failed after all retries',
      lastError || new Error('Unknown error'),
      {
        executionId,
        serverId,
        toolName,
        maxRetries,
        finalError: lastError?.message,
      },
    );

    return this.createErrorResult(errorMessage);
  }

  private isRetryableError(error: Error): boolean {
    const retryablePatterns = [/connection/i, /timeout/i, /network/i, /temporary/i, /unavailable/i];

    return retryablePatterns.some((pattern) => pattern.test(error.message));
  }

  // 统一的错误结果构造。MCP SDK v2 的未知工具 rejection (-32602) 在
  // executeToolWithRetry 的 catch 中变成 lastError，最终经此方法转成
  // isError:true 的 ToolResult —— 与 v1 的"isError 路径"行为一致。
  private createErrorResult(message: string): ToolResult {
    return {
      content: [{ type: 'text', text: message }],
      isError: true,
    };
  }

  findToolServer(toolName: string, groupId: string): string | undefined {
    logger.debug('Finding server for tool', { toolName, groupId });

    try {
      // Get the group configuration
      const group = this.groupManager.getGroup(groupId);
      if (!group) {
        logger.debug('Group not found', { groupId });
        return undefined;
      }

      // Get available servers for the group
      const availableServers = this.groupManager.getGroupServers(groupId);
      if (availableServers.length === 0) {
        logger.debug('No available servers in group', { groupId });
        return undefined;
      }

      // Search through each server's tools
      for (const serverId of availableServers) {
        try {
          const serverConnection = this.serverManager.getAllServers().get(serverId);
          if (!serverConnection || serverConnection.status !== 'connected') {
            continue;
          }

          // Check if this server has the tool
          const hasTool = serverConnection.tools.some((tool) => tool.name === toolName);
          if (hasTool) {
            logger.debug('Found tool on server', {
              toolName,
              serverId,
              groupId,
            });
            return serverId;
          }
        } catch (error) {
          logger.warn('Error checking server for tool', {
            serverId,
            toolName,
            error: (error as Error).message,
          });
        }
      }

      logger.debug('Tool not found on any server in group', {
        toolName,
        groupId,
        searchedServers: availableServers,
      });
      return undefined;
    } catch (error) {
      logger.error('Error finding tool server', error as Error, {
        toolName,
        groupId,
      });
      return undefined;
    }
  }

  validateToolArgs(toolName: string, args: Record<string, unknown>): boolean {
    logger.debug('Validating tool arguments', { toolName, args });

    try {
      // Find the tool definition to get its schema
      const tool = this.findToolDefinition(toolName);
      if (!tool) {
        logger.debug('Tool definition not found for validation', { toolName });
        // If we can't find the tool definition, we'll allow the execution
        // and let the server handle validation
        return true;
      }

      const validation = validateToolArgsWithSchema(tool, args);
      return validation.isValid;
    } catch (error) {
      logger.error('Error validating tool arguments', error as Error, {
        toolName,
        args,
      });
      // On validation error, allow execution and let server handle it
      return true;
    }
  }

  private getCachedTools(groupId: string): Tool[] | null {
    const cached = this.toolCache.get(groupId);
    if (!cached) {
      return null;
    }

    const now = new Date();
    const age = now.getTime() - cached.lastUpdated.getTime();

    if (age > this.CACHE_TTL_MS) {
      // Cache expired
      this.toolCache.delete(groupId);
      logger.debug('Tool cache expired for group', { groupId, age });
      return null;
    }

    return cached.tools;
  }

  private cacheTools(groupId: string, tools: Tool[]): void {
    this.toolCache.set(groupId, {
      tools: [...tools], // Create a copy to avoid mutations
      lastUpdated: new Date(),
    });

    logger.debug('Cached tools for group', {
      groupId,
      toolCount: tools.length,
    });
  }

  private findToolDefinition(toolName: string): Tool | undefined {
    // Search through all cached tools to find the definition
    for (const cached of this.toolCache.values()) {
      const tool = cached.tools.find((t) => t.name === toolName);
      if (tool) {
        return tool;
      }
    }

    // If not in cache, search through all connected servers
    const allServers = this.serverManager.getAllServers();
    for (const server of allServers.values()) {
      if (server.status === 'connected') {
        const tool = server.tools.find((t) => t.name === toolName);
        if (tool) {
          return tool;
        }
      }
    }

    return undefined;
  }

  // Error handling and monitoring methods
  async getExecutionHealth(): Promise<{
    cacheHealth: {
      totalGroups: number;
      totalTools: number;
      oldestCache: Date | null;
      newestCache: Date | null;
    };
    serverHealth: Map<string, string>;
    groupHealth: Map<string, boolean>;
  }> {
    logger.debug('Getting execution health status');

    try {
      const cacheHealth = this.getCacheStats();
      const serverHealth = new Map<string, string>();
      const groupHealth = new Map<string, boolean>();

      // Get server health
      const allServers = this.serverManager.getAllServers();
      for (const [serverId, server] of allServers) {
        serverHealth.set(serverId, server.status);
      }

      // Get group health
      const allGroups = this.groupManager.getAllGroups();
      for (const [groupId] of allGroups) {
        try {
          const validation = await this.validateGroupAccess(groupId);
          groupHealth.set(groupId, validation.isValid);
        } catch (_error) {
          groupHealth.set(groupId, false);
        }
      }

      return {
        cacheHealth,
        serverHealth,
        groupHealth,
      };
    } catch (error) {
      logger.error('Error getting execution health', error as Error);
      throw error;
    }
  }

  async refreshToolCache(groupId?: string): Promise<void> {
    if (groupId) {
      logger.info('Refreshing tool cache for group', { groupId });
      this.clearCacheForGroup(groupId);
      // Pre-populate cache
      try {
        await this.getToolsForGroup(groupId);
        logger.info('Tool cache refreshed for group', { groupId });
      } catch (error) {
        logger.error('Failed to refresh cache for group', error as Error, {
          groupId,
        });
        throw error;
      }
    } else {
      logger.info('Refreshing all tool caches');
      this.clearCache();
      // Pre-populate cache for all groups
      const allGroups = this.groupManager.getAllGroups();
      const refreshPromises = Array.from(allGroups.keys()).map(async (gId) => {
        try {
          await this.getToolsForGroup(gId);
        } catch (error) {
          logger.warn('Failed to refresh cache for group during bulk refresh', {
            groupId: gId,
            error: (error as Error).message,
          });
        }
      });

      await Promise.allSettled(refreshPromises);
      logger.info('All tool caches refreshed');
    }
  }

  // Additional utility methods for cache management
  clearCache(): void {
    this.toolCache.clear();
    logger.info('Tool cache cleared');
  }

  clearCacheForGroup(groupId: string): void {
    this.toolCache.delete(groupId);
    logger.debug('Tool cache cleared for group', { groupId });
  }

  getCacheStats(): {
    totalGroups: number;
    totalTools: number;
    oldestCache: Date | null;
    newestCache: Date | null;
  } {
    let totalTools = 0;
    let oldestCache: Date | null = null;
    let newestCache: Date | null = null;

    for (const cached of this.toolCache.values()) {
      totalTools += cached.tools.length;

      if (!oldestCache || cached.lastUpdated < oldestCache) {
        oldestCache = cached.lastUpdated;
      }

      if (!newestCache || cached.lastUpdated > newestCache) {
        newestCache = cached.lastUpdated;
      }
    }

    return {
      totalGroups: this.toolCache.size,
      totalTools,
      oldestCache,
      newestCache,
    };
  }

  // Group-based filtering and access control methods
  async getToolsByServer(groupId: string): Promise<Map<string, Tool[]>> {
    logger.debug('Getting tools by server for group', { groupId });

    try {
      // Get the group and its servers
      const group = this.groupManager.getGroup(groupId);
      if (!group) {
        throw new ServiceError(ErrorCode.GROUP_NOT_FOUND, `Group ${groupId} not found`);
      }

      const toolsByServer = new Map<string, Tool[]>();
      const availableServers = this.groupManager.getGroupServers(groupId);

      // Get tools from each server in the group
      for (const serverId of availableServers) {
        try {
          const serverTools = await this.serverManager.getServerTools(serverId);
          // Apply group-based filtering
          const filteredTools = this.filterToolsForGroup(group, serverTools);
          toolsByServer.set(serverId, filteredTools);
        } catch (error) {
          logger.warn('Failed to get tools from server', {
            serverId,
            groupId,
            error: (error as Error).message,
          });
          toolsByServer.set(serverId, []);
        }
      }

      return toolsByServer;
    } catch (error) {
      logger.error('Failed to get tools by server for group', error as Error, {
        groupId,
      });
      throw error;
    }
  }

  private filterToolsForGroup(group: Group, tools: Tool[]): Tool[] {
    // If group has specific tools listed, filter to only those tools
    if (group.tools.length > 0) {
      return tools.filter((tool) => group.tools.includes(tool.name));
    }
    // If no specific tools listed, return all tools
    return tools;
  }

  async getAvailableToolNames(groupId: string): Promise<string[]> {
    logger.debug('Getting available tool names for group', { groupId });

    try {
      const tools = await this.getToolsForGroup(groupId);
      const toolNames = tools.map((tool) => tool.name);

      logger.debug('Retrieved tool names for group', {
        groupId,
        toolCount: toolNames.length,
        toolNames,
      });

      return toolNames;
    } catch (error) {
      logger.error('Failed to get tool names for group', error as Error, {
        groupId,
      });
      throw error;
    }
  }

  async isToolAvailableInGroup(groupId: string, toolName: string): Promise<boolean> {
    logger.debug('Checking tool availability in group', { groupId, toolName });

    try {
      // First check access control
      if (!this.groupManager.validateToolAccess(groupId, toolName)) {
        logger.debug('Tool access denied by group policy', {
          groupId,
          toolName,
        });
        return false;
      }

      // Then check if tool actually exists in the group
      const serverId = this.findToolServer(toolName, groupId);
      const isAvailable = serverId !== undefined;

      logger.debug('Tool availability check result', {
        groupId,
        toolName,
        isAvailable,
        serverId,
      });

      return isAvailable;
    } catch (error) {
      logger.error('Error checking tool availability', error as Error, {
        groupId,
        toolName,
      });
      return false;
    }
  }

  async getToolDetails(groupId: string, toolName: string): Promise<Tool | null> {
    logger.debug('Getting tool details', { groupId, toolName });

    try {
      // Check if tool is available in group
      if (!(await this.isToolAvailableInGroup(groupId, toolName))) {
        logger.debug('Tool not available in group', { groupId, toolName });
        return null;
      }

      // Get all tools for the group and find the specific tool
      const tools = await this.getToolsForGroup(groupId);
      const tool = tools.find((t) => t.name === toolName);

      if (tool) {
        logger.debug('Found tool details', {
          groupId,
          toolName,
          serverId: tool.serverId,
        });
      } else {
        logger.debug('Tool details not found', { groupId, toolName });
      }

      return tool || null;
    } catch (error) {
      logger.error('Error getting tool details', error as Error, {
        groupId,
        toolName,
      });
      return null;
    }
  }

  async validateGroupAccess(groupId: string): Promise<{
    isValid: boolean;
    error?: string;
    serverCount: number;
    toolCount: number;
  }> {
    logger.debug('Validating group access', { groupId });

    try {
      // Check if group exists
      const group = this.groupManager.getGroup(groupId);
      if (!group) {
        return {
          isValid: false,
          error: `Group '${groupId}' not found`,
          serverCount: 0,
          toolCount: 0,
        };
      }

      // Get available servers
      const availableServers = this.groupManager.getGroupServers(groupId);
      if (availableServers.length === 0) {
        return {
          isValid: false,
          error: `No servers available in group '${groupId}'`,
          serverCount: 0,
          toolCount: 0,
        };
      }

      // Get available tools
      const tools = await this.getToolsForGroup(groupId);

      logger.debug('Group access validation result', {
        groupId,
        isValid: true,
        serverCount: availableServers.length,
        toolCount: tools.length,
      });

      return {
        isValid: true,
        serverCount: availableServers.length,
        toolCount: tools.length,
      };
    } catch (error) {
      logger.error('Error validating group access', error as Error, {
        groupId,
      });

      return {
        isValid: false,
        error: `Validation failed: ${(error as Error).message}`,
        serverCount: 0,
        toolCount: 0,
      };
    }
  }
}
