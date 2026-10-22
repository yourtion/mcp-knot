import { describe, expect, it } from 'vitest';

import { MrtrRelayService } from './mrtr-relay-service.js';

function makeKey(): Uint8Array {
  const key = new Uint8Array(32);
  crypto.getRandomValues(key);
  return key;
}
const MOCK_CTX = {} as any; // verify 第二参数 ctx（生产由 SDK 传入）

describe('MrtrRelayService', () => {
  describe('relay + resume round-trip', () => {
    it('relay mint 的 state 可被 resume 还原', async () => {
      const relay = new MrtrRelayService({ key: makeKey(), ttlSeconds: 600 });
      const result = await relay.relay(
        's1',
        'tool_a',
        {
          inputRequests: { confirm: { type: 'elicitation', message: 'sure?' } },
          requestState: 'upstream-opaque-state',
        },
        1,
      );
      expect(result.resultType).toBe('input_required');
      expect(result.requestState).toBeTypeOf('string');
      expect(result.inputRequests).toBeDefined();

      // verify 还原（async，需 await + ctx）
      const hubState = await relay.verify(result.requestState!, MOCK_CTX);
      expect(hubState.serverId).toBe('s1');
      expect(hubState.toolName).toBe('tool_a');
      expect(hubState.upstreamRequestState).toBe('upstream-opaque-state');
      expect(hubState.step).toBe(1);

      // resume 语义
      const r = relay.resume(hubState);
      expect(r.isResume).toBe(true);
      expect(r.serverId).toBe('s1');
      expect(r.upstreamRequestState).toBe('upstream-opaque-state');
    });

    it('resume(undefined) 表示初次调用（非重试）', () => {
      const relay = new MrtrRelayService({ key: makeKey(), ttlSeconds: 600 });
      const r = relay.resume(undefined);
      expect(r.isResume).toBe(false);
    });
  });

  describe('安全性', () => {
    it('篡改的 state 被 verify 拒绝（抛错）', async () => {
      const relay = new MrtrRelayService({ key: makeKey(), ttlSeconds: 600 });
      const result = await relay.relay('s1', 't', {}, 1);
      const tampered = result.requestState!.slice(0, -4) + 'AAAA';
      await expect(relay.verify(tampered, MOCK_CTX)).rejects.toThrow();
    });

    it('过期 state 被 verify 拒绝', async () => {
      const relay = new MrtrRelayService({ key: makeKey(), ttlSeconds: 1 });
      const result = await relay.relay('s1', 't', {}, 1);
      // codec exp = floor(now_mint) + ttlSeconds；需 floor(now_verify) > exp，
      // 即至少跨越 2 个整数秒边界。等 2500ms 保证确定性（避免 mint/verify 落在同一秒）。
      await new Promise((r) => setTimeout(r, 2500));
      await expect(relay.verify(result.requestState!, MOCK_CTX)).rejects.toThrow();
    });

    it('不同 key mint 的 state 在本实例 verify 失败', async () => {
      const k1 = makeKey();
      const k2 = makeKey();
      const r1 = new MrtrRelayService({ key: k1, ttlSeconds: 600 });
      const r2 = new MrtrRelayService({ key: k2, ttlSeconds: 600 });
      const result = await r1.relay('s1', 't', {}, 1);
      await expect(r2.verify(result.requestState!, MOCK_CTX)).rejects.toThrow();
    });

    it('空 state verify 抛防御性错误（codec 对空 token 返回 undefined）', async () => {
      const relay = new MrtrRelayService({ key: makeKey(), ttlSeconds: 600 });
      await expect(relay.verify('', MOCK_CTX)).rejects.toThrow('MRTR verify 返回空 state');
    });
  });

  describe('step 审计字段（非 Hub 层安全防御）', () => {
    // step 是可观测审计字段（日志/追踪区分轮次），Hub 无状态无法独立做 step 单调性校验。
    // 真正防重放/防乱序由 codec TTL + HMAC 绑定负责（见上方「安全性」describe）。
    // 此处仅验证 step 作为字段的 round-trip 与多轮递增可观测性。
    it('relay 多轮 step 递增，每轮 mint 的 state 各自 verify 还原对应 step 与 upstreamRequestState', async () => {
      const relay = new MrtrRelayService({ key: makeKey(), ttlSeconds: 600 });
      const r1 = await relay.relay('s1', 't', { requestState: 'up1' }, 1);
      const s1 = await relay.verify(r1.requestState!, MOCK_CTX);
      expect(s1.step).toBe(1);
      expect(s1.upstreamRequestState).toBe('up1');
      const r2 = await relay.relay('s1', 't', { requestState: 'up2' }, 2);
      const s2 = await relay.verify(r2.requestState!, MOCK_CTX);
      expect(s2.step).toBe(2);
      expect(s2.upstreamRequestState).toBe('up2');
      // 每轮 mint 的 state 不同
      expect(r1.requestState).not.toBe(r2.requestState);
    });
  });

  describe('TTL 用配置 ttlSeconds（P7 迁移后 exp 在 codec envelope，非 payload）', () => {
    // P7 迁移：底层 codec 换成 protocol 包 HubMrtrCodec，exp 由 codec 按 ttlSeconds
    // 写入 HMAC envelope（不再放入 payload 字段）。故 verify 还原的 HubState.exp
    // 是占位值（0），不反映真实过期时间。真实过期由 codec envelope TTL 强制——
    // 此处验证「过期时间跟随配置 ttlSeconds」这一行为契约（而非 payload 的 exp 字段）：
    // ttlSeconds=1 时短延时即过期，ttlSeconds=600 时长延时不过期。

    it('ttlSeconds=1 时 mint 的 state 在 2.5s 后 verify 抛错（过期跟随配置 ttl）', async () => {
      const relay = new MrtrRelayService({ key: makeKey(), ttlSeconds: 1 });
      const r = await relay.relay('s1', 't', {}, 1);
      // 跨越 2 个整数秒边界保证 codec envelope 过期
      await new Promise((resolve) => setTimeout(resolve, 2500));
      await expect(relay.verify(r.requestState!, MOCK_CTX)).rejects.toThrow();
    });

    it('ttlSeconds=600 时 mint 的 state 短延时内 verify 成功（未过期）', async () => {
      const relay = new MrtrRelayService({ key: makeKey(), ttlSeconds: 600 });
      const r = await relay.relay('s1', 't', {}, 1);
      // 短延时（远小于 600s）应仍可 verify
      const hubState = await relay.verify(r.requestState!, MOCK_CTX);
      expect(hubState.serverId).toBe('s1');
      expect(hubState.step).toBe(1);
    });

    it('verify 还原的 HubState 字段正确（exp 为占位 0，非过期来源）', async () => {
      const relay = new MrtrRelayService({ key: makeKey(), ttlSeconds: 600 });
      const r = await relay.relay('s1', 't', { requestState: 'up' }, 3);
      const hubState = await relay.verify(r.requestState!, MOCK_CTX);
      expect(hubState.serverId).toBe('s1');
      expect(hubState.toolName).toBe('t');
      expect(hubState.upstreamRequestState).toBe('up');
      expect(hubState.step).toBe(3);
      // P7：exp 是占位值（真实过期在 codec envelope），不再反映 ttlSeconds
      expect(hubState.exp).toBe(0);
    });
  });
});
