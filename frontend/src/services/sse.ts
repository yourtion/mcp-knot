import { createParser } from 'eventsource-parser';

import { validateToken } from './auth';
// SSE (Server-Sent Events) 服务

import type {
  HealthCheckEvent,
  ServerStatusEvent,
  SSEEvent,
  SystemAlertEvent,
  ToolExecutionEvent,
} from '@/types/dashboard';

export type SSEEventType =
  | 'server_status'
  | 'tool_execution'
  | 'system_alert'
  | 'activity'
  | 'health_check';

export type SSEEventHandler<T = unknown> = (event: T) => void;

export class SSEService {
  private controller: AbortController | null = null;
  private state: 'connecting' | 'open' | 'closed' = 'closed';
  private stateListeners = new Set<(state: 'connecting' | 'open' | 'closed') => void>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private handlers: Map<SSEEventType, Set<SSEEventHandler>> = new Map();
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 5;
  private reconnectDelay = 1000; // 1秒
  private isConnecting = false;
  private subscriptions: string[] = [];

  onConnectionState(handler: (state: 'connecting' | 'open' | 'closed') => void): () => void {
    this.stateListeners.add(handler);
    return () => {
      this.stateListeners.delete(handler);
    };
  }

  private setState(state: 'connecting' | 'open' | 'closed') {
    this.state = state;
    this.stateListeners.forEach((handler) => handler(state));
  }

  constructor() {
    // 初始化事件处理器映射
    this.handlers.set('server_status', new Set());
    this.handlers.set('tool_execution', new Set());
    this.handlers.set('system_alert', new Set());
    this.handlers.set('activity', new Set());
    this.handlers.set('health_check', new Set());
  }

  /**
   * 连接到SSE端点
   */
  async connect(subscriptions: SSEEventType[] = []): Promise<void> {
    if (this.state === 'open') return;
    if (this.isConnecting) throw new Error('已在连接中');
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.controller?.abort();
    const controller = new AbortController();
    this.controller = controller;
    this.isConnecting = true;
    this.setState('connecting');
    this.subscriptions = subscriptions;
    const params = new URLSearchParams();
    if (subscriptions.length) params.set('subscriptions', subscriptions.join(','));
    const url = `/api/dashboard/events${params.size ? `?${params}` : ''}`;
    const open = () =>
      fetch(url, {
        headers: {
          Accept: 'text/event-stream',
          Authorization: `Bearer ${localStorage.getItem('auth_token') || ''}`,
        },
        signal: controller.signal,
      });
    try {
      let response = await open();
      // Reuse the ordinary authenticated API's refresh queue; never put tokens in URLs.
      if (response.status === 401 && (await validateToken()) && !controller.signal.aborted) {
        response = await open();
      }
      if (
        !response.ok ||
        !response.body ||
        !response.headers.get('content-type')?.includes('text/event-stream')
      ) {
        throw new Error(`SSE连接失败 (${response.status})`);
      }
      if (controller.signal.aborted) throw new DOMException('SSE已取消', 'AbortError');
      this.setState('open');
      this.isConnecting = false;
      this.reconnectAttempts = 0;
      void this.readStream(response.body, controller);
    } catch (error) {
      if (controller.signal.aborted || this.controller !== controller) throw error;
      this.setState('closed');
      this.isConnecting = false;
      this.attemptReconnect();
      throw error;
    }
  }

  private async readStream(body: ReadableStream<Uint8Array>, controller: AbortController) {
    const parser = createParser({
      onEvent: (event) => {
        try {
          const data = JSON.parse(event.data);
          if (event.event && event.event !== 'message') {
            this.handleTypedEvent(event.event as SSEEventType, data);
          } else {
            this.handleEvent(data as SSEEvent);
          }
        } catch (error) {
          console.error('解析SSE事件数据失败:', error);
        }
      },
    });
    const reader = body.getReader();
    const decoder = new TextDecoder();
    try {
      while (!controller.signal.aborted) {
        const { done, value } = await reader.read();
        if (done || controller.signal.aborted) break;
        parser.feed(decoder.decode(value, { stream: true }));
      }
    } catch (error) {
      if (!controller.signal.aborted) console.error('SSE连接错误:', error);
    } finally {
      reader.releaseLock();
      if (!controller.signal.aborted && this.controller === controller) {
        this.setState('closed');
        this.attemptReconnect();
      }
    }
  }

  disconnect(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.controller?.abort();
    this.controller = null;
    this.setState('closed');
    this.isConnecting = false;
    this.reconnectAttempts = 0;
  }

  getConnectionState(): 'connecting' | 'open' | 'closed' {
    return this.state;
  }

  /**
   * 添加事件监听器
   */
  addEventListener<T = unknown>(eventType: SSEEventType, handler: SSEEventHandler<T>): void {
    const handlers = this.handlers.get(eventType);
    if (handlers) {
      handlers.add(handler as SSEEventHandler);
    }
  }

  /**
   * 移除事件监听器
   */
  removeEventListener<T = unknown>(eventType: SSEEventType, handler: SSEEventHandler<T>): void {
    const handlers = this.handlers.get(eventType);
    if (handlers) {
      handlers.delete(handler as SSEEventHandler);
    }
  }

  /**
   * 移除所有事件监听器
   */
  removeAllEventListeners(eventType?: SSEEventType): void {
    if (eventType) {
      const handlers = this.handlers.get(eventType);
      if (handlers) {
        handlers.clear();
      }
    } else {
      this.handlers.forEach((handlers) => handlers.clear());
    }
  }

  /**
   * 处理通用SSE事件
   */
  private handleEvent(event: SSEEvent): void {
    console.log('收到SSE事件:', event);

    // 根据事件类型分发到对应的处理器
    const handlers = this.handlers.get(event.type);
    if (handlers) {
      handlers.forEach((handler) => {
        try {
          handler(event.data);
        } catch (error) {
          console.error(`处理${event.type}事件时发生错误:`, error);
        }
      });
    }
  }

  /**
   * 处理特定类型的事件
   */
  private handleTypedEvent(eventType: SSEEventType, data: unknown): void {
    const handlers = this.handlers.get(eventType);
    if (handlers) {
      handlers.forEach((handler) => {
        try {
          handler(data);
        } catch (error) {
          console.error(`处理${eventType}事件时发生错误:`, error);
        }
      });
    }
  }

  /**
   * 尝试重新连接
   */
  private attemptReconnect(): void {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.error('SSE重连次数已达上限，停止重连');
      return;
    }

    this.reconnectAttempts++;
    const delay = this.reconnectDelay * 2 ** (this.reconnectAttempts - 1); // 指数退避

    console.log(`${delay}ms后尝试第${this.reconnectAttempts}次SSE重连`);

    this.reconnectTimer = setTimeout(() => {
      this.connect(this.subscriptions as SSEEventType[])
        .then(() => {
          console.log('SSE重连成功');
        })
        .catch((error) => {
          console.error('SSE重连失败:', error);
        });
    }, delay);
  }

  /**
   * 添加服务器状态事件监听器
   */
  onServerStatus(handler: SSEEventHandler<ServerStatusEvent['data']>): void {
    this.addEventListener('server_status', handler);
  }

  /**
   * 添加工具执行事件监听器
   */
  onToolExecution(handler: SSEEventHandler<ToolExecutionEvent['data']>): void {
    this.addEventListener('tool_execution', handler);
  }

  /**
   * 添加系统告警事件监听器
   */
  onSystemAlert(handler: SSEEventHandler<SystemAlertEvent['data']>): void {
    this.addEventListener('system_alert', handler);
  }

  /**
   * 添加健康检查事件监听器
   */
  onHealthCheck(handler: SSEEventHandler<HealthCheckEvent['data']>): void {
    this.addEventListener('health_check', handler);
  }
}

// 创建全局SSE服务实例
export const sseService = new SSEService();
