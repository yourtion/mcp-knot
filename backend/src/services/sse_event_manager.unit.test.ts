import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SSEEventManager } from './sse_event_manager.js';

import type { SSEEvent } from '../types/dashboard.js';

vi.mock('../utils/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

/** 从 reader 读取 n 个 SSE 事件并解析 JSON data */
async function readEvents(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  count: number,
): Promise<SSEEvent[]> {
  const decoder = new TextDecoder();
  const events: SSEEvent[] = [];
  while (events.length < count) {
    const { done, value } = await reader.read();
    if (done) break;
    const text = decoder.decode(value, { stream: true });
    for (const line of text.split('\n\n')) {
      if (line.startsWith('data: ')) {
        events.push(JSON.parse(line.slice('data: '.length)) as SSEEvent);
      }
    }
  }
  return events;
}

describe('SSEEventManager', () => {
  let manager: SSEEventManager;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    manager = new SSEEventManager();
  });

  afterEach(() => {
    // 清理真实/伪造定时器，避免泄漏
    manager.shutdown();
    vi.useRealTimers();
  });

  const connect = async (subscriptions: string[] = []) => {
    const { response, clientId } = manager.createConnection(subscriptions);
    const reader = (response.body as ReadableStream<Uint8Array>).getReader();
    // 消费掉连接确认事件
    const [welcome] = await readEvents(reader, 1);
    return { response, clientId, reader, welcome };
  };

  describe('createConnection', () => {
    it('返回 SSE 响应头与连接确认事件', async () => {
      const { response, clientId, welcome } = await connect();

      expect(clientId).toMatch(/^client_/);
      expect(response.headers.get('Content-Type')).toBe('text/event-stream');
      expect(response.headers.get('Cache-Control')).toBe('no-cache');
      expect(response.headers.get('Connection')).toBe('keep-alive');
      expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');

      expect(welcome.type).toBe('system_alert');
      const data = welcome.data as { severity: string; message: string; category: string };
      expect(data.severity).toBe('info');
      expect(data.message).toBe('SSE连接已建立');
      expect(data.category).toBe('connection');
    });

    it('连接后客户端计入统计', async () => {
      const { clientId } = await connect();
      const stats = manager.getConnectionStats();
      expect(stats.totalClients).toBe(1);
      expect(stats.clients[0]?.id).toBe(clientId);
      expect(stats.clients[0]?.subscriptions).toEqual([]);
      expect(stats.eventHistoryCount).toBe(0);
    });

    it('订阅列表记录在客户端信息中', async () => {
      const { clientId } = await connect(['tool_execution', 'activity']);
      const stats = manager.getConnectionStats();
      expect(stats.clients[0]?.subscriptions.toSorted()).toEqual(['activity', 'tool_execution']);
      expect(clientId).toBeTruthy();
    });
  });

  describe('broadcast 订阅过滤', () => {
    it('未订阅（空列表）的客户端收到所有事件', async () => {
      const { reader } = await connect();
      manager.broadcastSystemAlert('warning', 'hello', 'test');
      const events = await readEvents(reader, 1);
      expect(events[0]?.type).toBe('system_alert');
    });

    it('订阅了特定类型的客户端只收到匹配的事件', async () => {
      const all = await connect([]);
      const subscribed = await connect(['tool_execution']);

      manager.broadcastSystemAlert('info', 'ignored', 'test');
      manager.broadcastToolExecution('tool1', 'srv1', 'default', true, 10);

      const allEvents = await readEvents(all.reader, 2);
      expect(allEvents.map((e) => e.type)).toEqual(['system_alert', 'tool_execution']);

      const subEvents = await readEvents(subscribed.reader, 1);
      expect(subEvents).toHaveLength(1);
      expect(subEvents[0]?.type).toBe('tool_execution');
    });

    it('broadcast 同时写入事件历史', async () => {
      await connect();
      manager.broadcastSystemAlert('info', 'a', 'c1');
      manager.broadcastSystemAlert('info', 'b', 'c2');
      expect(manager.getConnectionStats().eventHistoryCount).toBe(2);
    });
  });

  describe('各广播助手的事件负载', () => {
    it('broadcastServerStatus 携带服务器状态字段', async () => {
      const { reader } = await connect();
      manager.broadcastServerStatus('srv1', 'connected', 'connecting', undefined);
      const [event] = await readEvents(reader, 1);
      expect(event.type).toBe('server_status');
      expect(event.data).toMatchObject({
        serverId: 'srv1',
        status: 'connected',
        previousStatus: 'connecting',
      });
      expect(event.timestamp).toBeTruthy();
    });

    it('broadcastToolExecution 携带执行结果字段', async () => {
      const { reader } = await connect();
      manager.broadcastToolExecution('tool1', 'srv1', 'g1', false, 250, 'boom');
      const [event] = await readEvents(reader, 1);
      expect(event.type).toBe('tool_execution');
      expect(event.data).toMatchObject({
        toolName: 'tool1',
        serverId: 'srv1',
        groupId: 'g1',
        success: false,
        executionTime: 250,
        error: 'boom',
      });
    });

    it('broadcastSystemAlert 携带告警字段与 metadata', async () => {
      const { reader } = await connect();
      manager.broadcastSystemAlert('error', 'down', 'db', { retries: 3 });
      const [event] = await readEvents(reader, 1);
      expect(event.type).toBe('system_alert');
      expect(event.data).toMatchObject({
        severity: 'error',
        message: 'down',
        category: 'db',
        metadata: { retries: 3 },
      });
    });

    it('broadcastActivity 透传活动数据', async () => {
      const { reader } = await connect();
      manager.broadcastActivity({
        type: 'tool_executed',
        message: 'done',
        severity: 'info',
      } as never);
      const [event] = await readEvents(reader, 1);
      expect(event.type).toBe('activity');
      expect(event.data).toMatchObject({ type: 'tool_executed', message: 'done' });
    });

    it('broadcastHealthCheck 携带状态与变更列表', async () => {
      const { reader } = await connect();
      const changes = [{ component: 'db', previousStatus: 'up', currentStatus: 'down' }];
      manager.broadcastHealthCheck('error', changes);
      const [event] = await readEvents(reader, 1);
      expect(event.type).toBe('health_check');
      expect(event.data).toMatchObject({ status: 'error', changes });
    });
  });

  describe('事件历史回放', () => {
    it('新连接收到最近 10 条历史事件（且按订阅过滤）', async () => {
      // 先广播 12 条事件进历史
      for (let i = 1; i <= 12; i++) {
        manager.broadcastSystemAlert('info', `msg${i}`, 'history');
      }

      // 未订阅过滤的新客户端：欢迎事件 + 10 条历史
      const { response } = manager.createConnection();
      const reader = (response.body as ReadableStream<Uint8Array>).getReader();
      const events = await readEvents(reader, 11);
      expect(events[0]?.type).toBe('system_alert');
      expect(events[0]?.data).toMatchObject({ message: 'SSE连接已建立' });
      const history = events.slice(1) as Array<{ data: { message: string } }>;
      expect(history.map((e) => e.data.message)).toEqual(
        Array.from({ length: 10 }, (_, i) => `msg${i + 3}`),
      );
    });

    it('订阅了其他类型的客户端不收到不匹配的历史事件', async () => {
      manager.broadcastSystemAlert('info', 'alert1', 'c');
      manager.broadcastActivity({ type: 'error', message: 'act1', severity: 'error' } as never);

      const { response } = manager.createConnection(['activity']);
      const reader = (response.body as ReadableStream<Uint8Array>).getReader();
      const events = await readEvents(reader, 2);
      expect(events.map((e) => e.type)).toEqual(['system_alert', 'activity']);
    });

    it('历史记录上限 100 条', () => {
      for (let i = 0; i < 105; i++) {
        manager.broadcastSystemAlert('info', `m${i}`, 'c');
      }
      expect(manager.getConnectionStats().eventHistoryCount).toBe(100);
    });
  });

  describe('updateClientSubscriptions', () => {
    it('更新已有客户端订阅并生效', async () => {
      const { reader } = await connect([]);
      expect(
        manager.updateClientSubscriptions((await manager.getConnectionStats()).clients[0].id, [
          'server_status',
        ]),
      ).toBe(true);

      manager.broadcastSystemAlert('info', 'dropped', 'c');
      manager.broadcastServerStatus('srv', 'connected');

      const [event] = await readEvents(reader, 1);
      expect(event.type).toBe('server_status');
    });

    it('客户端不存在时返回 false', () => {
      expect(manager.updateClientSubscriptions('nope', ['x'])).toBe(false);
    });
  });

  describe('连接取消', () => {
    it('流 cancel 后客户端被移除', async () => {
      const { response, clientId } = manager.createConnection();
      const reader = (response.body as ReadableStream<Uint8Array>).getReader();
      await readEvents(reader, 1); // 欢迎事件
      expect(manager.getConnectionStats().totalClients).toBe(1);

      await reader.cancel();
      const stats = manager.getConnectionStats();
      expect(stats.totalClients).toBe(0);
      expect(stats.clients.find((c) => c.id === clientId)).toBeUndefined();
    });
  });

  describe('ping 与超时清理', () => {
    it('到达 ping 间隔时向客户端发送 ping 并更新 lastPing', async () => {
      const { reader } = await connect();
      await vi.advanceTimersByTimeAsync(30_000);

      const events = await readEvents(reader, 1);
      const ping = events[0] as unknown as { type: string; timestamp: string };
      expect(ping.type).toBe('ping');
      expect(ping.timestamp).toBeTruthy();

      // lastPing 已更新：再过 30s 不会被超时清理
      await vi.advanceTimersByTimeAsync(30_000);
      expect(manager.getConnectionStats().totalClients).toBe(1);
    });

    it('超过客户端超时时间未 ping 的连接被移除', async () => {
      await connect();
      expect(manager.getConnectionStats().totalClients).toBe(1);

      // 推进系统时间超过 60s 客户端超时阈值，再触发 ping 周期
      vi.setSystemTime(new Date(Date.now() + 61_000));
      await vi.advanceTimersByTimeAsync(30_000);

      expect(manager.getConnectionStats().totalClients).toBe(0);
    });
  });

  describe('shutdown', () => {
    it('关闭所有客户端、清空历史并停止定时器', async () => {
      await connect();
      await connect();
      manager.broadcastSystemAlert('info', 'm', 'c');
      expect(manager.getConnectionStats().totalClients).toBe(2);

      manager.shutdown();

      const stats = manager.getConnectionStats();
      expect(stats.totalClients).toBe(0);
      expect(stats.eventHistoryCount).toBe(0);

      // 定时器已停止：推进时间不再产生新 ping（无客户端也无从判断，
      // 但 shutdown 后再推进不应抛错）
      await vi.advanceTimersByTimeAsync(120_000);
      expect(manager.getConnectionStats().totalClients).toBe(0);
    });
  });

  describe('连接数上限', () => {
    it('达到最大连接数后拒绝新连接', () => {
      const clients: Array<ReturnType<typeof manager.createConnection>> = [];
      for (let i = 0; i < 1000; i++) {
        clients.push(manager.createConnection());
      }
      expect(manager.getConnectionStats().totalClients).toBe(1000);

      expect(() => manager.createConnection()).toThrowError(/最大SSE连接数限制/);

      // 释放流
      for (const c of clients) {
        void c.response.body?.cancel();
      }
    });
  });
});
