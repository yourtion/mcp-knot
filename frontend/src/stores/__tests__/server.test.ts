import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useServerStore } from '../server';
import * as serverService from '@/services/server';

import type { ServerInfo, ServerListResponse } from '@/types/server';

vi.mock('@/services/server', () => ({
  getServers: vi.fn(),
  getServer: vi.fn(),
  createServer: vi.fn(),
  updateServer: vi.fn(),
  deleteServer: vi.fn(),
  getServerStatus: vi.fn(),
  connectServer: vi.fn(),
  disconnectServer: vi.fn(),
  testServer: vi.fn(),
  validateServer: vi.fn(),
}));

const mockServerService = serverService as unknown as Record<string, ReturnType<typeof vi.fn>>;

const makeServer = (overrides: Partial<ServerInfo> & Pick<ServerInfo, 'id'>): ServerInfo => ({
  name: `服务器 ${overrides.id}`,
  type: 'stdio',
  status: 'connected',
  config: { type: 'stdio', command: 'node', enabled: true },
  tools: [],
  toolCount: 0,
  ...overrides,
});

const makeListResponse = (servers: ServerInfo[]): ServerListResponse => ({
  servers,
  total: servers.length,
  summary: {
    total: servers.length,
    connected: servers.filter((s) => s.status === 'connected').length,
    connecting: servers.filter((s) => s.status === 'connecting').length,
    disconnected: servers.filter((s) => s.status === 'disconnected').length,
    error: servers.filter((s) => s.status === 'error').length,
  },
});

describe('Server Store', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('应该正确初始化状态', () => {
    const store = useServerStore();

    expect(store.servers.size).toBe(0);
    expect(store.loading).toBe(false);
    expect(store.error).toBeNull();
    expect(store.summary).toEqual({
      total: 0,
      connected: 0,
      connecting: 0,
      disconnected: 0,
      error: 0,
    });
  });

  describe('计算属性', () => {
    it('serverList / connectedServers / disconnectedServers 按状态划分', () => {
      const store = useServerStore();
      store.servers.set('a', makeServer({ id: 'a', status: 'connected' }));
      store.servers.set('b', makeServer({ id: 'b', status: 'disconnected' }));
      store.servers.set('c', makeServer({ id: 'c', status: 'error' }));

      expect(store.serverList.map((s) => s.id)).toEqual(['a', 'b', 'c']);
      expect(store.connectedServers.map((s) => s.id)).toEqual(['a']);
      expect(store.disconnectedServers.map((s) => s.id)).toEqual(['b']);
    });
  });

  describe('fetchServers', () => {
    it('成功时填充服务器列表和统计信息', async () => {
      const response = makeListResponse([
        makeServer({ id: 'a' }),
        makeServer({ id: 'b', status: 'disconnected' }),
      ]);
      mockServerService.getServers.mockResolvedValue(response);

      const store = useServerStore();
      store.servers.set('stale', makeServer({ id: 'stale' }));

      await store.fetchServers();

      expect(store.servers.size).toBe(2);
      expect(store.servers.has('stale')).toBe(false);
      expect(store.servers.get('a')?.name).toBe('服务器 a');
      expect(store.summary.total).toBe(2);
      expect(store.summary.connected).toBe(1);
      expect(store.summary.disconnected).toBe(1);
      expect(store.error).toBeNull();
    });

    it('请求期间处于加载状态', async () => {
      let resolveFn!: (value: ServerListResponse) => void;
      mockServerService.getServers.mockImplementation(
        () => new Promise<ServerListResponse>((resolve) => (resolveFn = resolve)),
      );

      const store = useServerStore();
      const pending = store.fetchServers();

      expect(store.loading).toBe(true);

      resolveFn(makeListResponse([]));
      await pending;
    });

    it('失败时记录默认错误消息且不抛出', async () => {
      mockServerService.getServers.mockRejectedValue('boom');

      const store = useServerStore();
      await expect(store.fetchServers()).resolves.toBeUndefined();

      expect(store.error).toBe('获取服务器列表失败');
      expect(store.loading).toBe(false);
    });
  });

  describe('fetchServer', () => {
    it('成功时写入服务器信息并返回', async () => {
      const server = makeServer({ id: 'a', toolCount: 5 });
      mockServerService.getServer.mockResolvedValue(server);

      const store = useServerStore();
      const result = await store.fetchServer('a');

      expect(result).toEqual(server);
      expect(store.servers.get('a')).toEqual(server);
      expect(mockServerService.getServer).toHaveBeenCalledWith('a');
    });

    it('失败时记录默认错误消息并向上抛出', async () => {
      mockServerService.getServer.mockRejectedValue('nope');

      const store = useServerStore();
      await expect(store.fetchServer('a')).rejects.toBe('nope');

      expect(store.error).toBe('获取服务器信息失败');
    });
  });

  describe('createServer', () => {
    it('成功后重新拉取服务器列表', async () => {
      mockServerService.createServer.mockResolvedValue({ id: 'a', message: 'ok' });
      mockServerService.getServers.mockResolvedValue(makeListResponse([makeServer({ id: 'a' })]));

      const store = useServerStore();
      const request = {
        id: 'a',
        config: { type: 'stdio' as const, command: 'node', enabled: true },
      };
      await store.createServer(request);

      expect(mockServerService.createServer).toHaveBeenCalledWith(request);
      expect(mockServerService.getServers).toHaveBeenCalledTimes(1);
      expect(store.servers.size).toBe(1);
      expect(store.loading).toBe(false);
    });

    it('失败时记录默认错误消息并向上抛出', async () => {
      mockServerService.createServer.mockRejectedValue('dup');

      const store = useServerStore();
      await expect(
        store.createServer({ id: 'a', config: { type: 'stdio', command: 'x', enabled: true } }),
      ).rejects.toBe('dup');

      expect(store.error).toBe('创建服务器失败');
      expect(store.loading).toBe(false);
    });
  });

  describe('updateServer', () => {
    it('成功后重新拉取服务器信息', async () => {
      mockServerService.updateServer.mockResolvedValue({ id: 'a', message: 'ok' });
      mockServerService.getServer.mockResolvedValue(makeServer({ id: 'a', toolCount: 7 }));

      const store = useServerStore();
      await store.updateServer('a', { config: { type: 'stdio', command: 'node2', enabled: true } });

      expect(mockServerService.updateServer).toHaveBeenCalledWith('a', {
        config: { type: 'stdio', command: 'node2', enabled: true },
      });
      expect(mockServerService.getServer).toHaveBeenCalledWith('a');
      expect(store.servers.get('a')?.toolCount).toBe(7);
    });

    it('失败时记录默认错误消息并向上抛出', async () => {
      mockServerService.updateServer.mockRejectedValue(0);

      const store = useServerStore();
      await expect(
        store.updateServer('a', { config: { type: 'stdio', command: 'x', enabled: true } }),
      ).rejects.toBe(0);

      expect(store.error).toBe('更新服务器失败');
    });
  });

  describe('deleteServer', () => {
    it('成功后从本地移除并刷新列表', async () => {
      mockServerService.deleteServer.mockResolvedValue({ id: 'a', message: 'ok' });
      mockServerService.getServers.mockResolvedValue(makeListResponse([]));

      const store = useServerStore();
      store.servers.set('a', makeServer({ id: 'a' }));

      await store.deleteServer('a');

      expect(mockServerService.deleteServer).toHaveBeenCalledWith('a');
      expect(store.servers.has('a')).toBe(false);
      expect(mockServerService.getServers).toHaveBeenCalledTimes(1);
    });

    it('失败时记录默认错误消息并向上抛出', async () => {
      mockServerService.deleteServer.mockRejectedValue('forbidden');

      const store = useServerStore();
      await expect(store.deleteServer('a')).rejects.toBe('forbidden');

      expect(store.error).toBe('删除服务器失败');
    });
  });

  describe('connectServer', () => {
    it('乐观更新为 connecting，成功后延迟刷新状态', async () => {
      const store = useServerStore();
      store.servers.set('a', makeServer({ id: 'a', status: 'disconnected' }));
      mockServerService.connectServer.mockResolvedValue({ id: 'a', message: 'ok' });
      mockServerService.getServer.mockResolvedValue(makeServer({ id: 'a', status: 'connected' }));

      await store.connectServer('a');

      expect(mockServerService.connectServer).toHaveBeenCalledWith('a');
      // 延迟刷新尚未执行
      expect(mockServerService.getServer).not.toHaveBeenCalled();

      vi.advanceTimersByTime(1000);
      // setTimeout 回调中的 fetchServer 是异步的，需刷新微任务
      await vi.advanceTimersByTimeAsync(0);

      expect(mockServerService.getServer).toHaveBeenCalledWith('a');
      expect(store.servers.get('a')?.status).toBe('connected');
    });

    it('服务器不存在时仍调用连接接口', async () => {
      mockServerService.connectServer.mockResolvedValue({ id: 'ghost', message: 'ok' });

      const store = useServerStore();
      await store.connectServer('ghost');

      expect(mockServerService.connectServer).toHaveBeenCalledWith('ghost');
      expect(store.error).toBeNull();
    });

    it('失败时回滚为 disconnected 并记录错误', async () => {
      const store = useServerStore();
      store.servers.set('a', makeServer({ id: 'a', status: 'connected' }));
      mockServerService.connectServer.mockRejectedValue(new Error('无法连接'));

      await expect(store.connectServer('a')).rejects.toThrow('无法连接');

      expect(store.servers.get('a')?.status).toBe('disconnected');
      expect(store.error).toBe('无法连接');
    });

    it('失败时非 Error 对象使用默认错误消息', async () => {
      mockServerService.connectServer.mockRejectedValue('x');

      const store = useServerStore();
      await expect(store.connectServer('a')).rejects.toBe('x');

      expect(store.error).toBe('连接服务器失败');
    });
  });

  describe('disconnectServer', () => {
    it('乐观更新为 disconnected，成功后延迟刷新状态', async () => {
      const store = useServerStore();
      store.servers.set('a', makeServer({ id: 'a', status: 'connected' }));
      mockServerService.disconnectServer.mockResolvedValue({ id: 'a', message: 'ok' });
      mockServerService.getServer.mockResolvedValue(
        makeServer({ id: 'a', status: 'disconnected' }),
      );

      await store.disconnectServer('a');

      expect(store.servers.get('a')?.status).toBe('disconnected');
      expect(mockServerService.getServer).not.toHaveBeenCalled();

      vi.advanceTimersByTime(1000);
      await vi.advanceTimersByTimeAsync(0);

      expect(mockServerService.getServer).toHaveBeenCalledWith('a');
    });

    it('失败时回滚为 connected 并记录默认错误消息', async () => {
      const store = useServerStore();
      store.servers.set('a', makeServer({ id: 'a', status: 'connected' }));
      mockServerService.disconnectServer.mockRejectedValue(null);

      await expect(store.disconnectServer('a')).rejects.toBeNull();

      expect(store.servers.get('a')?.status).toBe('connected');
      expect(store.error).toBe('断开服务器失败');
    });
  });

  describe('testServer / validateServer', () => {
    it('testServer 透传结果，失败时记录默认错误消息并抛出', async () => {
      const response = {
        success: true,
        message: 'ok',
        details: {
          status: 'connected' as const,
          toolCount: 0,
          tools: [],
          lastConnected: '',
        },
        executionTime: 10,
      };
      mockServerService.testServer.mockResolvedValue(response);

      const store = useServerStore();
      const config = { type: 'stdio' as const, command: 'node', enabled: true };
      await expect(store.testServer(config)).resolves.toEqual(response);

      mockServerService.testServer.mockRejectedValue('bad');
      await expect(store.testServer(config)).rejects.toBe('bad');
      expect(store.error).toBe('测试服务器失败');
    });

    it('validateServer 透传结果，失败时记录默认错误消息并抛出', async () => {
      const response = { isValid: true, errors: [], warnings: [], suggestions: [] };
      mockServerService.validateServer.mockResolvedValue(response);

      const store = useServerStore();
      const config = { type: 'sse' as const, url: 'http://x', enabled: true };
      await expect(store.validateServer(config)).resolves.toEqual(response);

      mockServerService.validateServer.mockRejectedValue(false);
      await expect(store.validateServer(config)).rejects.toBe(false);
      expect(store.error).toBe('验证服务器配置失败');
    });
  });

  describe('refreshServerStatus', () => {
    it('成功时更新本地服务器状态字段', async () => {
      const store = useServerStore();
      store.servers.set('a', makeServer({ id: 'a', status: 'disconnected' }));
      mockServerService.getServerStatus.mockResolvedValue({
        id: 'a',
        status: 'connected',
        lastConnected: '2024-01-01T00:00:00.000Z',
        reconnectAttempts: 2,
        toolCount: 9,
        isConnected: true,
        isConnecting: false,
        hasError: false,
      });

      await store.refreshServerStatus('a');

      const server = store.servers.get('a');
      expect(server?.status).toBe('connected');
      expect(server?.lastConnected).toBe('2024-01-01T00:00:00.000Z');
      expect(server?.reconnectAttempts).toBe(2);
      expect(server?.toolCount).toBe(9);
    });

    it('本地不存在该服务器时不报错', async () => {
      mockServerService.getServerStatus.mockResolvedValue({
        id: 'ghost',
        status: 'connected',
        reconnectAttempts: 0,
        toolCount: 0,
        isConnected: true,
        isConnecting: false,
        hasError: false,
      });

      const store = useServerStore();
      await expect(store.refreshServerStatus('ghost')).resolves.toBeUndefined();

      expect(store.servers.size).toBe(0);
    });

    it('失败时吞掉错误不影响状态', async () => {
      mockServerService.getServerStatus.mockRejectedValue(new Error('超时'));

      const store = useServerStore();
      await expect(store.refreshServerStatus('a')).resolves.toBeUndefined();

      expect(store.error).toBeNull();
    });
  });

  it('clearError 清除错误', () => {
    const store = useServerStore();
    store.error = '出错了';

    store.clearError();

    expect(store.error).toBeNull();
  });
});
