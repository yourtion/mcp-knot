/**
 * 组管理 API 的数据校验逻辑
 * 包含组配置校验、组 ID 校验、工具复杂度评估
 */

import { GroupSkillsSchema } from '@mcp-core/mcp-knot-share/config';

import type { CreateGroupRequest, UpdateGroupRequest } from '@mcp-core/mcp-knot-share';

// JSON Schema 类型定义（用于工具复杂度评估）
export interface JsonSchema {
  type?: string;
  properties?: Record<string, JsonSchemaProperty>;
  required?: string[];
}

export interface JsonSchemaProperty {
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

/**
 * 验证组配置数据
 */
export function validateGroupData(data: CreateGroupRequest | UpdateGroupRequest): {
  isValid: boolean;
  errors: string[];
} {
  const errors: string[] = [];

  if (data.skills !== undefined) {
    const result = GroupSkillsSchema.safeParse(data.skills);
    if (!result.success)
      errors.push(
        ...result.error.issues.map((issue) => `skills.${issue.path.join('.')}: ${issue.message}`),
      );
  }

  // 验证名称
  if ('name' in data && data.name !== undefined) {
    if (!data.name || typeof data.name !== 'string' || data.name.trim().length === 0) {
      errors.push('组名称不能为空');
    } else if (data.name.length > 100) {
      errors.push('组名称长度不能超过100个字符');
    }
  }

  // 验证描述
  if ('description' in data && data.description !== undefined) {
    if (typeof data.description !== 'string') {
      errors.push('组描述必须是字符串类型');
    } else if (data.description.length > 500) {
      errors.push('组描述长度不能超过500个字符');
    }
  }

  // 验证服务器列表
  if ('servers' in data && data.servers !== undefined) {
    if (!Array.isArray(data.servers)) {
      errors.push('服务器列表必须是数组');
    } else {
      for (let i = 0; i < data.servers.length; i++) {
        const serverId = data.servers[i];
        if (!serverId || typeof serverId !== 'string') {
          errors.push(`服务器列表[${i}]必须是非空字符串`);
        }
      }

      // 检查重复的服务器ID
      const uniqueServers = new Set(data.servers);
      if (uniqueServers.size !== data.servers.length) {
        errors.push('服务器列表包含重复的服务器ID');
      }
    }
  }

  // 验证工具列表
  if ('tools' in data && data.tools !== undefined) {
    if (!Array.isArray(data.tools)) {
      errors.push('工具列表必须是数组');
    } else {
      for (let i = 0; i < data.tools.length; i++) {
        const toolName = data.tools[i];
        if (!toolName || typeof toolName !== 'string') {
          errors.push(`工具列表[${i}]必须是非空字符串`);
        }
      }

      // 检查重复的工具名称
      const uniqueTools = new Set(data.tools);
      if (uniqueTools.size !== data.tools.length) {
        errors.push('工具列表包含重复的工具名称');
      }
    }
  }

  return {
    isValid: errors.length === 0,
    errors,
  };
}

/**
 * 验证组ID格式
 */
export function validateGroupId(groupId: string): {
  isValid: boolean;
  error?: string;
} {
  if (!groupId || typeof groupId !== 'string') {
    return { isValid: false, error: '组ID不能为空' };
  }

  if (groupId.length < 1 || groupId.length > 50) {
    return { isValid: false, error: '组ID长度必须在1-50个字符之间' };
  }

  // 组ID只能包含字母、数字、连字符和下划线
  const validIdPattern = /^[a-zA-Z0-9_-]+$/;
  if (!validIdPattern.test(groupId)) {
    return { isValid: false, error: '组ID只能包含字母、数字、连字符和下划线' };
  }

  return { isValid: true };
}

/**
 * 估算工具复杂度
 */
export function estimateToolComplexity(schema: JsonSchema): {
  complexity: 'simple' | 'medium' | 'complex';
  parameterCount: number;
  requiredParameterCount: number;
  estimatedExecutionTime: 'fast' | 'medium' | 'slow';
} {
  const properties = schema.properties || {};
  const required = schema.required || [];
  const parameterCount = Object.keys(properties).length;
  const requiredParameterCount = required.length;

  // 计算复杂度得分
  let complexityScore = 0;

  // 基于参数数量
  complexityScore += parameterCount * 2;
  complexityScore += requiredParameterCount * 3;

  // 基于参数类型复杂度
  Object.values(properties).forEach((prop) => {
    switch (prop.type) {
      case 'object':
        complexityScore += 5;
        break;
      case 'array':
        complexityScore += 4;
        break;
      case 'number':
        complexityScore += 2;
        break;
      case 'boolean':
        complexityScore += 1;
        break;
      default:
        complexityScore += 1;
    }
  });

  // 确定复杂度级别
  let complexity: 'simple' | 'medium' | 'complex';
  let estimatedExecutionTime: 'fast' | 'medium' | 'slow';

  if (complexityScore <= 10) {
    complexity = 'simple';
    estimatedExecutionTime = 'fast';
  } else if (complexityScore <= 25) {
    complexity = 'medium';
    estimatedExecutionTime = 'medium';
  } else {
    complexity = 'complex';
    estimatedExecutionTime = 'slow';
  }

  return {
    complexity,
    parameterCount,
    requiredParameterCount,
    estimatedExecutionTime,
  };
}
