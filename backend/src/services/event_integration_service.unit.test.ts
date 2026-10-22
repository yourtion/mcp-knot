import { beforeEach, describe, expect, it, vi } from 'vitest';

import { EventIntegrationService } from './event_integration_service.js';

import type { DashboardService } from './dashboard_service.js';
import type { SSEEventManager } from './sse_event_manager.js';

vi.mock('../utils/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

describe('EventIntegrationService', () => {
  let service: EventIntegrationService;
  let dashboardService: DashboardService;
  let sseEventManager: SSEEventManager;

  beforeEach(() => {
    vi.clearAllMocks();
    dashboardService = {
      addActivity: vi.fn(),
      recordToolExecution: vi.fn(),
      addLog: vi.fn(),
    } as unknown as DashboardService;
    sseEventManager = {
      broadcastServerStatus: vi.fn(),
      broadcastToolExecution: vi.fn(),
      broadcastSystemAlert: vi.fn(),
      broadcastHealthCheck: vi.fn(),
    } as unknown as SSEEventManager;
    service = new EventIntegrationService(dashboardService, sseEventManager);
  });

  describe('recordServerStatusChange', () => {
    it('记录活动并广播服务器状态事件', () => {
      service.recordServerStatusChange('srv1', 'connected', 'disconnected');

      expect(dashboardService.addActivity).toHaveBeenCalledTimes(1);
      const activity = vi.mocked(dashboardService.addActivity).mock.calls[0][0];
      expect(activity.type).toBe('server_connected');
      expect(activity.message).toContain('srv1');
      expect(activity.message).toContain('disconnected -> connected');
      expect(activity.severity).toBe('info');
      expect(activity.metadata).toEqual({
        serverId: 'srv1',
        newStatus: 'connected',
        previousStatus: 'disconnected',
        error: undefined,
      });

      expect(sseEventManager.broadcastServerStatus).toHaveBeenCalledWith(
        'srv1',
        'connected',
        'disconnected',
        undefined,
      );
      // 非错误状态不发送系统告警
      expect(sseEventManager.broadcastSystemAlert).not.toHaveBeenCalled();
    });

    it('无 previousStatus 时活动消息显示未知', () => {
      service.recordServerStatusChange('srv1', 'connected');
      const activity = vi.mocked(dashboardService.addActivity).mock.calls[0][0];
      expect(activity.message).toContain('未知 -> connected');
    });

    it('error 状态的活动 severity 为 error', () => {
      service.recordServerStatusChange('srv1', 'error', 'connected');
      const activity = vi.mocked(dashboardService.addActivity).mock.calls[0][0];
      expect(activity.severity).toBe('error');
    });

    it('其他状态（如 disconnected）的活动 severity 为 warning', () => {
      service.recordServerStatusChange('srv1', 'disconnected', 'connected');
      const activity = vi.mocked(dashboardService.addActivity).mock.calls[0][0];
      expect(activity.severity).toBe('warning');
    });

    it('error 状态且带 error 信息时额外发送系统告警', () => {
      service.recordServerStatusChange('srv1', 'error', 'connected', 'ECONNREFUSED');

      expect(sseEventManager.broadcastSystemAlert).toHaveBeenCalledTimes(1);
      const [severity, message, category, metadata] = vi.mocked(
        sseEventManager.broadcastSystemAlert,
      ).mock.calls[0];
      expect(severity).toBe('error');
      expect(message).toContain('srv1');
      expect(message).toContain('ECONNREFUSED');
      expect(category).toBe('server_connection');
      expect(metadata).toEqual({ serverId: 'srv1', error: 'ECONNREFUSED' });
    });

    it('error 状态但无 error 信息时不发送系统告警', () => {
      service.recordServerStatusChange('srv1', 'error', 'connected', undefined);
      expect(sseEventManager.broadcastSystemAlert).not.toHaveBeenCalled();
    });
  });

  describe('recordToolExecution', () => {
    it('成功执行：记录统计 + 活动 + SSE 事件，无告警', () => {
      service.recordToolExecution('tool1', 'srv1', 'default', 120, true);

      expect(dashboardService.recordToolExecution).toHaveBeenCalledWith('tool1', 120, true);

      const activity = vi.mocked(dashboardService.addActivity).mock.calls[0][0];
      expect(activity.type).toBe('tool_executed');
      expect(activity.message).toBe('工具 tool1 执行成功 (120ms)');
      expect(activity.severity).toBe('info');
      expect(activity.metadata).toEqual({
        toolName: 'tool1',
        serverId: 'srv1',
        groupId: 'default',
        executionTime: 120,
        success: true,
        error: undefined,
      });

      expect(sseEventManager.broadcastToolExecution).toHaveBeenCalledWith(
        'tool1',
        'srv1',
        'default',
        true,
        120,
        undefined,
      );
      expect(sseEventManager.broadcastSystemAlert).not.toHaveBeenCalled();
    });

    it('失败执行且带错误：活动 severity error 并发送 warning 告警', () => {
      service.recordToolExecution('tool1', 'srv1', 'default', 200, false, 'boom');

      const activity = vi.mocked(dashboardService.addActivity).mock.calls[0][0];
      expect(activity.message).toBe('工具 tool1 执行失败: boom');
      expect(activity.severity).toBe('error');

      expect(sseEventManager.broadcastToolExecution).toHaveBeenCalledWith(
        'tool1',
        'srv1',
        'default',
        false,
        200,
        'boom',
      );

      expect(sseEventManager.broadcastSystemAlert).toHaveBeenCalledTimes(1);
      const [severity, message, category, metadata] = vi.mocked(
        sseEventManager.broadcastSystemAlert,
      ).mock.calls[0];
      expect(severity).toBe('warning');
      expect(message).toBe('工具执行失败: tool1 - boom');
      expect(category).toBe('tool_execution');
      expect(metadata).toEqual({
        toolName: 'tool1',
        serverId: 'srv1',
        groupId: 'default',
        error: 'boom',
      });
    });

    it('失败执行但无错误信息：活动消息为未知错误，不发送告警', () => {
      service.recordToolExecution('tool1', 'srv1', 'default', 50, false);

      const activity = vi.mocked(dashboardService.addActivity).mock.calls[0][0];
      expect(activity.message).toBe('工具 tool1 执行失败: 未知错误');
      expect(activity.severity).toBe('error');
      expect(sseEventManager.broadcastSystemAlert).not.toHaveBeenCalled();
    });
  });

  describe('recordSystemError', () => {
    it('记录 error 活动并广播 error 级系统告警', () => {
      service.recordSystemError('磁盘已满', 'storage', { disk: '/dev/sda1' });

      const activity = vi.mocked(dashboardService.addActivity).mock.calls[0][0];
      expect(activity.type).toBe('error');
      expect(activity.message).toBe('系统错误: 磁盘已满');
      expect(activity.severity).toBe('error');
      expect(activity.metadata).toEqual({ category: 'storage', disk: '/dev/sda1' });

      expect(sseEventManager.broadcastSystemAlert).toHaveBeenCalledWith(
        'error',
        '磁盘已满',
        'storage',
        { disk: '/dev/sda1' },
      );
    });
  });

  describe('recordConfigChange', () => {
    it('记录 info 活动并广播 configuration 告警', () => {
      service.recordConfigChange('system', '修改端口');

      const activity = vi.mocked(dashboardService.addActivity).mock.calls[0][0];
      expect(activity.type).toBe('system_start');
      expect(activity.message).toBe('配置变更: 修改端口');
      expect(activity.severity).toBe('info');
      expect(activity.metadata).toEqual({ configType: 'system', description: '修改端口' });

      expect(sseEventManager.broadcastSystemAlert).toHaveBeenCalledWith(
        'info',
        '配置已更新: 修改端口',
        'configuration',
        { configType: 'system' },
      );
    });
  });

  describe('recordSystemStart', () => {
    it('记录系统启动活动并广播 lifecycle 告警', () => {
      service.recordSystemStart();

      const activity = vi.mocked(dashboardService.addActivity).mock.calls[0][0];
      expect(activity.type).toBe('system_start');
      expect(activity.message).toBe('MCP Knot 系统启动完成');
      expect(activity.severity).toBe('info');

      expect(sseEventManager.broadcastSystemAlert).toHaveBeenCalledWith(
        'info',
        'MCP Knot 系统已启动',
        'system_lifecycle',
      );
    });
  });

  describe('recordHealthCheck', () => {
    it('无状态变更时不做任何记录', () => {
      service.recordHealthCheck('healthy', []);

      expect(dashboardService.addActivity).not.toHaveBeenCalled();
      expect(sseEventManager.broadcastHealthCheck).not.toHaveBeenCalled();
      expect(sseEventManager.broadcastSystemAlert).not.toHaveBeenCalled();
    });

    it('healthy 状态带变更：记录 info 活动并广播健康事件，无告警', () => {
      const changes = [
        { component: 'server1', previousStatus: 'error', currentStatus: 'connected' },
      ];
      service.recordHealthCheck('healthy', changes);

      const activity = vi.mocked(dashboardService.addActivity).mock.calls[0][0];
      expect(activity.message).toBe('健康检查状态变更: server1: error -> connected');
      expect(activity.severity).toBe('info');
      expect(activity.metadata).toEqual({ status: 'healthy', changes });

      expect(sseEventManager.broadcastHealthCheck).toHaveBeenCalledWith('healthy', changes);
      expect(sseEventManager.broadcastSystemAlert).not.toHaveBeenCalled();
    });

    it('warning 状态：活动 severity warning，告警 severity warning', () => {
      const changes = [{ component: 'db', previousStatus: 'healthy', currentStatus: 'degraded' }];
      service.recordHealthCheck('warning', changes);

      expect(vi.mocked(dashboardService.addActivity).mock.calls[0][0].severity).toBe('warning');
      expect(sseEventManager.broadcastSystemAlert).toHaveBeenCalledTimes(1);
      const [severity, , category] = vi.mocked(sseEventManager.broadcastSystemAlert).mock.calls[0];
      expect(severity).toBe('warning');
      expect(category).toBe('health_check');
    });

    it('error 状态：活动 severity error，告警 severity error', () => {
      const changes = [{ component: 'db', previousStatus: 'degraded', currentStatus: 'down' }];
      service.recordHealthCheck('error', changes);

      expect(vi.mocked(dashboardService.addActivity).mock.calls[0][0].severity).toBe('error');
      const [severity, message] = vi.mocked(sseEventManager.broadcastSystemAlert).mock.calls[0];
      expect(severity).toBe('error');
      expect(message).toContain('系统健康检查发现问题');
    });

    it('多条变更消息用逗号连接', () => {
      const changes = [
        { component: 'a', previousStatus: 'x', currentStatus: 'y' },
        { component: 'b', previousStatus: 'y', currentStatus: 'z' },
      ];
      service.recordHealthCheck('healthy', changes);
      expect(vi.mocked(dashboardService.addActivity).mock.calls[0][0].message).toBe(
        '健康检查状态变更: a: x -> y, b: y -> z',
      );
    });
  });

  describe('addLog', () => {
    it('透传给 DashboardService.addLog', () => {
      service.addLog('warn', '磁盘空间不足', 'storage', { percent: 91 });

      expect(dashboardService.addLog).toHaveBeenCalledWith({
        level: 'warn',
        message: '磁盘空间不足',
        category: 'storage',
        metadata: { percent: 91 },
      });
    });
  });
});
