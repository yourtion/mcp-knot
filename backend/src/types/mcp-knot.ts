import type { ServerConfig } from '@mcp-core/mcp-knot-share';
import type { Client } from '@modelcontextprotocol/client';

// P7 出站 era：与 protocol 包 UpstreamEra 对齐的本地别名（'modern' | 'legacy'）。
// 由 ServerManager 在 client.connect 后调 SDK client.getProtocolEra() 探测并缓存。
export type UpstreamEra = 'modern' | 'legacy';

// Server Management Types
export enum ServerStatus {
  CONNECTING = 'connecting',
  CONNECTED = 'connected',
  DISCONNECTED = 'disconnected',
  ERROR = 'error',
}

export interface Tool {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  serverId: string;
}

export interface ServerConnection {
  id: string;
  config: ServerConfig;
  client: Client;
  status: ServerStatus;
  lastConnected?: Date;
  lastError?: Error;
  tools: Tool[];
  reconnectAttempts: number;
  /**
   * P7：探测到的上游协议 era。
   * connect 成功后由 SDK client.getProtocolEra() 设置（'modern' | 'legacy'）；
   * 探测失败/未完成时为 undefined（按 modern 假设处理，保持现有链路无回归）。
   */
  era?: UpstreamEra;
}

export interface ServerManager {
  initialize(): Promise<void>;
  getServerStatus(serverId: string): ServerStatus;
  getAllServers(): Map<string, ServerConnection>;
  executeToolOnServer(
    serverId: string,
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<unknown>;
  /**
   * P5 MRTR：带重试上下文的工具调用。
   * 把 retryContext.inputResponses / retryContext.requestState 注入上游 callTool 的
   * request params 顶层字段（与 name/arguments 平级），继续本轮多轮中转。
   */
  executeToolOnServerWithContext(
    serverId: string,
    toolName: string,
    args: Record<string, unknown>,
    retryContext: { inputResponses?: Record<string, unknown>; requestState?: string },
  ): Promise<unknown>;
  getServerTools(serverId: string): Promise<Tool[]>;
  shutdown(): Promise<void>;
}

// Group Management Types
export interface Group {
  id: string;
  name: string;
  description?: string;
  servers: string[];
  tools: string[];
  resolvedTools?: Tool[];
}

export interface GroupRuntime {
  config: Group;
  availableServers: string[];
  availableTools: Tool[];
  lastUpdated: Date;
}

export interface GroupManager {
  initialize(): Promise<void>;
  getGroup(groupId: string): Group | undefined;
  getAllGroups(): Map<string, Group>;
  getGroupTools(groupId: string): Promise<Tool[]>;
  validateToolAccess(groupId: string, toolName: string): boolean;
  getGroupServers(groupId: string): string[];
  findToolInGroup(
    groupId: string,
    toolName: string,
  ): Promise<{ tool: Tool; serverId: string } | null>;
  getAvailableGroupServers(groupId: string): string[];
  getGroupStats(groupId: string): {
    totalServers: number;
    availableServers: number;
    configuredTools: number;
  };
  validateGroupHealth(groupId: string): Promise<{ isHealthy: boolean; issues: string[] }>;
  getAllGroupsHealth(): Promise<Map<string, { isHealthy: boolean; issues: string[] }>>;
  getGroupToolsByServer(groupId: string): Promise<Map<string, Tool[]>>;
}

// Tool Management Types
export interface ToolContent {
  type: 'text';
  text: string;
}

export interface ToolResult {
  content: ToolContent[];
  isError?: boolean;
}

export interface ToolManager {
  getToolsForGroup(groupId: string): Promise<Tool[]>;
  executeTool(
    groupId: string,
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<ToolResult>;
  findToolServer(toolName: string, groupId: string): string | undefined;
  validateToolArgs(toolName: string, args: Record<string, unknown>): boolean;
}

// MCP Knot Service Types
export interface McpKnotService {
  initialize(): Promise<void>;
  listTools(groupId?: string): Promise<Tool[]>;
  callTool(toolName: string, args: Record<string, unknown>, groupId?: string): Promise<ToolResult>;
  getGroupInfo(groupId: string): Group | undefined;
  getServerHealth(): Map<string, ServerStatus>;
  shutdown(): Promise<void>;
}
