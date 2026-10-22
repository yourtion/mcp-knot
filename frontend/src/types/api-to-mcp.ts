// API到MCP相关类型定义

import type { JsonSchema } from './tool';
import type { ApiToolConfig as SharedApiToolConfig } from '@mcp-core/mcp-knot-share/config';

/**
 * HTTP请求方法
 */
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' | 'HEAD' | 'OPTIONS';

/**
 * 认证配置
 */
export interface AuthConfig {
  type: 'bearer' | 'apikey' | 'basic';
  token?: string;
  header?: string;
  username?: string;
  password?: string;
}

/**
 * 安全配置
 */
export interface SecurityConfig {
  authentication?: AuthConfig;
  allowedDomains?: string[];
  rateLimiting?: {
    windowSeconds: number;
    maxRequests: number;
    enabled: boolean;
  };
}

/**
 * 缓存配置
 */
export interface CacheConfig {
  enabled: boolean;
  ttl: number;
  maxSize?: number;
}

/**
 * API端点配置
 */
export interface ApiEndpointConfig {
  url: string;
  method: HttpMethod;
  headers?: Record<string, string>;
  timeout?: number;
}

/**
 * 响应配置
 */
export interface ResponseConfig {
  statusCodePath?: string;
  dataPath?: string;
  errorMessagePath?: string;
  successCodes?: number[];
  errorCodes?: number[];
}

/**
 * API工具配置
 */
export interface ApiToolConfig {
  id: string;
  name: string;
  description: string;
  api: ApiEndpointConfig;
  parameters: SharedApiToolConfig['parameters'] & { required?: string[] };
  response: ResponseConfig;
  security?: SecurityConfig;
  cache?: CacheConfig;
}

/**
 * API配置信息
 */
export interface ApiConfigInfo {
  id: string;
  name: string;
  description: string;
  status: 'active' | 'inactive' | 'error';
  api: {
    url: string;
    method: string;
  };
  toolsGenerated: number;
  lastUpdated: string;
}

/**
 * API配置列表响应
 */
export interface ApiConfigListResponse {
  configs: ApiConfigInfo[];
}

/**
 * 创建API配置请求
 */
export interface CreateApiConfigRequest {
  config: ApiToolConfig;
}

/**
 * 更新API配置请求
 */
export interface UpdateApiConfigRequest {
  config: ApiToolConfig;
}

/**
 * 测试API配置请求
 */
export interface TestApiConfigRequest {
  parameters: Record<string, unknown>;
}

/**
 * 测试API配置响应
 */
export interface TestApiConfigResponse {
  success: boolean;
  response?: unknown;
  error?: string;
  executionTime: number;
}

/**
 * 参数映射配置
 */
export interface ParameterMapping {
  source: string;
  target: string;
  type: 'direct' | 'transform' | 'static';
  transform?: string;
  staticValue?: unknown;
  required?: boolean;
}

/**
 * MCP工具预览
 */
export interface McpToolPreview {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  serverName: string;
}

/**
 * API导入配置
 */
export interface ApiImportConfig {
  format: 'openapi' | 'postman' | 'manual';
  source: string | File;
  options?: {
    includeParameters?: boolean;
    includeSecurity?: boolean;
    generateTools?: boolean;
  };
}

/**
 * API导出配置
 */
export interface ApiExportConfig {
  format: 'json' | 'yaml' | 'postman';
  configs: string[];
  options?: {
    includeMetadata?: boolean;
    includeSecurity?: boolean;
  };
}
