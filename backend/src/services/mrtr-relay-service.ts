import { HubMrtrCodec, type HubState as ProtocolHubState } from '@mcp-core/mcp-knot-protocol';

import type { ServerContext } from '@modelcontextprotocol/server';

// ─────────────────────────────────────────────────────────────────────────────
// P7 迁移：MRTR mint/verify 改用 protocol 包的 HubMrtrCodec（与 cli 共用同一 HMAC
// 实现）。保留原 MrtrRelayService 的对外接口（relay/resume/verify + 构造签名），
// 使 group-service 及其测试零回归——仅底层 codec 从 SDK createRequestStateCodec
// 换成 HubMrtrCodec。
//
// 类型适配（Task 7 契约警告）：
//   - backend HubState.upstreamRequestState 是 optional（上游可能无 state），
//     protocol HubState.upstreamRequestState 是 required。mint 时把 undefined
//     作 opaque payload 字段序列化（codec 不校验字段语义），verify 还原后仍是
//     undefined——保持 group-service resume() 行为不变。
//   - backend HubState 有 exp（必填），protocol HubState 无 exp（exp 由 codec
//     按 ttlSeconds 独立写入 envelope，与 payload 无关）。mint 时丢弃 exp 字段。
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Backend Hub 级 MRTR 状态（保留 exp 用于诊断/兼容旧字段消费方）。
 *
 * 注：P7 后 exp 不再参与 mint payload（codec envelope 自带 ttl），保留仅为
 * 对外接口稳定；新代码不应依赖此字段。
 */
export interface HubState {
  serverId: string;
  toolName: string;
  upstreamRequestState?: string;
  step: number;
  exp: number;
}

export interface MrtrRelayServiceOptions {
  key: Uint8Array;
  ttlSeconds: number;
}

export interface RelayInput {
  inputRequests?: unknown;
  requestState?: string; // 上游的原始 state
}

export interface ResumeContext {
  isResume: boolean;
  serverId?: string;
  toolName?: string;
  upstreamRequestState?: string;
  step?: number;
}

export interface RelayResult {
  resultType: 'input_required';
  inputRequests?: unknown;
  requestState: string;
}

/**
 * 把 Uint8Array key 转 hex 字符串供 HubMrtrCodec（UTF-8 >= 32 bytes）使用。
 * 32 字节 → 64 hex 字符 → UTF-8 64 字节（满足 codec >= 32 bytes 约束）。
 */
function toHexKey(key: Uint8Array): string {
  return Array.from(key, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * MRTR 中转核心：用 protocol 包 HubMrtrCodec（HMAC-SHA256）mint Hub 级
 * requestState，作为 MRTR 多轮中转的 opaque 句柄。内部把 serverId/toolName/
 * upstreamRequestState/step 印封进 state，客户端回传后由 SDK seam 调 verify 还原。
 *
 * P7：底层 codec 从 SDK createRequestStateCodec 换成 HubMrtrCodec（protocol 包），
 * 与 cli 共用同一 HMAC 实现。对外接口（relay/resume/verify + 构造签名）保持不变。
 */
export class MrtrRelayService {
  private readonly codec: HubMrtrCodec;
  private readonly ttlSeconds: number;
  /**
   * verify 函数单例：缓存一次使 getter 每次返回同一引用
   * （group-service 注入 McpServer 构造的 verify 与 mrtrRelay.verify 引用相等）。
   */
  private readonly verifyFn: (state: string, ctx: ServerContext) => Promise<HubState>;

  constructor(opts: MrtrRelayServiceOptions) {
    this.codec = new HubMrtrCodec({
      key: toHexKey(opts.key),
      ttlSeconds: opts.ttlSeconds,
    });
    this.ttlSeconds = opts.ttlSeconds;
    // 构造时创建一次 verify 函数（闭包捕获 codec），getter 复用同一引用。
    this.verifyFn = this.createVerifyFn();
  }

  /**
   * 创建 verify 函数（构造时调用一次，缓存到 verifyFn）。
   */
  private createVerifyFn(): (state: string, ctx: ServerContext) => Promise<HubState> {
    return async (state: string, _ctx: ServerContext): Promise<HubState> => {
      // codec.verify 对空 token 返回 undefined；SDK seam 路径 token 非空（客户端回传的 state）。
      // 失败时 codec 抛错（fail-closed），由 SDK seam 转 -32602——与原实现一致。
      const restored = (await this.codec.verify(state)) as ProtocolHubState | undefined;
      if (!restored) {
        // 不应发生（SDK seam 路径 token 非空），防御性抛错
        throw new Error('MRTR verify 返回空 state（token 缺失）');
      }
      // ProtocolHubState（upstreamRequestState required, 无 exp）→ backend HubState
      // （upstreamRequestState optional, exp required）。补 exp=0 占位（不参与后续逻辑）。
      return {
        serverId: restored.serverId,
        toolName: restored.toolName,
        upstreamRequestState: restored.upstreamRequestState,
        step: restored.step,
        exp: 0,
      };
    };
  }

  /**
   * 注入 ServerOptions.requestState.verify。
   *
   * SDK seam 调用此函数验签客户端回传的 state。HubMrtrCodec.verify 是 async、
   * fail-closed（篡改/过期/密钥不匹配抛错 → SDK seam 回 -32602）。
   * 返回缓存的 verifyFn 引用（构造时创建一次）。
   */
  get verify(): (state: string, ctx: ServerContext) => Promise<HubState> {
    return this.verifyFn;
  }

  /** 上游返回 input_required → mint Hub state 返回给客户端 */
  async relay(
    serverId: string,
    toolName: string,
    upstream: RelayInput,
    step: number,
  ): Promise<RelayResult> {
    // ProtocolHubState：upstreamRequestState required（backend 可能为 undefined，
    // 序列化为 opaque payload；codec 不校验字段语义）。无 exp（codec envelope 自带 ttl）。
    const payload = {
      serverId,
      toolName,
      upstreamRequestState: upstream.requestState ?? '',
      step,
    } as ProtocolHubState;
    const requestState = await this.codec.mint(payload);
    // 用对象字面量构造（不经 inputRequired(...) builder）——builder 会重新 mint
    // 一份它自己的 state，此处需保留上游映射后的 Hub state。
    return {
      resultType: 'input_required',
      inputRequests: upstream.inputRequests,
      requestState,
    };
  }

  /** 读回已 verify 的 Hub state，还原上游上下文 */
  resume(currentState: HubState | undefined): ResumeContext {
    if (!currentState) {
      return { isResume: false };
    }
    return {
      isResume: true,
      serverId: currentState.serverId,
      toolName: currentState.toolName,
      upstreamRequestState: currentState.upstreamRequestState,
      step: currentState.step,
    };
  }
}
