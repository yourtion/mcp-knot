/**
 * HealthMonitorService.stop() 清理定时器行为（真实 Node 定时器）。
 *
 * 注：stop() 依赖 Node Timer 内部属性（_onTimeout/_onImmediate）区分
 * interval/immediate 定时器类型，sinon fake timers 的定时器对象没有这些
 * 属性（stop 在 fake timers 下无法真正清理）。本文件全程使用真实定时器
 * + spy 全局 clearInterval/clearImmediate 验证清理行为，与使用 fake
 * timers 的 health-monitor-service.unit.test.ts 分离（vitest 按文件 fork，
 * 避免同文件内 fake/real 定时器切换的污染）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ServerStatus } from '../types/mcp-knot.js';
import { logger } from '../utils/logger.js';
import { HealthMonitorService } from './health-monitor-service.js';

import type { GroupManager, ServerManager } from '../types/mcp-knot.js';

vi.mock('../utils/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

describe('HealthMonitorService stop 清理（真实定时器）', () => {
  let onHealthCheck: ReturnType<typeof vi.fn>;
  let serverManager: ServerManager;
  let groupManager: GroupManager;

  beforeEach(() => {
    vi.clearAllMocks();
    onHealthCheck = vi.fn().mockResolvedValue(undefined);
    serverManager = {
      getAllServers: vi
        .fn()
        .mockReturnValue(
          new Map([['s1', { id: 's1', status: ServerStatus.CONNECTED, tools: [] }]]),
        ),
    } as unknown as ServerManager;
    groupManager = {
      getAllGroups: vi.fn().mockReturnValue(new Map()),
      getGroupServers: vi.fn().mockReturnValue([]),
    } as unknown as GroupManager;
  });

  it('stop 清理已注册的 interval 与 immediate 定时器', async () => {
    const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval');
    const clearImmediateSpy = vi.spyOn(globalThis, 'clearImmediate');

    const monitor = new HealthMonitorService(serverManager, groupManager, onHealthCheck);
    monitor.markInitialized();
    monitor.start();
    // 等待 setImmediate 初始检查执行完毕
    await new Promise<void>((resolve) => setImmediate(resolve));

    monitor.stop();
    expect(clearIntervalSpy).toHaveBeenCalled();
    expect(clearImmediateSpy).toHaveBeenCalled();
  });

  it('监控运行中 setEnabled(false) 立即停止定时器', () => {
    const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval');

    const monitor = new HealthMonitorService(serverManager, groupManager, onHealthCheck);
    monitor.markInitialized();
    monitor.start();

    monitor.setEnabled(false);
    expect(monitor.getLifecycleStatus().healthMonitoringEnabled).toBe(false);
    expect(clearIntervalSpy).toHaveBeenCalled();
  });

  it('stop 后到达原定间隔不再执行健康检查', async () => {
    const monitor = new HealthMonitorService(serverManager, groupManager, onHealthCheck);
    monitor.markInitialized();
    monitor.start();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(onHealthCheck).not.toHaveBeenCalled(); // 全部健康：不触发回调

    monitor.stop();
    // 之后再触发手动检查仍可用
    await expect(monitor.triggerCheck()).resolves.toBeUndefined();
    expect(monitor.getLifecycleStatus().lastHealthCheck).toBeTruthy();
  });

  it('stop 在初始 immediate 触发前调用可取消初始检查', async () => {
    // 断连服务器：若初始 immediate 未被真正清理，检查会触发 onHealthCheck 回调
    const disconnectedManager = {
      getAllServers: vi
        .fn()
        .mockReturnValue(
          new Map([['s1', { id: 's1', status: ServerStatus.DISCONNECTED, tools: [] }]]),
        ),
    } as unknown as ServerManager;
    const monitor = new HealthMonitorService(disconnectedManager, groupManager, onHealthCheck);
    monitor.start();
    monitor.stop();

    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    expect(onHealthCheck).not.toHaveBeenCalled();
  });

  it('清理定时器抛错被捕获并记录，不影响其余定时器清理', async () => {
    const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval');
    clearIntervalSpy.mockImplementationOnce(() => {
      throw new Error('clear boom');
    });

    const monitor = new HealthMonitorService(serverManager, groupManager, onHealthCheck);
    monitor.markInitialized();
    monitor.start();
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(() => monitor.stop()).not.toThrow();
    expect(logger.error).toHaveBeenCalledWith('清理定时器失败', expect.any(Error));
    clearIntervalSpy.mockRestore();
    monitor.stop();
  });
});
