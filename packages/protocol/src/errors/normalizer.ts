import type { NormalizedError } from '../model/normalized.js';

const INTERNAL_ERROR: NormalizedError = { code: -32603, message: 'Internal error' };

type ErrorInput =
  | NormalizedError
  | Error
  | { code?: number; message?: string; data?: unknown }
  | unknown;

export function normalizeError(input: ErrorInput): NormalizedError {
  // 已是规范形态
  if (typeof input === 'object' && input !== null && 'code' in input && 'message' in input) {
    const code = typeof input.code === 'number' ? input.code : -32603;
    const message = typeof input.message === 'string' ? input.message : INTERNAL_ERROR.message;
    const data = 'data' in input ? input.data : undefined;
    return data !== undefined ? { code, message, data } : { code, message };
  }
  // Error 实例
  if (input instanceof Error) {
    return { code: -32603, message: input.message || INTERNAL_ERROR.message };
  }
  // 兜底
  return { ...INTERNAL_ERROR };
}

export function toJsonRpcError(input: ErrorInput): {
  code: number;
  message: string;
  data?: unknown;
} {
  const e = normalizeError(input);
  return e.data !== undefined
    ? { code: e.code, message: e.message, data: e.data }
    : { code: e.code, message: e.message };
}

export class UnifiedErrorNormalizer {
  normalize(input: ErrorInput): NormalizedError {
    return normalizeError(input);
  }
  toJsonRpc(input: ErrorInput): { code: number; message: string; data?: unknown } {
    return toJsonRpcError(input);
  }
}
