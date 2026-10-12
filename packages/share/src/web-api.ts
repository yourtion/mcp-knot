/**
 * Web API相关的类型定义
 */

// Import config types for internal use (these are exported via config/types/index.ts)
import type { ApiToolConfig, Group } from './config/types/index.js';

// Re-export Group for backward compatibility (was GroupInfo in legacy config.ts)
export type { Group };
/** @deprecated Use Group instead */
export type GroupInfo = Group;

// ============================================================================
// 认证相关类型
// ============================================================================

/**
 * 用户信息
 */
export interface User {
  /** 用户ID */
  id: string;
  /** 用户名 */
  username: string;
  /** 用户角色 */
  role: string;
  /** 创建时间 */
  createdAt: string;
  /** 最后登录时间 */
  lastLogin?: string;
}

/**
 * 登录请求
 */
export interface LoginRequest {
  /** 用户名 */
  username: string;
  /** 密码 */
  password: string;
}

/**
 * 登录响应
 */
export interface LoginResponse {
  /** 访问token */
  token: string;
  /** 刷新token */
  refreshToken: string;
  /** 用户信息 */
  user: User;
}

/**
 * Token刷新请求
 */
export interface RefreshTokenRequest {
  /** 刷新token */
  refreshToken: string;
}

/**
 * Token刷新响应
 */
export interface RefreshTokenResponse {
  /** 新的访问token */
  token: string;
}

// ============================================================================
// 服务器管理相关类型
// ============================================================================

/**
 * 服务器状态枚举
 */
export enum ServerStatus {
  CONNECTING = 'connecting',
  CONNECTED = 'connected',
  DISCONNECTED = 'disconnected',
  ERROR = 'error',
}

/**
 * Web服务器配置
 */
export interface WebServerConfig {
  /** 服务器类型 */
  type: 'stdio' | 'sse' | 'websocket';
  /** 启动命令 */
  command: string;
  /** 命令参数 */
  args: string[];
  /** 环境变量 */
  env?: Record<string, string>;
  /** 工作目录 */
  cwd?: string;
  /** 超时时间（毫秒） */
  timeout?: number;
}

/**
 * 服务器信息
 */
export interface ServerInfo {
  /** 服务器ID */
  id: string;
  /** 服务器名称 */
  name: string;
  /** 服务器类型 */
  type: 'stdio' | 'sse' | 'websocket';
  /** 连接状态 */
  status: ServerStatus;
  /** 服务器配置 */
  config: WebServerConfig;
  /** 可用工具列表 */
  tools: ToolInfo[];
  /** 最后连接时间 */
  lastConnected?: string;
  /** 最后错误信息 */
  lastError?: string;
  /** 重连尝试次数 */
  reconnectAttempts: number;
}

/**
 * 创建服务器请求
 */
export interface CreateServerRequest {
  /** 服务器ID */
  id: string;
  /** 服务器名称 */
  name: string;
  /** 服务器配置 */
  config: WebServerConfig;
}

/**
 * 更新服务器请求
 */
export interface UpdateServerRequest {
  /** 服务器名称 */
  name?: string;
  /** 服务器配置 */
  config: WebServerConfig;
}

/**
 * 服务器列表响应
 */
export interface ServerListResponse {
  /** 服务器列表 */
  servers: ServerInfo[];
}

// ============================================================================
// 工具管理相关类型
// ============================================================================

/**
 * JSON Schema属性定义
 */
export interface JsonSchemaProperty {
  type: 'string' | 'number' | 'boolean' | 'object' | 'array' | 'null';
  description?: string;
  default?: unknown;
  enum?: unknown[];
  format?: string;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  items?: JsonSchemaProperty;
  properties?: Record<string, JsonSchemaProperty>;
  required?: string[];
  additionalProperties?: boolean | JsonSchemaProperty;
}

/**
 * JSON Schema定义
 */
export interface JsonSchema {
  type: 'object';
  properties: Record<string, JsonSchemaProperty>;
  required?: string[];
  additionalProperties?: boolean;
  description?: string;
}

/**
 * 工具信息
 */
export interface ToolInfo {
  /** 工具名称 */
  name: string;
  /** 工具描述 */
  description: string;
  /** 所属服务器ID */
  serverId: string;
  /** 所属服务器名称 */
  serverName: string;
  /** 输入参数schema */
  inputSchema: JsonSchema;
  /** 工具状态 */
  status: 'available' | 'unavailable';
}

/**
 * 工具执行请求
 */
export interface ToolExecuteRequest {
  /** 服务器ID（可选） */
  serverId?: string;
  /** 组ID（可选） */
  groupId?: string;
  /** 执行参数 */
  arguments: Record<string, unknown>;
}

/**
 * 工具执行结果内容
 */
export interface ToolResultContent {
  type: 'text';
  text: string;
}

/**
 * 工具执行结果
 */
export interface ToolResult {
  /** 结果内容 */
  content: ToolResultContent[];
  /** 是否为错误 */
  isError?: boolean;
}

/**
 * 工具执行响应
 */
export interface ToolExecuteResponse {
  /** 执行是否成功 */
  success: boolean;
  /** 执行结果 */
  result?: ToolResult;
  /** 错误信息 */
  error?: string;
  /** 执行时间（毫秒） */
  executionTime: number;
}

/**
 * 工具列表响应
 */
export interface ToolListResponse {
  /** 工具列表 */
  tools: ToolInfo[];
}

/**
 * 工具执行历史
 */
export interface ToolExecution {
  /** 执行ID */
  id: string;
  /** 工具名称 */
  toolName: string;
  /** 服务器ID */
  serverId: string;
  /** 执行参数 */
  arguments: Record<string, unknown>;
  /** 执行结果 */
  result: ToolResult;
  /** 执行时间戳 */
  timestamp: string;
  /** 执行耗时（毫秒） */
  executionTime: number;
}

/**
 * 工具复杂度估算
 */
export interface ToolComplexityEstimation {
  /** 复杂度级别 */
  complexity: 'simple' | 'medium' | 'complex';
  /** 参数数量 */
  parameterCount: number;
  /** 必需参数数量 */
  requiredParameterCount: number;
  /** 预估执行时间 */
  estimatedExecutionTime: 'fast' | 'medium' | 'slow';
}

// ============================================================================
// 组管理相关类型
// ============================================================================

/**
 * 组信息（扩展版，包含运行时状态）
 */
export interface ExtendedGroupInfo extends Group {
  /** 服务器数量 */
  serverCount: number;
  /** 已连接服务器数量 */
  connectedServers: number;
  /** 工具数量 */
  toolCount: number;
  /** 过滤后工具数量 */
  filteredToolCount: number;
  /** 工具过滤模式 */
  toolFilterMode: 'whitelist' | 'blacklist' | 'none';
  /** 是否健康 */
  isHealthy: boolean;
  /** 健康评分 */
  healthScore: number;
  /** 验证配置 */
  validation: {
    /** 是否启用验证 */
    enabled: boolean;
    /** 是否有密钥 */
    hasKey: boolean;
    /** 创建时间 */
    createdAt?: string;
    /** 最后更新时间 */
    lastUpdated?: string;
  };
  /** 扩展统计信息 */
  stats: {
    /** 总服务器数 */
    totalServers: number;
    /** 可用服务器数 */
    availableServers: number;
    /** 总工具数 */
    totalTools: number;
    /** 过滤后工具数 */
    filteredTools: number;
    /** 健康百分比 */
    healthPercentage: number;
  };
  /** 最后更新时间 */
  lastUpdated: string;
  /** 错误信息（如果有） */
  error?: string;
}

/**
 * 创建组请求
 */
export interface CreateGroupRequest {
  /** 组ID */
  id: string;
  /** 组名称 */
  name: string;
  /** 组描述 */
  description?: string;
  /** 包含的服务器ID列表 */
  servers: string[];
  /** 包含的工具名称列表 */
  tools: string[];
  skills?: Group['skills'];
}

/**
 * 更新组请求
 */
export interface UpdateGroupRequest {
  /** 组名称 */
  name?: string;
  /** 组描述 */
  description?: string;
  /** 包含的服务器ID列表 */
  servers?: string[];
  /** 包含的工具名称列表 */
  tools?: string[];
  skills?: Group['skills'];
}

/**
 * 组验证密钥配置
 */
export interface GroupValidationConfig {
  /** 是否启用验证 */
  enabled: boolean;
  /** 验证密钥（加密存储） */
  validationKey?: string;
  /** 密钥创建时间 */
  createdAt?: string;
  /** 密钥最后更新时间 */
  lastUpdated?: string;
}

/**
 * 设置组验证密钥请求
 */
export interface SetGroupValidationKeyRequest {
  /** 验证密钥 */
  validationKey: string;
  /** 是否启用验证 */
  enabled?: boolean;
}

/**
 * 组工具过滤配置请求
 */
export interface ConfigureGroupToolsRequest {
  /** 允许的工具名称列表 */
  tools: string[];
  /** 过滤模式：'whitelist' 白名单模式，'blacklist' 黑名单模式 */
  filterMode?: 'whitelist' | 'blacklist';
}

/**
 * 组可用工具响应
 */
export interface GroupAvailableToolsResponse {
  /** 组ID */
  groupId: string;
  /** 可用工具列表 */
  tools: ToolInfo[];
  /** 按服务器分组的工具 */
  toolsByServer: Record<string, ToolInfo[]>;
  /** 总工具数 */
  totalTools: number;
  /** 过滤后的工具数 */
  filteredTools: number;
  /** 工具过滤配置 */
  toolFilter: string[];
  /** 过滤信息 */
  filtering?: {
    isFilteringEnabled: boolean;
    filterRatio: number;
    excludedTools: number;
  };
  /** 工具分类 */
  categories?: string[];
  /** 服务器分布 */
  serverDistribution?: Array<{
    serverId: string;
    toolCount: number;
    percentage: number;
  }>;
  /** 时间戳 */
  timestamp: string;
}

/**
 * 组列表响应（扩展版）
 */
export interface ExtendedGroupListResponse {
  /** 组列表 */
  groups: ExtendedGroupInfo[];
  /** 总组数 */
  totalGroups: number;
  /** 健康组数 */
  healthyGroups: number;
  /** 总服务器数 */
  totalServers: number;
  /** 已连接服务器数 */
  connectedServers: number;
  /** 总工具数 */
  totalTools: number;
  /** 过滤后工具数 */
  filteredTools: number;
  /** 平均健康评分 */
  averageHealthScore: number;
  /** 启用验证的组数 */
  groupsWithValidation: number;
  /** 启用工具过滤的组数 */
  groupsWithToolFilter: number;
  /** 系统摘要 */
  summary: {
    /** 系统状态 */
    status: 'healthy' | 'partial' | 'unhealthy';
    /** 问题列表 */
    issues: string[];
  };
  /** 时间戳 */
  timestamp: string;
}

// ============================================================================
// API到MCP相关类型 — 以下类型从 Zod schema 统一导出
// AuthConfig, SecurityConfig, ResponseConfig, ApiEndpointConfig, CacheConfig, ApiToolConfig, HttpMethod
// 均从 config/types/index.ts 导出，不再在此重复定义
// ============================================================================

/**
 * API配置信息
 */
export interface ApiConfigInfo {
  /** 配置ID */
  id: string;
  /** 配置名称 */
  name: string;
  /** 配置描述 */
  description: string;
  /** 配置状态 */
  status: 'active' | 'inactive' | 'error';
  /** API信息 */
  api: {
    /** API URL */
    url: string;
    /** HTTP方法 */
    method: string;
  };
  /** 生成的工具数量 */
  toolsGenerated: number;
  /** 最后更新时间 */
  lastUpdated: string;
}

/**
 * 创建API配置请求
 */
export interface CreateApiConfigRequest {
  /** API工具配置 */
  config: ApiToolConfig;
}

/**
 * 测试API配置请求
 */
export interface TestApiConfigRequest {
  /** 测试参数 */
  parameters: Record<string, unknown>;
}

/**
 * 测试API配置响应
 */
export interface TestApiConfigResponse {
  /** 测试是否成功 */
  success: boolean;
  /** API响应数据 */
  response?: unknown;
  /** 错误信息 */
  error?: string;
  /** 执行时间（毫秒） */
  executionTime: number;
}

/**
 * API配置列表响应
 */
export interface ApiConfigListResponse {
  /** API配置列表 */
  configs: ApiConfigInfo[];
}

// ============================================================================
// 调试相关类型
// ============================================================================

/**
 * MCP消息类型
 */
export interface McpMessage {
  /** 消息ID */
  id: string;
  /** 时间戳 */
  timestamp: string;
  /** 服务器ID */
  serverId: string;
  /** 消息类型 */
  type: 'request' | 'response' | 'notification';
  /** 方法名 */
  method: string;
  /** 消息内容 */
  content: unknown;
}

/**
 * MCP消息列表响应
 */
export interface McpMessageListResponse {
  /** 消息列表 */
  messages: McpMessage[];
}

/**
 * 工具测试请求
 */
export interface ToolTestRequest {
  /** 工具名称 */
  toolName: string;
  /** 服务器ID（可选） */
  serverId?: string;
  /** 组ID（可选） */
  groupId?: string;
  /** 测试参数 */
  arguments: Record<string, unknown>;
}

/**
 * 性能统计响应
 */
export interface PerformanceStatsResponse {
  /** 统计数据 */
  stats: {
    /** 总请求数 */
    totalRequests: number;
    /** 平均响应时间（毫秒） */
    averageResponseTime: number;
    /** 错误率（百分比） */
    errorRate: number;
    /** 热门工具统计 */
    topTools: Array<{
      /** 工具名称 */
      name: string;
      /** 调用次数 */
      calls: number;
      /** 平均执行时间（毫秒） */
      avgTime: number;
    }>;
  };
}

// ============================================================================
// 仪表板相关类型
// ============================================================================

/**
 * 活动记录
 */
export interface Activity {
  /** 活动ID */
  id: string;
  /** 活动类型 */
  type: 'server_connected' | 'server_disconnected' | 'tool_executed' | 'error';
  /** 活动消息 */
  message: string;
  /** 时间戳 */
  timestamp: string;
  /** 严重程度 */
  severity: 'info' | 'warning' | 'error';
}

/**
 * 仪表板统计响应
 */
export interface DashboardStatsResponse {
  /** 概览统计 */
  overview: {
    /** 总服务器数 */
    totalServers: number;
    /** 已连接服务器数 */
    connectedServers: number;
    /** 总工具数 */
    totalTools: number;
    /** 总组数 */
    totalGroups: number;
  };
  /** 最近活动 */
  recentActivity: Activity[];
  /** 系统健康状态 */
  systemHealth: {
    /** 健康状态 */
    status: 'healthy' | 'warning' | 'error';
    /** 问题列表 */
    issues: string[];
  };
}

// ============================================================================
// SSE事件相关类型
// ============================================================================

/**
 * SSE事件基础接口
 */
export interface SSEEvent {
  /** 事件类型 */
  type: string;
  /** 事件数据 */
  data: unknown;
  /** 时间戳 */
  timestamp: string;
}

/**
 * 服务器状态变更事件
 */
export interface ServerStatusEvent extends SSEEvent {
  type: 'server_status';
  data: {
    /** 服务器ID */
    serverId: string;
    /** 新状态 */
    status: ServerStatus;
    /** 错误信息（如果有） */
    error?: string;
  };
}

/**
 * 工具执行事件
 */
export interface ToolExecutionEvent extends SSEEvent {
  type: 'tool_execution';
  data: {
    /** 工具名称 */
    toolName: string;
    /** 服务器ID */
    serverId: string;
    /** 执行是否成功 */
    success: boolean;
    /** 执行时间（毫秒） */
    executionTime: number;
  };
}

/**
 * 系统告警事件
 */
export interface SystemAlertEvent extends SSEEvent {
  type: 'system_alert';
  data: {
    /** 告警级别 */
    level: 'info' | 'warning' | 'error';
    /** 告警消息 */
    message: string;
    /** 相关组件 */
    component?: string;
  };
}

// ============================================================================
// 通用API响应类型
// ============================================================================

/**
 * 成功响应
 */
export interface SuccessResponse<T = unknown> {
  /** 是否成功 */
  success: true;
  /** 响应数据 */
  data: T;
  /** 时间戳 */
  timestamp: string;
}

/**
 * 错误响应
 */
export interface ErrorResponse {
  /** 是否成功 */
  success: false;
  /** 错误信息 */
  error: {
    /** 错误代码 */
    code: string;
    /** 错误消息 */
    message: string;
    /** 错误详情 */
    details?: unknown;
  };
  /** 时间戳 */
  timestamp: string;
  /** 请求路径 */
  path: string;
}

/**
 * API响应类型
 */
export type ApiResponse<T = unknown> = SuccessResponse<T> | ErrorResponse;

// ============================================================================
// 分页相关类型
// ============================================================================

/**
 * 分页请求参数
 */
export interface PaginationParams {
  /** 页码（从1开始） */
  page: number;
  /** 每页大小 */
  pageSize: number;
  /** 排序字段 */
  sortBy?: string;
  /** 排序方向 */
  sortOrder?: 'asc' | 'desc';
}

/**
 * 分页响应数据
 */
export interface PaginatedResponse<T> {
  /** 数据列表 */
  items: T[];
  /** 分页信息 */
  pagination: {
    /** 当前页码 */
    page: number;
    /** 每页大小 */
    pageSize: number;
    /** 总条目数 */
    total: number;
    /** 总页数 */
    totalPages: number;
    /** 是否有下一页 */
    hasNext: boolean;
    /** 是否有上一页 */
    hasPrev: boolean;
  };
}
