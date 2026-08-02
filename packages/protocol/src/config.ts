/**
 * 协议兼容层配置（re-export）。
 *
 * schema 单一来源在 share 包（避免 protocol↔share 循环依赖）。
 * 本文件仅 re-export schema、类型与默认实例，保证消费者从本包引入时 API 不变。
 *
 * defaultCompatibilityOptions 直接从 share re-export 同一引用，
 * 不在 protocol 里重新 parse 一遍，确保 share 与 protocol 共用同一份实例。
 */
export {
  CompatibilityOptionsSchema,
  defaultCompatibilityOptions,
} from '@mcp-core/mcp-knot-share/config';
export type { CompatibilityOptions } from '@mcp-core/mcp-knot-share/config';
