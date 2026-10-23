import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SSEService } from '../sse';

type MockListener = (event: { data: string }) => void;

class MockEventSource {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;

  static instances: MockEventSource[] = [];

  url: string;
  readyState = MockEventSource.CONNECTING;
  onopen: (() => void) | null = null;
  onmessage: MockListener | null = null;
  onerror: ((error: unknown) => void) | null = null;
  close = vi.fn();
  private listeners = new Map<string, MockListener[]>();

  constructor(url: string) {
    this.url = url;
    MockEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: MockListener): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  emitTyped(type: string, data: string): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener({ data });
    }
  }
}

describe('SSEService', () => {
  let service: SSEService;

  beforeEach(() => {
    vi.useFakeTimers();
    MockEventSource.instances = [];
    vi.stubGlobal('EventSource', MockEventSource);
    service = new SSEService();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  const lastInstance = () => MockEventSource.instances[MockEventSource.instances.length - 1];

  describe('connect', () => {
    it('连接建立后 resolve 并携带订阅参数', async () => {
      const promise = service.connect(['server_status', 'tool_execution']);

      expect(lastInstance().url).toBe(
        '/api/dashboard/events?subscriptions=server_status%2Ctool_execution',
      );
      expect(service.getConnectionState()).toBe('connecting');

      lastInstance().readyState = MockEventSource.OPEN;
      lastInstance().onopen?.();

      await expect(promise).resolves.toBeUndefined();
      expect(service.getConnectionState()).toBe('open');
    });

    it('无订阅时不拼接查询参数', async () => {
      const promise = service.connect();

      expect(lastInstance().url).toBe('/api/dashboard/events');

      lastInstance().readyState = MockEventSource.OPEN;
      lastInstance().onopen?.();
      await promise;
    });

    it('已处于 OPEN 状态时直接 resolve 且不新建连接', async () => {
      const first = service.connect(['server_status']);
      lastInstance().readyState = MockEventSource.OPEN;
      lastInstance().onopen?.();
      await first;

      await expect(service.connect()).resolves.toBeUndefined();
      expect(MockEventSource.instances).toHaveLength(1);
    });

    it('连接进行中时重复调用会被拒绝', async () => {
      const first = service.connect(['server_status']);
      const second = service.connect();

      await expect(second).rejects.toThrow('已在连接中');

      // 结束第一个连接，避免悬挂 promise
      lastInstance().readyState = MockEventSource.OPEN;
      lastInstance().onopen?.();
      await first;
    });

    it('构造 EventSource 抛出异常时 reject', async () => {
      vi.stubGlobal(
        'EventSource',
        class Throwing {
          static readonly CONNECTING = 0;
          static readonly OPEN = 1;
          static readonly CLOSED = 2;
          constructor() {
            throw new Error('不支持 EventSource');
          }
        },
      );

      await expect(service.connect()).rejects.toThrow('不支持 EventSource');
    });

    it('连接错误时 reject', async () => {
      const promise = service.connect();

      lastInstance().readyState = MockEventSource.CLOSED;
      lastInstance().onerror?.(new Error('aborted'));

      await expect(promise).rejects.toBeDefined();
    });
  });

  describe('重连机制', () => {
    const failCurrent = () => {
      const instance = lastInstance();
      instance.readyState = MockEventSource.CLOSED;
      instance.onerror?.(new Error('connection lost'));
    };

    it('连接关闭后按指数退避重连，成功后停止', async () => {
      const promise = service.connect(['server_status']);
      failCurrent();
      await expect(promise).rejects.toBeDefined();

      // 第一次重连延迟 1000ms
      vi.advanceTimersByTime(999);
      expect(MockEventSource.instances).toHaveLength(1);

      vi.advanceTimersByTime(1);
      expect(MockEventSource.instances).toHaveLength(2);

      // 重连成功
      const reconnected = lastInstance();
      reconnected.readyState = MockEventSource.OPEN;
      reconnected.onopen?.();
      await vi.advanceTimersByTimeAsync(0);

      // 不再新建连接
      vi.advanceTimersByTime(60_000);
      expect(MockEventSource.instances).toHaveLength(2);
    });

    it('重连延迟逐次翻倍', async () => {
      const promise = service.connect();
      failCurrent();
      await expect(promise).rejects.toBeDefined();

      // 第一次重连：1000ms
      vi.advanceTimersByTime(1000);
      expect(MockEventSource.instances).toHaveLength(2);
      failCurrent();

      // 第二次重连：2000ms
      vi.advanceTimersByTime(1999);
      expect(MockEventSource.instances).toHaveLength(2);
      vi.advanceTimersByTime(1);
      expect(MockEventSource.instances).toHaveLength(3);
    });

    it('达到最大重连次数后停止重连', async () => {
      const promise = service.connect();
      failCurrent();
      await expect(promise).rejects.toBeDefined();

      // 初始连接 1 次 + 重连 5 次
      for (let i = 0; i < 5; i++) {
        vi.advanceTimersByTime(1000 * 2 ** i);
        expect(MockEventSource.instances).toHaveLength(2 + i);
        failCurrent();
      }

      vi.advanceTimersByTime(1_000_000);
      expect(MockEventSource.instances).toHaveLength(6);
    });

    it('连接错误但未关闭时不触发重连', async () => {
      const promise = service.connect();

      // readyState 仍为 CONNECTING（浏览器会自动重试）
      lastInstance().onerror?.(new Error('transient'));

      await expect(promise).rejects.toBeDefined();

      vi.advanceTimersByTime(60_000);
      expect(MockEventSource.instances).toHaveLength(1);
    });
  });

  describe('事件分发', () => {
    it('onmessage 按事件类型分发给处理器', async () => {
      const promise = service.connect();
      const handler = vi.fn();
      service.onServerStatus(handler);
      lastInstance().readyState = MockEventSource.OPEN;
      lastInstance().onopen?.();
      await promise;

      lastInstance().onmessage?.({
        data: JSON.stringify({ type: 'server_status', serverId: 's1', status: 'connected' }),
      });

      expect(handler).toHaveBeenCalledWith({
        type: 'server_status',
        serverId: 's1',
        status: 'connected',
      });
    });

    it('onmessage 收到非法 JSON 时不分发且不抛出', async () => {
      const promise = service.connect();
      const handler = vi.fn();
      service.onServerStatus(handler);
      lastInstance().readyState = MockEventSource.OPEN;
      lastInstance().onopen?.();
      await promise;

      expect(() => lastInstance().onmessage?.({ data: '{invalid' })).not.toThrow();
      expect(handler).not.toHaveBeenCalled();
    });

    it('为每个订阅类型注册监听并分发解析后的数据', async () => {
      const promise = service.connect(['tool_execution', 'system_alert']);
      const handler = vi.fn();
      service.onToolExecution(handler);
      lastInstance().readyState = MockEventSource.OPEN;
      lastInstance().onopen?.();
      await promise;

      const instance = lastInstance();
      instance.emitTyped('tool_execution', JSON.stringify({ toolName: 't1', success: true }));

      expect(handler).toHaveBeenCalledWith({ toolName: 't1', success: true });
    });

    it('特定类型事件的非法 JSON 不分发', async () => {
      const promise = service.connect(['health_check']);
      const handler = vi.fn();
      service.onHealthCheck(handler);
      lastInstance().readyState = MockEventSource.OPEN;
      lastInstance().onopen?.();
      await promise;

      expect(() => lastInstance().emitTyped('health_check', 'not-json')).not.toThrow();
      expect(handler).not.toHaveBeenCalled();
    });

    it('处理器抛出异常不影响其他处理器', async () => {
      const promise = service.connect();
      const good = vi.fn();
      service.addEventListener('activity', () => {
        throw new Error('handler error');
      });
      service.addEventListener('activity', good);
      lastInstance().readyState = MockEventSource.OPEN;
      lastInstance().onopen?.();
      await promise;

      expect(() =>
        lastInstance().onmessage?.({ data: JSON.stringify({ type: 'activity' }) }),
      ).not.toThrow();
      expect(good).toHaveBeenCalled();
    });

    it('系统告警与健康检查快捷注册生效', async () => {
      const promise = service.connect();
      const alertHandler = vi.fn();
      const healthHandler = vi.fn();
      service.onSystemAlert(alertHandler);
      service.onHealthCheck(healthHandler);
      lastInstance().readyState = MockEventSource.OPEN;
      lastInstance().onopen?.();
      await promise;

      lastInstance().onmessage?.({
        data: JSON.stringify({ type: 'system_alert', message: '告警' }),
      });
      lastInstance().onmessage?.({
        data: JSON.stringify({ type: 'health_check', status: 'healthy' }),
      });

      expect(alertHandler).toHaveBeenCalled();
      expect(healthHandler).toHaveBeenCalled();
    });
  });

  describe('监听器管理', () => {
    it('removeEventListener 移除指定处理器', async () => {
      const promise = service.connect();
      const handler = vi.fn();
      service.onServerStatus(handler);
      service.removeEventListener('server_status', handler);
      lastInstance().readyState = MockEventSource.OPEN;
      lastInstance().onopen?.();
      await promise;

      lastInstance().onmessage?.({ data: JSON.stringify({ type: 'server_status' }) });

      expect(handler).not.toHaveBeenCalled();
    });

    it('removeAllEventListeners 按类型清空', async () => {
      const promise = service.connect();
      const handler = vi.fn();
      service.onServerStatus(handler);
      service.removeAllEventListeners('server_status');
      lastInstance().readyState = MockEventSource.OPEN;
      lastInstance().onopen?.();
      await promise;

      lastInstance().onmessage?.({ data: JSON.stringify({ type: 'server_status' }) });

      expect(handler).not.toHaveBeenCalled();
    });

    it('removeAllEventListeners 无参时清空全部', async () => {
      const promise = service.connect();
      const a = vi.fn();
      const b = vi.fn();
      service.onServerStatus(a);
      service.onToolExecution(b);
      service.removeAllEventListeners();
      lastInstance().readyState = MockEventSource.OPEN;
      lastInstance().onopen?.();
      await promise;

      lastInstance().onmessage?.({ data: JSON.stringify({ type: 'server_status' }) });
      lastInstance().onmessage?.({ data: JSON.stringify({ type: 'tool_execution' }) });

      expect(a).not.toHaveBeenCalled();
      expect(b).not.toHaveBeenCalled();
    });
  });

  describe('getConnectionState / disconnect', () => {
    it('readyState 各取值映射正确', async () => {
      const promise = service.connect();
      lastInstance().readyState = MockEventSource.OPEN;
      lastInstance().onopen?.();
      await promise;

      lastInstance().readyState = MockEventSource.CONNECTING;
      expect(service.getConnectionState()).toBe('connecting');

      lastInstance().readyState = MockEventSource.OPEN;
      expect(service.getConnectionState()).toBe('open');

      lastInstance().readyState = MockEventSource.CLOSED;
      expect(service.getConnectionState()).toBe('closed');
    });

    it('disconnect 关闭连接并复位状态', async () => {
      const promise = service.connect();
      lastInstance().readyState = MockEventSource.OPEN;
      lastInstance().onopen?.();
      await promise;

      service.disconnect();

      expect(lastInstance().close).toHaveBeenCalled();
      expect(service.getConnectionState()).toBe('closed');
    });

    it('未建立连接时 disconnect 不报错', () => {
      expect(() => service.disconnect()).not.toThrow();
      expect(service.getConnectionState()).toBe('closed');
    });
  });
});
