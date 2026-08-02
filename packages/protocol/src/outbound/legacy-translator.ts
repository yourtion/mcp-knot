import { okResult, errorResult } from '../model/normalized.js';

import type { NormalizedCall, NormalizedResult } from '../model/normalized.js';
import type { NormalizedError } from '../model/normalized.js';

// legacy upstream 的 wire callTool 参数：只有 name/arguments
// _meta envelope / inputResponses / requestState 在 legacy era 不存在
export interface LegacyWireCall {
  name: string;
  arguments: unknown;
}

export function translateCallForLegacy(call: NormalizedCall): LegacyWireCall {
  return { name: call.toolName, arguments: call.arguments };
}

// legacy upstream 不支持 input_required（协议层无此字段）
// 若业务层确实需要 MRTR 而 upstream 是 legacy，应在 adapter 层据 mrtrLegacyDegradation 决策
// 这里只把普通成功结果归一；input_required 场景由 adapter 调用方处理（返回 errorResult）
export function translateLegacyResult(raw: {
  content?: unknown;
  isError?: boolean;
}): NormalizedResult {
  return okResult(
    (raw.content as Array<{ type: string; text?: string; data?: string; mimeType?: string }>) ?? [],
    raw.isError ?? false,
  );
}

// 当 legacy upstream 被要求做 MRTR 但不支持时，构造归一化错误
export function legacyMrtrUnsupportedError(): NormalizedResult {
  const err: NormalizedError = {
    code: -32601,
    message: 'upstream is legacy-era and does not support input_required (MRTR)',
  };
  return errorResult(err);
}
