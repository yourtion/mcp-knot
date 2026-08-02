import {
  translateCallForLegacy,
  translateLegacyResult,
  legacyMrtrUnsupportedError,
  type LegacyWireCall,
} from './legacy-translator.js';
import {
  translateCallForModern,
  translateModernResult,
  type ModernWireCall,
} from './modern-translator.js';

import type { CompatibilityOptions } from '../config.js';
import type { UpstreamEra } from '../model/era.js';
import type { NormalizedCall, NormalizedResult } from '../model/normalized.js';

// 透出 translator 的 wire 形态类型，便于 index.ts 统一 re-export
export type { ModernWireCall, LegacyWireCall };

// 统一出口：据 era 输出 wire 形态
export type WireCall = ModernWireCall | LegacyWireCall;

export function translateCallForUpstream(call: NormalizedCall, era: UpstreamEra): WireCall {
  return era === 'modern' ? translateCallForModern(call) : translateCallForLegacy(call);
}

export function translateUpstreamResult(raw: unknown, era: UpstreamEra): NormalizedResult {
  if (era === 'modern') {
    return translateModernResult(raw as Parameters<typeof translateModernResult>[0]);
  }
  return translateLegacyResult(raw as Parameters<typeof translateLegacyResult>[0]);
}

// adapter 类：封装 opts + era，决策 MRTR 在 legacy upstream 的降级
export class OutboundProtocolAdapter {
  constructor(private readonly opts: CompatibilityOptions) {}

  // 若 modernOnly=true，强制视 upstream 为 modern（只允许连 modern）
  effectiveEra(probed: UpstreamEra): UpstreamEra {
    if (this.opts.outbound.modernOnly) return 'modern';
    return probed;
  }

  // legacy upstream 触发 MRTR 时的处理
  handleLegacyMrtr(): NormalizedResult {
    return this.opts.outbound.mrtrLegacyDegradation === 'reject'
      ? legacyMrtrUnsupportedError()
      : legacyMrtrUnsupportedError();
    // 注：shim 与 reject 当前都返回错误（legacy 协议层无 input_required）。
    // 真正的 shim 翻译（走 sampling/elicitation）作为 P2，MVP 阶段统一为不支持错误。
  }

  translateCall(call: NormalizedCall, era: UpstreamEra): WireCall {
    return translateCallForUpstream(call, this.effectiveEra(era));
  }

  translateResult(raw: unknown, era: UpstreamEra): NormalizedResult {
    return translateUpstreamResult(raw, this.effectiveEra(era));
  }
}
