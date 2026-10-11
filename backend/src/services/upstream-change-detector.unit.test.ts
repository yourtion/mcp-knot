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
  });
});
