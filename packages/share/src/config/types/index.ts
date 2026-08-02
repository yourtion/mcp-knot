import type {
  ApiEndpointConfigSchema,
  ApiToolConfigSchema,
  ApiToolsConfigSchema,
  AuthConfigSchema,
  CacheConfigSchema,
  HttpMethodSchema,
  ResponseConfigSchema,
  SecurityConfigSchema,
} from '../schemas/api-tools.schema.js';
import type {
  CliConfigSchema,
  CliLoggingSchema,
  CliServerConfigSchema,
  CliTransportSchema,
} from '../schemas/cli.schema.js';
import type { CompatibilityOptionsSchema } from '../schemas/compatibility.schema.js';
import type {
  GroupConfigSchema,
  GroupSchema,
  GroupValidationSchema,
  ToolFilterSchema,
} from '../schemas/group.schema.js';
import type { McpConfigSchema } from '../schemas/mcp.schema.js';
import type {
  BaseServerConfigSchema,
  HttpServerConfigSchema,
  RetryConfigSchema,
  ServerConfigSchema,
  StdioServerConfigSchema,
} from '../schemas/server.schema.js';
import type { SystemConfigSchema } from '../schemas/system.schema.js';
/**
 * 从 Zod Schema 推导的类型定义
 * 所有配置类型均从 schema 推导，保证 schema 与类型始终一致
 */
import type { z } from 'zod/v4';

// Server types
export type BaseServerConfig = z.infer<typeof BaseServerConfigSchema>;
export type StdioServerConfig = z.infer<typeof StdioServerConfigSchema>;
export type HttpServerConfig = z.infer<typeof HttpServerConfigSchema>;
export type ServerConfig = z.infer<typeof ServerConfigSchema>;
export type RetryConfig = z.infer<typeof RetryConfigSchema>;
// NOTE: ServerAuthConfig 直接在 server.schema.ts 中导出（与 schema 同处），
// 经 schemas/index.js → config/index.js barrel 透出，故此处不再重复定义以避免重导出冲突。

// Group types
export type ToolFilter = z.infer<typeof ToolFilterSchema>;
export type GroupValidation = z.infer<typeof GroupValidationSchema>;
export type Group = z.infer<typeof GroupSchema>;
export type GroupConfig = z.infer<typeof GroupConfigSchema>;

// MCP types
export type McpConfig = z.infer<typeof McpConfigSchema>;

// System types
export type SystemConfig = z.infer<typeof SystemConfigSchema>;

// P7 协议兼容层配置类型（与 protocol 包共用同一份 schema）
export type CompatibilityConfig = z.infer<typeof CompatibilityOptionsSchema>;

// API Tools types
export type HttpMethod = z.infer<typeof HttpMethodSchema>;
export type AuthConfig = z.infer<typeof AuthConfigSchema>;
export type SecurityConfig = z.infer<typeof SecurityConfigSchema>;
export type CacheConfig = z.infer<typeof CacheConfigSchema>;
export type ResponseConfig = z.infer<typeof ResponseConfigSchema>;
export type ApiEndpointConfig = z.infer<typeof ApiEndpointConfigSchema>;
export type ApiToolConfig = z.infer<typeof ApiToolConfigSchema>;
export type ApiToolsConfig = z.infer<typeof ApiToolsConfigSchema>;

// CLI types
export type CliServerConfig = z.infer<typeof CliServerConfigSchema>;
export type CliLogging = z.infer<typeof CliLoggingSchema>;
export type CliTransport = z.infer<typeof CliTransportSchema>;
export type CliConfig = z.infer<typeof CliConfigSchema>;
