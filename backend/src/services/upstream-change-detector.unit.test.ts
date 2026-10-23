// backend/src/services/upstream-change-detector.unit.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { UpstreamChangeDetector } from './upstream-change-detector.js';

describe('UpstreamChangeDetector', () => {
  describe('工具集签名比对', () => {
    it('工具名集合变化时触发 onChange', () => {
      const onChange = vi.fn();
      const detector = new UpstreamChangeDetector({
        onChange,
        pollIntervalMs: 60_000,
        pollBackoffMs: 300_000,
      });
      detector.saveSnapshot('s1', [{ name: 'tool_a' }, { name: 'tool_b' }]);
      // 模拟 listChanged 后重新拉取——工具集变化
      // onUpstreamNotification 内部会调外部 fetch 比对；为隔离，saveSnapshot+手动检测
      detector.saveSnapshot('s1', [{ name: 'tool_a' }, { name: 'tool_c' }]);
      detector.detectChanges('s1');
      expect(onChange).toHaveBeenCalledWith('s1');
    });

    it('仅描述变化（名字集合不变）不触发 onChange', () => {
      const onChange = vi.fn();
      const detector = new UpstreamChangeDetector({
        onChange,
        pollIntervalMs: 60_000,
        pollBackoffMs: 300_000,
      });
      detector.saveSnapshot('s1', [{ name: 'tool_a', description: 'old' }]);
      detector.saveSnapshot('s1', [{ name: 'tool_a', description: 'new' }]);
      detector.detectChanges('s1');
      expect(onChange).not.toHaveBeenCalled();
    });

    it('顺序不同但集合相同不触发', () => {
      const onChange = vi.fn();
      const detector = new UpstreamChangeDetector({
        onChange,
        pollIntervalMs: 60_000,
        pollBackoffMs: 300_000,
      });
      detector.saveSnapshot('s1', [{ name: 'b' }, { name: 'a' }]);
      detector.saveSnapshot('s1', [{ name: 'a' }, { name: 'b' }]);
      detector.detectChanges('s1');
      expect(onChange).not.toHaveBeenCalled();
    });

    it('签名以 | 连接：单工具 "a|b" 与两工具 [a,b] 的签名等价（不触发）', () => {
      const onChange = vi.fn();
      const detector = new UpstreamChangeDetector({
        onChange,
        pollIntervalMs: 60_000,
        pollBackoffMs: 300_000,
      });
      detector.saveSnapshot('s1', [{ name: 'a|b' }]);
      detector.saveSnapshot('s1', [{ name: 'a' }, { name: 'b' }]);
      detector.detectChanges('s1');
      // join('|') 下两者签名均为 "a|b"，不视为变更
      expect(onChange).not.toHaveBeenCalled();
    });

    it('未知 serverId 调用 detectChanges 不触发 onChange', () => {
      const onChange = vi.fn();
      const detector = new UpstreamChangeDetector({
        onChange,
        pollIntervalMs: 60_000,
        pollBackoffMs: 300_000,
      });
      detector.detectChanges('never-seen');
      expect(onChange).not.toHaveBeenCalled();
    });

    it('detectChanges 命中后推进 baseline：同一变更不重复触发', () => {
      const onChange = vi.fn();
      const detector = new UpstreamChangeDetector({
        onChange,
        pollIntervalMs: 60_000,
        pollBackoffMs: 300_000,
      });
      detector.saveSnapshot('s1', [{ name: 'a' }]);
      detector.saveSnapshot('s1', [{ name: 'a' }, { name: 'b' }]);
      detector.detectChanges('s1');
      expect(onChange).toHaveBeenCalledTimes(1);

      // 再次检测：baseline 已推进到 current，不重复触发
      detector.detectChanges('s1');
      expect(onChange).toHaveBeenCalledTimes(1);
    });

    it('onUpstreamNotification 立即触发 onChange（实时路径）', () => {
      const onChange = vi.fn();
      const detector = new UpstreamChangeDetector({
        onChange,
        pollIntervalMs: 60_000,
        pollBackoffMs: 300_000,
      });
      detector.onUpstreamNotification('s1');
      expect(onChange).toHaveBeenCalledWith('s1');
    });
  });

  describe('轮询兜底', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('轮询发现工具变化时触发 onChange', async () => {
      const onChange = vi.fn();
      const detector = new UpstreamChangeDetector({
        onChange,
        pollIntervalMs: 60_000,
        pollBackoffMs: 300_000,
      });
      // 模拟工具源：首次返回 [a]，60s 后返回 [a,b]
      let tools = [{ name: 'a' }];
      const getTools = vi.fn(async () => tools);
      await detector.startPolling(getTools, ['s1']);
      // 首次轮询已建立 baseline
      await vi.advanceTimersByTimeAsync(60_000);
      expect(onChange).not.toHaveBeenCalled(); // 首次无变化
      tools = [{ name: 'a' }, { name: 'b' }];
      await vi.advanceTimersByTimeAsync(60_000);
      expect(onChange).toHaveBeenCalledWith('s1');
      detector.stop();
    });

    it('曾主动推送的 server 在 pollBackoffMs 内被跳过', async () => {
      const onChange = vi.fn();
      const detector = new UpstreamChangeDetector({
        onChange,
        pollIntervalMs: 60_000,
        pollBackoffMs: 300_000,
      });
      detector.saveSnapshot('s1', [{ name: 'a' }]);
      detector.onUpstreamNotification('s1'); // 标记曾推送
      const getTools = vi.fn(async () => [{ name: 'a' }, { name: 'b' }]);
      await detector.startPolling(getTools, ['s1']);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(getTools).not.toHaveBeenCalledWith('s1'); // 跳过
      detector.stop();
    });

    it('未推送过的 server 正常轮询（backoff 只作用于近期推送过的）', async () => {
      const getTools = vi.fn(async () => [{ name: 'a' }]);
      const detector = new UpstreamChangeDetector({
        onChange: vi.fn(),
        pollIntervalMs: 60_000,
        pollBackoffMs: 300_000,
      });
      await detector.startPolling(getTools, ['s1']);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(getTools).toHaveBeenCalledWith('s1');
      detector.stop();
    });

    it('backoff 边界：距上次推送恰好等于 pollBackoffMs 时不再跳过', async () => {
      const getTools = vi.fn(async () => [{ name: 'a' }]);
      const detector = new UpstreamChangeDetector({
        onChange: vi.fn(),
        pollIntervalMs: 100,
        pollBackoffMs: 300,
      });
      detector.saveSnapshot('s1', [{ name: 'a' }]);
      detector.onUpstreamNotification('s1');
      await detector.startPolling(getTools, ['s1']);
      // 推进到 now - lastPush === pollBackoffMs（严格 < 才跳过）
      await vi.advanceTimersByTimeAsync(300);
      expect(getTools).toHaveBeenCalledWith('s1');
      detector.stop();
    });

    it('backoff 过期后恢复轮询（|| 变异：过期的 lastPush 不能永久跳过）', async () => {
      const getTools = vi.fn(async () => [{ name: 'a' }]);
      const detector = new UpstreamChangeDetector({
        onChange: vi.fn(),
        pollIntervalMs: 100,
        pollBackoffMs: 300,
      });
      detector.saveSnapshot('s1', [{ name: 'a' }]);
      detector.onUpstreamNotification('s1');
      await detector.startPolling(getTools, ['s1']);
      // 前 300ms 内的两轮都被跳过
      await vi.advanceTimersByTimeAsync(200);
      expect(getTools).not.toHaveBeenCalled();
      // 超过 backoff 窗口后恢复
      await vi.advanceTimersByTimeAsync(200);
      expect(getTools).toHaveBeenCalledWith('s1');
      detector.stop();
    });

    it('轮询 listTools 抛错时不影响其他 server', async () => {
      const onChange = vi.fn();
      const detector = new UpstreamChangeDetector({
        onChange,
        pollIntervalMs: 60_000,
        pollBackoffMs: 300_000,
      });
      const getTools = vi.fn(async (id: string) => {
        if (id === 'bad') throw new Error('disconnected');
        return [{ name: 'a' }];
      });
      await detector.startPolling(getTools, ['bad', 'good']);
      await vi.advanceTimersByTimeAsync(60_000);
      // good 仍被处理（不抛），bad 不崩
      expect(getTools).toHaveBeenCalledWith('good');
      detector.stop();
    });

    it('轮询失败时记录 logger.warn（serverId 与错误信息）', async () => {
      const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
      const detector = new UpstreamChangeDetector({
        onChange: vi.fn(),
        pollIntervalMs: 60_000,
        pollBackoffMs: 300_000,
        logger,
      });
      const getTools = vi.fn(async () => {
        throw new Error('disconnected');
      });
      await detector.startPolling(getTools, ['s1']);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(logger.warn).toHaveBeenCalledWith('上游工具轮询失败', {
        serverId: 's1',
        error: 'Error: disconnected',
      });
      detector.stop();
    });

    it('首次轮询（无历史签名）不触发 onChange', async () => {
      const onChange = vi.fn();
      const getTools = vi.fn(async () => [{ name: 'a' }]);
      const detector = new UpstreamChangeDetector({
        onChange,
        pollIntervalMs: 60_000,
        pollBackoffMs: 300_000,
      });
      await detector.startPolling(getTools, ['s1']);
      await vi.advanceTimersByTimeAsync(60_000);
      // prev === undefined：仅建立签名，不触发
      expect(onChange).not.toHaveBeenCalled();
      detector.stop();
    });

    it('stop() 清理轮询定时器：停止后不再触发轮询', async () => {
      const getTools = vi.fn(async () => [{ name: 'a' }]);
      const detector = new UpstreamChangeDetector({
        onChange: vi.fn(),
        pollIntervalMs: 60_000,
        pollBackoffMs: 300_000,
      });
      await detector.startPolling(getTools, ['s1']);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(getTools).toHaveBeenCalledTimes(1);

      detector.stop();
      await vi.advanceTimersByTimeAsync(180_000);
      expect(getTools).toHaveBeenCalledTimes(1);
    });
  });

  describe('getToolsFn 防御', () => {
    it('getToolsFn 缺失时 pollOnce 静默跳过（不调用、不告警）', async () => {
      const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
      const detector = new UpstreamChangeDetector({
        onChange: vi.fn(),
        pollIntervalMs: 60_000,
        pollBackoffMs: 300_000,
        logger,
      });
      // 直接调用私有 pollOnce（getToolsFn 尚未设置的场景）
      const internal = detector as unknown as {
        getToolsFn: null;
        pollOnce: (ids: string[]) => Promise<void>;
      };
      internal.getToolsFn = null;
      await expect(internal.pollOnce(['s1'])).resolves.toBeUndefined();
      expect(logger.warn).not.toHaveBeenCalled();
    });
  });
});
