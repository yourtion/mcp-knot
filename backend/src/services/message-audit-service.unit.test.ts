import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MessageAuditService } from './message-audit-service.js';

vi.mock('../utils/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    logToolExecution: vi.fn(),
    logServerConnection: vi.fn(),
    logToolDiscovery: vi.fn(),
  },
}));

describe('MessageAuditService', () => {
  let service: MessageAuditService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new MessageAuditService();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('addMessage / getMessages', () => {
    it('新增的消息排在最前（unshift 语义）', () => {
      service.addMessage('s1', 'request', 'tools/list', { a: 1 });
      service.addMessage('s2', 'response', 'tools/list', { b: 2 });

      const messages = service.getMessages(10);
      expect(messages).toHaveLength(2);
      expect(messages[0]?.serverId).toBe('s2');
      expect(messages[0]?.method).toBe('tools/list');
      expect(messages[0]?.type).toBe('response');
      expect(messages[0]?.content).toEqual({ b: 2 });
      expect(messages[1]?.serverId).toBe('s1');
    });

    it('每条消息带唯一 id 与 ISO 时间戳', () => {
      service.addMessage('s1', 'request', 'initialize', null);
      const [msg] = service.getMessages(1);
      expect(msg?.id).toBeTruthy();
      expect(typeof msg?.id).toBe('string');
      expect(new Date(msg?.timestamp ?? '').toISOString()).toBe(msg?.timestamp);
    });

    it('默认 limit 为 50，只返回最新的 50 条', () => {
      // 依次添加 60 条，后添加的在前
      for (let i = 0; i < 60; i++) {
        service.addMessage('s1', 'request', `m${i}`, i);
      }
      const messages = service.getMessages();
      expect(messages).toHaveLength(50);
      // 最新的是 m59
      expect(messages[0]?.content).toBe(59);
      expect(messages[49]?.content).toBe(10);
    });

    it('limit 小于消息总数时截断到 limit', () => {
      for (let i = 0; i < 10; i++) {
        service.addMessage('s1', 'notification', 'n', i);
      }
      expect(service.getMessages(3)).toHaveLength(3);
      expect(service.getMessages(3).map((m) => m.content)).toEqual([9, 8, 7]);
    });

    it('按 serverId 过滤', () => {
      service.addMessage('s1', 'request', 'a', 1);
      service.addMessage('s2', 'request', 'b', 2);
      service.addMessage('s1', 'response', 'c', 3);

      const filtered = service.getMessages(10, 's1');
      expect(filtered).toHaveLength(2);
      expect(filtered.every((m) => m.serverId === 's1')).toBe(true);
      expect(filtered.map((m) => m.method)).toEqual(['c', 'a']);
    });

    it('按 type 过滤', () => {
      service.addMessage('s1', 'request', 'a', 1);
      service.addMessage('s1', 'response', 'b', 2);
      service.addMessage('s1', 'notification', 'c', 3);

      const responses = service.getMessages(10, undefined, 'response');
      expect(responses).toHaveLength(1);
      expect(responses[0]?.method).toBe('b');
    });

    it('serverId 与 type 组合过滤（交集）', () => {
      service.addMessage('s1', 'request', 'a', 1);
      service.addMessage('s2', 'request', 'b', 2);
      service.addMessage('s2', 'response', 'c', 3);

      const filtered = service.getMessages(10, 's2', 'request');
      expect(filtered).toHaveLength(1);
      expect(filtered[0]?.method).toBe('b');
    });
  });

  describe('消息上限', () => {
    it('超过 500 条时裁剪最旧的消息（保留 500 条）', () => {
      for (let i = 0; i < 505; i++) {
        service.addMessage('s1', 'request', `m${i}`, i);
      }
      const messages = service.getMessages(1000);
      expect(messages).toHaveLength(500);
      // 最旧的 m0..m4 被裁剪，最新的是 m504
      expect(messages[0]?.content).toBe(504);
      expect(messages[499]?.content).toBe(5);
    });
  });

  describe('clearMessages', () => {
    it('清空所有消息', () => {
      service.addMessage('s1', 'request', 'a', 1);
      service.addMessage('s2', 'request', 'b', 2);
      service.clearMessages();
      expect(service.getMessages(10)).toHaveLength(0);
    });
  });

  describe('getPerformanceStats', () => {
    it('totalRequests 只统计 request 类型', () => {
      service.addMessage('s1', 'request', 'a', 1);
      service.addMessage('s1', 'request', 'b', 2);
      service.addMessage('s1', 'response', 'c', 3);
      service.addMessage('s1', 'notification', 'd', 4);

      const stats = service.getPerformanceStats();
      expect(stats.totalRequests).toBe(2);
      expect(stats.averageResponseTime).toBe(0);
      expect(stats.errorRate).toBe(0);
      expect(stats.topTools).toEqual([]);
    });

    it('无消息时统计归零', () => {
      const stats = service.getPerformanceStats();
      expect(stats.totalRequests).toBe(0);
      expect(stats.averageResponseTime).toBe(0);
      expect(stats.errorRate).toBe(0);
      expect(stats.topTools).toEqual([]);
    });
  });
});
