// era 是 Hub 内部的统一抽象，与 SDK 的 ProtocolEra 对齐但独立定义，
// 避免 protocol 包消费者直接依赖 SDK 内部类型。
export type Era = 'modern' | 'legacy';

// 入站探测到的客户端 era
export type InboundEra = Era;

// 出站探测到的 upstream era
export type UpstreamEra = Era;

// 未探测到时的临时态
export type UpstreamEraProbe = UpstreamEra | 'unknown';
