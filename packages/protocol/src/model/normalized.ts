import type { Era } from './era.js';

// 归一化后的入站请求：业务层只认这个，不感知 era 之外的 wire 差异
export interface NormalizedRequest {
  method: string;
  params: unknown;
  meta: NormalizedMeta;
  era: Era;
}

export interface NormalizedMeta {
  clientInfo?: { name: string; version: string };
  capabilities?: Record<string, unknown>;
  traceparent?: string;
  baggage?: string;
}

export interface NormalizedCall {
  toolName: string;
  arguments: unknown;
  mrtr?: NormalizedMrtrState;
}

export interface NormalizedMrtrState {
  requestState?: string;
  inputResponses?: Record<string, unknown>;
}

export type NormalizedResult =
  | ({ kind: 'success' } & NormalizedSuccess)
  | ({ kind: 'input_required' } & NormalizedInputRequired)
  | ({ kind: 'error' } & NormalizedErrorResult);

export interface NormalizedSuccess {
  content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
  isError?: boolean;
}

export interface NormalizedInputRequired {
  inputRequests: Record<string, unknown>;
  mrtr: NormalizedMrtrState;
}

export interface NormalizedError {
  code: number;
  message: string;
  data?: unknown;
}

export interface NormalizedErrorResult {
  error: NormalizedError;
}

// —— 构造器（方便 translator 组装，业务层只读） ——

export function normalizeInboundRequest(input: {
  method: string;
  params: unknown;
  meta: NormalizedMeta;
  era: Era;
}): NormalizedRequest {
  return { ...input };
}

export function normalizeCall(input: {
  toolName: string;
  arguments: unknown;
  mrtr?: NormalizedMrtrState;
}): NormalizedCall {
  return { ...input };
}

export function okResult(content: NormalizedSuccess['content'], isError = false): NormalizedResult {
  return { kind: 'success', content, isError };
}

export function inputRequiredResult(
  inputRequests: Record<string, unknown>,
  mrtr: NormalizedMrtrState = {},
): NormalizedResult {
  return { kind: 'input_required', inputRequests, mrtr };
}

export function errorResult(error: NormalizedError): NormalizedResult {
  return { kind: 'error', error };
}
