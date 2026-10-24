import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { validateToken } from '../auth';
import { SSEService } from '../sse';

vi.mock('../auth', () => ({ validateToken: vi.fn() }));

describe('authenticated SSE transport', () => {
  let service: SSEService;
  let stream: ReadableStreamDefaultController<Uint8Array>;
  const fetchMock = vi.fn();
  const send = (data: string) => stream.enqueue(new TextEncoder().encode(data));
  const response = () =>
    new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          stream = controller;
        },
      }),
      { headers: { 'Content-Type': 'text/event-stream' } },
    );

  beforeEach(() => {
    vi.useFakeTimers();
    service = new SSEService();
    fetchMock.mockReset().mockResolvedValue(response());
    vi.stubGlobal('fetch', fetchMock);
    localStorage.setItem('auth_token', 'first-token');
  });
  afterEach(() => {
    service.disconnect();
    vi.unstubAllGlobals();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('sends bearer authentication without putting it in the URL', async () => {
    await service.connect(['server_status']);
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/dashboard/events?subscriptions=server_status',
      expect.objectContaining({
        headers: { Accept: 'text/event-stream', Authorization: 'Bearer first-token' },
      }),
    );
    expect(service.getConnectionState()).toBe('open');
    await service.connect();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('parses chunked UTF8, CRLF and named events without double dispatch', async () => {
    const event = vi.fn();
    service.onServerStatus(event);
    await service.connect();
    send('event: server_status\r\ndata: {"serverId":');
    send('"测试"}\r\n\r\n');
    await vi.waitFor(() => expect(event).toHaveBeenCalledWith({ serverId: '测试' }));
    expect(event).toHaveBeenCalledTimes(1);
  });

  it('dispatches unnamed envelopes and isolates malformed data/handler errors', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const event = vi.fn();
    service.onServerStatus(() => {
      throw new Error('listener');
    });
    service.onServerStatus(event);
    await service.connect();
    send('data: invalid\n\ndata: {"type":"server_status","data":{"status":"connected"}}\n\n');
    await vi.waitFor(() => expect(event).toHaveBeenCalledWith({ status: 'connected' }));
    expect(service.getConnectionState()).toBe('open');
  });

  it('refreshes through the ordinary auth service and retries with the new token', async () => {
    fetchMock.mockResolvedValueOnce(new Response('', { status: 401 }));
    vi.mocked(validateToken).mockImplementation(async () => {
      localStorage.setItem('auth_token', 'refreshed-token');
      return true;
    });
    await service.connect();
    expect(fetchMock).toHaveBeenLastCalledWith(
      '/api/dashboard/events',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer refreshed-token' }),
      }),
    );
  });

  it('rejects duplicate in-flight connections', async () => {
    const first = service.connect();
    await expect(service.connect()).rejects.toThrow('已在连接中');
    await first;
  });

  it('reconnects after EOF and cancels queued reconnects on disconnect', async () => {
    const states = vi.fn();
    service.onConnectionState(states);
    await service.connect();
    stream.close();
    await vi.waitFor(() => expect(service.getConnectionState()).toBe('closed'));
    service.disconnect();
    await vi.advanceTimersByTimeAsync(32000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(states).toHaveBeenCalledWith('closed');
  });

  it('aborts on navigation and does not start a reconnect', async () => {
    await service.connect();
    const signal = fetchMock.mock.calls[0][1].signal as AbortSignal;
    service.disconnect();
    expect(signal.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(32000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('reports HTTP failures and retries with bounded backoff', async () => {
    fetchMock.mockResolvedValue(new Response('', { status: 500 }));
    await expect(service.connect()).rejects.toThrow('500');
    service.disconnect();
    await vi.advanceTimersByTimeAsync(32000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
