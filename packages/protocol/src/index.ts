/**
 * 协议兼容层公共 API（后续 task 填充）。
 *
 * 当前仅导出协议版本占位常量，后续 task 将填充 config / model / inbound /
 * outbound / mrtr / errors 等模块的公共导出。
 */
export const PROTOCOL_VERSION = '0.0.1';

export { CompatibilityOptionsSchema, defaultCompatibilityOptions } from './config.js';
export type { CompatibilityOptions } from './config.js';

export type { Era, InboundEra, UpstreamEra, UpstreamEraProbe } from './model/era.js';
export type {
  NormalizedRequest,
  NormalizedMeta,
  NormalizedCall,
  NormalizedMrtrState,
  NormalizedResult,
  NormalizedSuccess,
  NormalizedInputRequired,
  NormalizedError,
  NormalizedErrorResult,
} from './model/normalized.js';
export {
  normalizeInboundRequest,
  normalizeCall,
  okResult,
  inputRequiredResult,
  errorResult,
} from './model/normalized.js';

export { normalizeError, toJsonRpcError, UnifiedErrorNormalizer } from './errors/normalizer.js';

export {
  InboundProtocolAdapter,
  resolveInboundLegacyMode,
  toNormalizedRequest,
} from './inbound/adapter.js';
export type { TransportKind } from './inbound/adapter.js';
export { createLegacyFallback } from './inbound/legacy-fallback.js';
