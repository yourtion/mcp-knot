// 工具管理相关的类型定义
import type { JsonSchema } from 'vue-json-ui-editor';

export type { JsonSchema, JsonSchemaProperty } from 'vue-json-ui-editor';

export interface ToolInfo {
  name: string;
  description: string;
  serverId: string;
  serverName?: string;
  inputSchema: JsonSchema;
  status: 'available' | 'unavailable';
}

export interface ToolListResponse {
  tools: ToolInfo[];
  toolsByServer: Record<string, ToolInfo[]>;
  total: number;
  groupId: string;
  serverId?: string;
}

export interface ToolExecuteRequest {
  arguments: Record<string, unknown>;
  groupId?: string;
  serverId?: string;
}

export interface ToolExecuteResponse {
  executionId: string;
  toolName: string;
  serverId: string;
  groupId: string;
  result: ToolResult[];
  isError: boolean;
  executionTime: number;
  timestamp: string;
}

export interface ToolResult {
  type: 'text' | 'image' | 'resource';
  text?: string;
  data?: string;
  mimeType?: string;
  uri?: string;
}

export interface ToolTestRequest {
  arguments: Record<string, unknown>;
  groupId?: string;
}

export interface ToolTestResponse {
  toolName: string;
  serverId: string;
  groupId: string;
  serverStatus: string;
  isAvailable: boolean;
  validation: {
    isValid: boolean;
    errors: string[];
    warnings: string[];
  };
  canExecute: boolean;
}

export interface ToolExecution {
  executionId: string;
  toolName: string;
  serverId: string;
  groupId: string;
  arguments: Record<string, unknown>;
  result: ToolResult[];
  isError: boolean;
  executionTime: number;
  timestamp: string;
}

export interface ToolHistoryResponse {
  history: ToolExecution[];
  pagination: {
    total: number;
    limit: number;
    offset: number;
    hasMore: boolean;
  };
}

export interface ToolStats {
  overview: {
    totalExecutions: number;
    successfulExecutions: number;
    failedExecutions: number;
    successRate: number;
    averageExecutionTime: number;
  };
  topTools: Array<{
    toolName: string;
    executions: number;
    successes: number;
    failures: number;
    totalTime: number;
    averageTime: number;
  }>;
}

export interface ToolMonitoring {
  overview: {
    totalTools: number;
    availableTools: number;
    unavailableTools: number;
    totalServers: number;
    connectedServers: number;
    disconnectedServers: number;
    availabilityRate: number;
  };
  toolsByServer: Record<
    string,
    {
      serverId: string;
      serverStatus: string;
      tools: ToolInfo[];
    }
  >;
}

export interface ToolPerformance {
  timeRange: string;
  period: {
    startTime: string;
    endTime: string;
  };
  overview: {
    totalExecutions: number;
    successfulExecutions: number;
    failedExecutions: number;
    successRate: number;
    averageExecutionTime: number;
  };
  percentiles: {
    p50: number;
    p95: number;
    p99: number;
  };
  timeSeries: Array<{
    timestamp: string;
    executions: number;
    errors: number;
    averageTime: number;
    errorRate: number;
  }>;
}

export interface ToolError {
  executionId: string;
  toolName: string;
  serverId: string;
  groupId: string;
  timestamp: string;
  executionTime: number;
  arguments: Record<string, unknown>;
  result: ToolResult[];
}

export interface ToolErrorResponse {
  errors: ToolError[];
  errorSummary: Array<{
    errorMessage: string;
    count: number;
    affectedTools: string[];
    affectedServers: string[];
    lastOccurrence: string;
    examples: ToolError[];
  }>;
  pagination: {
    total: number;
    limit: number;
    offset: number;
    hasMore: boolean;
  };
}

// 工具健康检查响应
export interface ToolHealthResponse {
  totalTools: number;
  availableTools: number;
  unavailableTools: number;
  healthyServers: number;
  totalServers: number;
  availabilityRate: number;
  toolsByServer: Record<
    string,
    {
      serverId: string;
      serverName: string;
      serverStatus: string;
      tools: ToolInfo[];
    }
  >;
}

// 工具过滤和搜索参数
export interface ToolFilterParams {
  serverId?: string;
  groupId?: string;
  search?: string;
  status?: 'available' | 'unavailable' | 'all';
  sortBy?: 'name' | 'server' | 'status';
  sortOrder?: 'asc' | 'desc';
}

// 工具执行历史过滤参数
export interface ToolHistoryFilterParams {
  limit?: number;
  offset?: number;
  toolName?: string;
  serverId?: string;
  groupId?: string;
  startTime?: string;
  endTime?: string;
}
