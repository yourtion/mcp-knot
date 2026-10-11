import { normalizeInboundRequest } from '../model/normalized.js';

import type { CompatibilityOptions } from '../config.js';
import type { InboundEra } from '../model/era.js';
import type { NormalizedRequest, NormalizedMeta } from '../model/normalized.js';

export type TransportKind = 'http' | 'stdio';

// 据 CompatibilityOptions 算出该传给 SDK 的 legacy 值
// HTTP: 'stateless' | 'reject'；stdio: 'serve' | 'reject'
export function resolveInboundLegacyMode(
  opts: CompatibilityOptions,
  kind: TransportKind,
): 'stateless' | 'serve' | 'reject' {
  if (!opts.inbound.enabled || opts.inbound.legacyMode === 'reject') return 'reject';
  return kind === 'http' ? 'stateless' : 'serve';
}

// 把 SDK 已 classify 的请求归一化为 NormalizedRequest
// 入参 era 由调用方据 SDK classifyInboundRequest 结果判定（modern/legacy）
export function toNormalizedRequest(input: {
  method: string;
  params: unknown;
  meta: NormalizedMeta;
  era: InboundEra;
}): NormalizedRequest {
  return normalizeInboundRequest(input);
}

// adapter 类（封装 opts，便于 backend/cli 持有）
export class InboundProtocolAdapter {
  constructor(private readonly opts: CompatibilityOptions) {}

  resolveLegacyMode(kind: TransportKind): 'stateless' | 'serve' | 'reject' {
    return resolveInboundLegacyMode(this.opts, kind);
  }

  normalize(input: {
    method: string;
    params: unknown;
    meta: NormalizedMeta;
    era: InboundEra;
  }): NormalizedRequest {
    return toNormalizedRequest(input);
  }
}
