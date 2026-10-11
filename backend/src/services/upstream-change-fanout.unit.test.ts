// backend/src/services/upstream-change-fanout.unit.test.ts
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

import { UpstreamChangeFanout } from './upstream-change-fanout.js';

describe('UpstreamChangeFanout', () => {
  it('serverId 变更 fan-out 到所有含该 server 的 group', async () => {
    const getGroupsForServer = vi.fn(() => [{ groupId: 'g1' }, { groupId: 'g2' }]);
    const refreshGroupTools = vi.fn().mockResolvedValue(undefined);
    const publishToolListChanged = vi.fn();
    const fanout = new UpstreamChangeFanout({
      getGroupsForServer,
      refreshGroupTools,
      publishToolListChanged,
      debounceMs: 0,
    });
    await fanout.handleServerChange('s1');
    await fanout.flush();
    expect(refreshGroupTools).toHaveBeenCalledWith('g1', 's1');
    expect(refreshGroupTools).toHaveBeenCalledWith('g2', 's1');
    expect(publishToolListChanged).toHaveBeenCalledWith('g1');
    expect(publishToolListChanged).toHaveBeenCalledWith('g2');
  });

  it('无 group 含该 server 时不 publish', async () => {
    const getGroupsForServer = vi.fn(() => []);
    const publishToolListChanged = vi.fn();
    const fanout = new UpstreamChangeFanout({
      getGroupsForServer,
      refreshGroupTools: vi.fn().mockResolvedValue(undefined),
      publishToolListChanged,
      debounceMs: 0,
    });
    await fanout.handleServerChange('s1');
    await fanout.flush();
    expect(publishToolListChanged).not.toHaveBeenCalled();
  });

  it('一个 group refresh 失败不影响其他 group 的 publish', async () => {
    // 实现行为：refresh 与 publish 同处一个 try 块，refresh 抛错则该 group 不 publish，
    // catch 仅 logger.warn；per-group try/catch 保证失败不阻断其他 group。
    const getGroupsForServer = vi.fn(() => [{ groupId: 'g1' }, { groupId: 'g2' }]);
    const refreshGroupTools = vi.fn(async (groupId: string) => {
      if (groupId === 'g1') throw new Error('refresh failed');
    });
    const publishToolListChanged = vi.fn();
    const fanout = new UpstreamChangeFanout({
      getGroupsForServer,
      refreshGroupTools,
      publishToolListChanged,
      debounceMs: 0,
    });
    await fanout.handleServerChange('s1');
    await fanout.flush();
    // g1 refresh 失败 → 不 publish；g2 正常 → publish
    expect(publishToolListChanged).toHaveBeenCalledWith('g2');
    expect(publishToolListChanged).not.toHaveBeenCalledWith('g1');
    // 两边都被尝试 refresh（失败不短路）
    expect(refreshGroupTools).toHaveBeenCalledWith('g1', 's1');
    expect(refreshGroupTools).toHaveBeenCalledWith('g2', 's1');
  });
});

describe('防抖', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('debounceMs 内多次变更合并为一次 fan-out', async () => {
    const getGroupsForServer = vi.fn(() => [{ groupId: 'g1' }]);
    const refreshGroupTools = vi.fn().mockResolvedValue(undefined);
    const fanout = new UpstreamChangeFanout({
      getGroupsForServer,
      refreshGroupTools,
      publishToolListChanged: vi.fn(),
      debounceMs: 500,
    });
    fanout.handleServerChange('s1');
    fanout.handleServerChange('s1');
    fanout.handleServerChange('s1');
    await vi.advanceTimersByTimeAsync(500);
    expect(refreshGroupTools).toHaveBeenCalledTimes(1);
  });

  it('stop() 清空 pending timer 且不再触发 fan-out（P5 修复 I3）', async () => {
    const getGroupsForServer = vi.fn(() => [{ groupId: 'g1' }]);
    const refreshGroupTools = vi.fn().mockResolvedValue(undefined);
    const fanout = new UpstreamChangeFanout({
      getGroupsForServer,
      refreshGroupTools,
      publishToolListChanged: vi.fn(),
      debounceMs: 500,
    });
    // schedule 两个 pending 变更
    fanout.handleServerChange('s1');
    fanout.handleServerChange('s2');
    // stop 应清空所有 pending timer
    fanout.stop();
    // 推进时间后，timer 不再触发 → refresh 不被调用
    await vi.advanceTimersByTimeAsync(1000);
    expect(refreshGroupTools).not.toHaveBeenCalled();
  });
});
