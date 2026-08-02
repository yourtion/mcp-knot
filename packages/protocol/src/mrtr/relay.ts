import { createRequestStateCodec } from '@modelcontextprotocol/server';

/**
 * Hub 级 MRTR 状态：把 upstream 的 opaque requestState 包在 Hub 自己的句柄里。
 *
 * 迁移自 backend `MrtrRelayService` 的 payload 形态。SDK codec 把本对象整体
 * 作为 HMAC 保护 envelope 的 payload（`p` 字段）封进 wire 字符串；客户端回传后
 * 由 verify 还原。payload 不含密钥派生/exp（exp 由 codec 按 ttlSeconds 独立写入
 * envelope，与 payload 字段无关）。
 */
export interface HubState {
  serverId: string;
  toolName: string;
  upstreamRequestState: string;
  step: number;
}

export interface HubMrtrCodecOptions {
  /** HMAC secret；UTF-8 编码后必须 >= 32 bytes（SDK 强制）。 */
  key: string;
  /** mint 出的 requestState 有效期（秒）；默认 600。 */
  ttlSeconds?: number;
}

/**
 * Hub MRTR requestState mint/verify：封装 SDK `createRequestStateCodec`，
 * 使 backend 与 cli 共用同一 HMAC 实现。
 *
 * 契约（backend 迁移依赖，与原 MrtrRelayService 行为一致）：
 * - `mint(state)`：把 HubState 印封成 opaque wire 字符串返回。**异步**
 *   （SDK 用 WebCrypto subtle.sign）。原 backend `relay()` 亦 `await codec.mint`。
 * - `verify(token)`：还原 HubState。**fail-closed**：token 篡改/过期/密钥不匹配
 *   时**抛错**（SDK seam 据此回 `-32602`），与原 backend `relay.verify`（直接
 *   暴露 `codec.verify` 作 ServerOptions.requestState.verify，抛错）一致。
 *   `token` 为空/undefined 时返回 `undefined`（表示初次调用、无上游 state 可还原）。
 *
 * 本类不配置 `bind`（context 绑定），故 mint/verify 无需传 ctx——跨 era 中转
 * 场景下 Hub 不持有 per-principal binding 语义；未来如需绑定可在 options 扩展。
 */
export class HubMrtrCodec {
  private readonly codec: ReturnType<typeof createRequestStateCodec<HubState>>;

  constructor(opts: HubMrtrCodecOptions) {
    this.codec = createRequestStateCodec<HubState>({
      key: opts.key,
      ttlSeconds: opts.ttlSeconds,
    });
  }

  /** 印封 HubState 为 opaque wire 字符串（异步：SDK 用 WebCrypto 签名）。 */
  async mint(state: HubState): Promise<string> {
    return this.codec.mint(state);
  }

  /**
   * 还原 HubState。token 为空 → undefined（初次调用语义）；
   * 篡改/过期/密钥不匹配 → 抛错（fail-closed，SDK seam 回 -32602）。
   */
  async verify(token: string | undefined): Promise<HubState | undefined> {
    if (!token) return undefined;
    // 本 codec 未配 bind，verify 实现不读 ctx（见源码：仅 bind !== undefined 分支
    // 访问 ctx）。SDK 类型把 ctx 标为必填（ServerContext），故此处显式传 undefined。
    // 真正的 ctx 来源是 SDK seam（ServerOptions.requestState.verify 回调）——那一路
    // 由调用方直接拿 codec.verify 透传（无空 token 分支），不走本方法。
    return this.codec.verify(token, undefined as never);
  }
}
