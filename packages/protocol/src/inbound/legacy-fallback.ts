import {
  legacyStatelessFallback,
  type McpServerFactory,
  type LegacyHttpHandler,
} from '@modelcontextprotocol/server';

// 包装 SDK 的 legacyStatelessFallback，未来如需自定义 onerror/日志在此收口
export function createLegacyFallback(
  factory: McpServerFactory,
  onError?: (e: Error) => void,
): LegacyHttpHandler {
  return legacyStatelessFallback(factory, onError);
}

export type { McpServerFactory, LegacyHttpHandler };
