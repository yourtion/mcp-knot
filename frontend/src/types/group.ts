// 组管理相关的类型定义

import type { SkillSelection } from '@/types/skill';

export interface GroupInfo {
  id: string;
  name: string;
  description?: string;
  servers: string[];
  serverCount: number;
  connectedServers: number;
  toolCount: number;
  filteredToolCount: number;
  tools: string[];
  skills?: { include: SkillSelection[] };
  toolFilterMode: 'whitelist' | 'none';
  isHealthy: boolean;
  healthScore: number;
  validation: {
    enabled: boolean;
    hasKey: boolean;
    createdAt?: string;
    lastUpdated?: string;
  };
  stats: {
    totalServers: number;
    availableServers: number;
    totalTools: number;
    filteredTools: number;
    healthPercentage: number;
  };
  lastUpdated: string;
  error?: string;
}

export interface GroupDetailServer {
  id: string;
  status: string;
  lastConnected?: string;
  toolCount: number;
  error?: string;
}

export interface GroupDetailTool {
  name: string;
  description: string;
  serverId: string;
  parameters?: unknown;
  category?: string;
}

export interface GroupDetailInfo extends Omit<GroupInfo, 'servers' | 'tools'> {
  servers: GroupDetailServer[];
  tools: GroupDetailTool[];
  performance: {
    averageResponseTime: number;
    totalRequests: number;
    successRate: number;
  };
  accessControl: {
    requiresValidation: boolean;
    toolAccessRestricted: boolean;
  };
}

export interface GroupListResponse {
  groups: GroupInfo[];
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
  summary: {
    status: 'healthy' | 'partial' | 'unhealthy';
    issues: string[];
  };
  timestamp: string;
}

export interface GroupServerInfo {
  id: string;
  status: string;
  lastConnected?: string;
  lastError?: string;
  tools: Array<{
    name: string;
    description: string;
    category?: string;
  }>;
  toolCount: number;
  isHealthy: boolean;
}

export interface GroupServersResponse {
  groupId: string;
  servers: GroupServerInfo[];
  totalServers: number;
  connectedServers: number;
  disconnectedServers: number;
  totalTools: number;
  healthScore: number;
  timestamp: string;
}

export interface GroupToolInfo {
  name: string;
  description: string;
  serverId: string;
  serverName: string;
  inputSchema: unknown;
  status: 'available';
  category?: string;
  deprecated?: boolean;
  version?: string;
}

export interface GroupToolsResponse {
  groupId: string;
  tools: GroupToolInfo[];
  toolsByServer: Record<string, GroupToolInfo[]>;
  totalTools: number;
  serverCount: number;
  toolFilter: string[];
  timestamp: string;
}

export interface CreateGroupRequest {
  id: string;
  name: string;
  description?: string;
  servers: string[];
  tools: string[];
  skills?: { include: SkillSelection[] };
}

export interface UpdateGroupRequest {
  name?: string;
  description?: string;
  servers?: string[];
  tools?: string[];
  skills?: { include: SkillSelection[] };
}

export interface GroupOperationResponse {
  success: true;
  data: {
    id: string;
    name: string;
    description?: string;
    servers: string[];
    tools: string[];
    skills?: { include: SkillSelection[] };
    toolFilterMode: 'whitelist' | 'none';
    validation: {
      enabled: boolean;
      hasKey: boolean;
      createdAt?: string;
      lastUpdated?: string;
    };
    stats: {
      totalServers: number;
      availableServers: number;
      totalTools: number;
      filteredTools: number;
      healthPercentage: number;
    };
    accessControl: {
      requiresValidation: boolean;
      toolAccessRestricted: boolean;
    };
    lastUpdated: string;
  };
  timestamp: string;
}

export interface GroupHealthResponse {
  groupId: string;
  healthy: boolean;
  healthScore: number;
  servers: {
    total: number;
    healthy: number;
    unhealthy: number;
    details: Array<{
      serverId: string;
      healthy: boolean;
      status: string;
      lastConnected?: string;
      error?: string;
      toolCount: number;
    }>;
  };
  tools: {
    available: number;
    total: number;
  };
  issues: string[];
  timestamp: string;
}

export interface ConfigureGroupToolsRequest {
  tools: string[];
  filterMode?: 'whitelist';
}

export interface GroupToolsConfigResponse {
  success: true;
  data: {
    groupId: string;
    tools: string[];
    toolCount: number;
    filterMode: 'whitelist';
    validation: {
      enabled: boolean;
      requiresKey: boolean;
    };
    impact: {
      previouslyFilteredTools: number;
      newlyFilteredTools: number;
      change: number;
    };
    accessControl: {
      toolAccessRestricted: boolean;
      unrestrictedAccess: boolean;
    };
    lastUpdated: string;
  };
  timestamp: string;
}

export interface GroupAvailableToolsResponse {
  groupId: string;
  tools: GroupToolInfo[];
  toolsByServer: Record<string, GroupToolInfo[]>;
  totalTools: number;
  filteredTools: number;
  toolFilter: string[];
  toolFilterMode: 'whitelist' | 'none';
  filtering: {
    isFilteringEnabled: boolean;
    filterRatio: number;
    excludedTools: number;
  };
  categories: string[];
  serverDistribution: Array<{
    serverId: string;
    toolCount: number;
    percentage: number;
  }>;
  timestamp: string;
}

export interface GroupToolAccessValidationRequest {
  toolName: string;
}

export interface GroupToolAccessValidationResponse {
  success: true;
  data: {
    groupId: string;
    toolName: string;
    hasAccess: boolean;
    reason: 'ACCESS_GRANTED' | 'TOOL_NOT_FOUND_IN_GROUP' | 'TOOL_NOT_IN_WHITELIST';
    message: string;
    validation: {
      groupHasValidation: boolean;
      toolInFilterList: boolean;
      filterMode: 'whitelist' | 'none';
    };
    toolInfo?: {
      name: string;
      description: string;
      serverId: string;
      serverName: string;
      category?: string;
      version?: string;
      deprecated?: boolean;
      inputSchema: unknown;
      estimatedComplexity: {
        complexity: 'simple' | 'medium' | 'complex';
        parameterCount: number;
        requiredParameterCount: number;
        estimatedExecutionTime: 'fast' | 'medium' | 'slow';
      };
    };
    alternatives?: Array<{
      name: string;
      description: string;
    }>;
  };
  timestamp: string;
}

export interface SetGroupValidationKeyRequest {
  validationKey: string;
  enabled?: boolean;
}

export interface GroupValidationKeyResponse {
  success: true;
  data: {
    groupId: string;
    validation: {
      enabled: boolean;
      hasKey: boolean;
      createdAt?: string;
      lastUpdated?: string;
    };
  };
  timestamp: string;
}

export interface GroupValidationKeyStatusResponse {
  success: true;
  data: {
    groupId: string;
    validation: {
      enabled: boolean;
      hasKey: boolean;
      createdAt?: string;
      lastUpdated?: string;
    };
  };
  timestamp: string;
}

export interface GroupKeyValidationRequest {
  validationKey: string;
}

export interface GroupKeyValidationResponse {
  success: true;
  data: {
    groupId: string;
    valid: boolean;
    reason: 'KEY_VALID' | 'INVALID_KEY' | 'VALIDATION_DISABLED' | 'NO_KEY_SET' | 'DECRYPTION_ERROR';
    message: string;
  };
  timestamp: string;
}

export interface GroupValidationKeyDeleteResponse {
  success: true;
  data: {
    groupId: string;
    validation: {
      enabled: boolean;
      hasKey: boolean;
    };
    deleted: boolean;
  };
  timestamp: string;
}

export interface GroupValidationKeyGenerateResponse {
  success: true;
  data: {
    groupId: string;
    validationKey: string;
    validation: {
      enabled: boolean;
      hasKey: boolean;
      createdAt?: string;
      lastUpdated?: string;
    };
    security: {
      keyComplexity: 'weak' | 'medium' | 'strong';
      keyLength: number;
      entropy: number;
      recommendations: string[];
    };
    warnings: string[];
  };
  timestamp: string;
}
