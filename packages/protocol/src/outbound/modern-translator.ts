import { okResult, inputRequiredResult } from '../model/normalized.js';

import type { NormalizedCall, NormalizedResult } from '../model/normalized.js';

// modern upstream 的 wire callTool 参数：inputResponses/requestState 是顶层成员（非 _meta）
export interface ModernWireCall {
  name: string;
  arguments: unknown;
  requestState?: string;
  inputResponses?: Record<string, unknown>;
}

export function translateCallForModern(call: NormalizedCall): ModernWireCall {
  const wire: ModernWireCall = { name: call.toolName, arguments: call.arguments };
  if (call.mrtr?.requestState) wire.requestState = call.mrtr.requestState;
  if (call.mrtr?.inputResponses) wire.inputResponses = call.mrtr.inputResponses;
  return wire;
}

// modern upstream 返回值归一化。raw 是 SDK callTool 的返回（ReadResult-like）
export function translateModernResult(raw: {
  content?: unknown;
  isError?: boolean;
  resultType?: string;
  inputRequests?: Record<string, unknown>;
  requestState?: string;
}): NormalizedResult {
  if (raw.resultType === 'input_required') {
    return inputRequiredResult(raw.inputRequests ?? {}, { requestState: raw.requestState });
  }
  return okResult(
    (raw.content as Array<{ type: string; text?: string; data?: string; mimeType?: string }>) ?? [],
    raw.isError ?? false,
  );
}
