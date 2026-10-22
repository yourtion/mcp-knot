import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useConfigStore } from '../config';
import { configService } from '@/services/config';

import type {
  ConfigBackup,
  ConfigData,
  ConfigHistoryResponse,
  ConfigPreview,
  ConfigTestResult,
  ConfigValidationResponse,
} from '@/types/config';

vi.mock('@/services/config', () => ({
  configService: {
    getCurrentConfig: vi.fn(),
    updateConfig: vi.fn(),
    validateConfig: vi.fn(),
    testConfig: vi.fn(),
    previewConfigChanges: vi.fn(),
    getConfigHistory: vi.fn(),
    createBackup: vi.fn(),
    restoreFromBackup: vi.fn(),
    getBackupList: vi.fn(),
  },
}));

const mockConfigService = vi.mocked(configService);

const makeConfigData = (): ConfigData => ({
  system: {
    server: { port: 3000, host: '0.0.0.0' },
    auth: {
      jwt: { secret: 's', expiresIn: '1h', refreshExpiresIn: '7d', issuer: 'mcp' },
      security: {
        maxLoginAttempts: 5,
        lockoutDuration: 300,
        passwordMinLength: 8,
        requireStrongPassword: true,
      },
    },
    users: {},
    ui: {
      title: 'MCP Knot',
      theme: 'auto',
      features: { apiToMcp: true, debugging: true, monitoring: true },
    },
    monitoring: { metricsEnabled: true, logLevel: 'info', retentionDays: 30 },
  },
  mcp: { servers: {} },
  groups: {},
  lastUpdated: '2024-01-01T00:00:00.000Z',
  version: '1.0.0',
});

const makeHistoryResponse = (count: number, total: number): ConfigHistoryResponse => ({
  history: Array.from({ length: count }, (_, i) => ({
    id: `entry-${i}`,
    configType: 'system' as const,
    timestamp: '2024-01-01T00:00:00.000Z',
    changes: [],
    user: 'admin',
    version: '1.0.0',
  })),
  total,
  limit: 50,
  offset: 0,
});

describe('Config Store', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
  });

  it('应该正确初始化状态和计算属性', () => {
    const store = useConfigStore();

    expect(store.configData).toBeNull();
    expect(store.loading).toBe(false);
    expect(store.error).toBeNull();
    expect(store.formData).toBeNull();
    expect(store.validationResult).toBeNull();
    expect(store.testResult).toBeNull();
    expect(store.previewResult).toBeNull();
    expect(store.historyEntries).toEqual([]);
    expect(store.historyTotal).toBe(0);
    expect(store.backups).toEqual([]);
    expect(store.backupTotal).toBe(0);
    expect(store.searchFilter).toEqual({
      keyword: '',
      configType: undefined,
      category: undefined,
      showAdvanced: false,
    });
    expect(store.isLoading).toBe(false);
    expect(store.hasError).toBe(false);
    expect(store.hasConfigData).toBe(false);
    expect(store.isFormDirty).toBe(false);
    expect(store.hasValidationErrors).toBe(false);
  });

  describe('fetchConfig', () => {
    it('成功时保存配置数据', async () => {
      const data = makeConfigData();
      mockConfigService.getCurrentConfig.mockResolvedValue(data);

      const store = useConfigStore();
      await store.fetchConfig();

      expect(store.configData).toEqual(data);
      expect(store.hasConfigData).toBe(true);
      expect(store.error).toBeNull();
      expect(store.loading).toBe(false);
    });

    it('请求期间处于加载状态', async () => {
      let resolveFn: (value: ConfigData) => void;
      mockConfigService.getCurrentConfig.mockImplementation(
        () => new Promise<ConfigData>((resolve) => (resolveFn = resolve)),
      );

      const store = useConfigStore();
      const pending = store.fetchConfig();

      expect(store.loading).toBe(true);

      resolveFn(makeConfigData());
      await pending;
    });

    it('失败时记录 Error 消息且不抛出', async () => {
      mockConfigService.getCurrentConfig.mockRejectedValue(new Error('网络错误'));

      const store = useConfigStore();
      await expect(store.fetchConfig()).resolves.toBeUndefined();

      expect(store.error).toBe('网络错误');
      expect(store.hasError).toBe(true);
      expect(store.loading).toBe(false);
    });

    it('失败时非 Error 对象使用默认错误消息', async () => {
      mockConfigService.getCurrentConfig.mockRejectedValue('boom');

      const store = useConfigStore();
      await store.fetchConfig();

      expect(store.error).toBe('获取配置失败');
    });
  });

  describe('updateConfig', () => {
    it('成功后重新拉取配置并清除表单状态', async () => {
      const data = makeConfigData();
      mockConfigService.updateConfig.mockResolvedValue(undefined);
      mockConfigService.getCurrentConfig.mockResolvedValue(data);

      const store = useConfigStore();
      store.setFormData({
        configType: 'system',
        config: { a: 1 },
        originalConfig: { a: 1 },
        isDirty: false,
      });

      const request = { configType: 'system' as const, config: { a: 2 } };
      await store.updateConfig(request);

      expect(mockConfigService.updateConfig).toHaveBeenCalledWith(request);
      expect(mockConfigService.getCurrentConfig).toHaveBeenCalledTimes(1);
      expect(store.configData).toEqual(data);
      expect(store.formData).toBeNull();
      expect(store.loading).toBe(false);
    });

    it('失败时记录默认错误消息并向上抛出', async () => {
      mockConfigService.updateConfig.mockRejectedValue('fail');

      const store = useConfigStore();
      await expect(store.updateConfig({ configType: 'system', config: {} })).rejects.toBe('fail');

      expect(store.error).toBe('更新配置失败');
      expect(store.loading).toBe(false);
    });
  });

  describe('validateConfig', () => {
    it('成功时保存验证结果并返回', async () => {
      const result: ConfigValidationResponse = {
        valid: false,
        errors: [{ path: '/port', message: '端口超范围', code: 'RANGE', severity: 'error' }],
        warnings: [],
        impact: {
          affectedServices: [],
          requiresRestart: false,
          potentialIssues: [],
          recommendations: [],
        },
      };
      mockConfigService.validateConfig.mockResolvedValue(result);

      const store = useConfigStore();
      const returned = await store.validateConfig({ configType: 'system', config: {} });

      expect(returned).toEqual(result);
      expect(store.validationResult).toEqual(result);
      expect(store.hasValidationErrors).toBe(true);
    });

    it('valid 为 true 时 hasValidationErrors 为 false', async () => {
      mockConfigService.validateConfig.mockResolvedValue({
        valid: true,
        errors: [],
        warnings: [],
        impact: {
          affectedServices: [],
          requiresRestart: false,
          potentialIssues: [],
          recommendations: [],
        },
      });

      const store = useConfigStore();
      await store.validateConfig({ configType: 'system', config: {} });

      expect(store.hasValidationErrors).toBe(false);
    });

    it('失败时记录默认错误消息并向上抛出', async () => {
      mockConfigService.validateConfig.mockRejectedValue(null);

      const store = useConfigStore();
      await expect(store.validateConfig({ configType: 'system', config: {} })).rejects.toBeNull();

      expect(store.error).toBe('验证配置失败');
    });
  });

  describe('testConfig', () => {
    it('成功时保存测试结果并返回', async () => {
      const result: ConfigTestResult = {
        success: true,
        tests: [{ name: 't', description: 'd', status: 'passed', message: 'ok' }],
        summary: { total: 1, passed: 1, failed: 0, warnings: 0 },
      };
      mockConfigService.testConfig.mockResolvedValue(result);

      const store = useConfigStore();
      const returned = await store.testConfig({ configType: 'system', config: {} });

      expect(returned).toEqual(result);
      expect(store.testResult).toEqual(result);
    });

    it('失败时记录默认错误消息并向上抛出', async () => {
      mockConfigService.testConfig.mockRejectedValue('bad');

      const store = useConfigStore();
      await expect(store.testConfig({ configType: 'system', config: {} })).rejects.toBe('bad');

      expect(store.error).toBe('测试配置失败');
    });
  });

  describe('previewConfigChanges', () => {
    it('成功时保存预览结果并返回', async () => {
      const result: ConfigPreview = {
        changes: [],
        affectedServices: [],
        potentialIssues: [],
        recommendations: [],
        rollbackPlan: [],
      };
      mockConfigService.previewConfigChanges.mockResolvedValue(result);

      const store = useConfigStore();
      const returned = await store.previewConfigChanges({ configType: 'system', config: {} });

      expect(returned).toEqual(result);
      expect(store.previewResult).toEqual(result);
    });

    it('失败时记录默认错误消息并向上抛出', async () => {
      mockConfigService.previewConfigChanges.mockRejectedValue(1);

      const store = useConfigStore();
      await expect(store.previewConfigChanges({ configType: 'system', config: {} })).rejects.toBe(
        1,
      );

      expect(store.error).toBe('预览配置失败');
    });
  });

  describe('fetchConfigHistory', () => {
    it('offset 为 0 时替换历史记录', async () => {
      mockConfigService.getConfigHistory.mockResolvedValue(makeHistoryResponse(2, 5));

      const store = useConfigStore();
      store.historyEntries.push({
        id: 'stale',
        configType: 'system',
        timestamp: '',
        changes: [],
        user: '',
        version: '',
      });

      await store.fetchConfigHistory(10, 0, 'system');

      expect(mockConfigService.getConfigHistory).toHaveBeenCalledWith(10, 0, 'system');
      expect(store.historyEntries).toHaveLength(2);
      expect(store.historyTotal).toBe(5);
    });

    it('offset 大于 0 时追加历史记录', async () => {
      const first = makeHistoryResponse(2, 5);
      const second = makeHistoryResponse(3, 5);
      mockConfigService.getConfigHistory.mockResolvedValueOnce(first).mockResolvedValueOnce(second);

      const store = useConfigStore();
      await store.fetchConfigHistory();
      await store.fetchConfigHistory(50, 2);

      expect(store.historyEntries).toHaveLength(5);
      expect(store.historyTotal).toBe(5);
    });

    it('失败时记录默认错误消息且不抛出', async () => {
      mockConfigService.getConfigHistory.mockRejectedValue('x');

      const store = useConfigStore();
      await expect(store.fetchConfigHistory()).resolves.toBeUndefined();

      expect(store.error).toBe('获取配置历史失败');
    });
  });

  describe('createBackup', () => {
    it('成功时返回备份 ID 并刷新备份列表', async () => {
      mockConfigService.createBackup.mockResolvedValue({ backupId: 'bk-1', message: 'ok' });
      mockConfigService.getBackupList.mockResolvedValue({
        backups: [{ id: 'bk-1', timestamp: '', configTypes: [], size: 1, user: 'admin' }],
        total: 1,
        limit: 50,
        offset: 0,
      });

      const store = useConfigStore();
      const backupId = await store.createBackup('描述', ['system']);

      expect(backupId).toBe('bk-1');
      expect(mockConfigService.createBackup).toHaveBeenCalledWith({
        description: '描述',
        includeTypes: ['system'],
      });
      expect(mockConfigService.getBackupList).toHaveBeenCalledTimes(1);
      expect(store.backups).toHaveLength(1);
    });

    it('失败时记录默认错误消息并向上抛出', async () => {
      mockConfigService.createBackup.mockRejectedValue('nope');

      const store = useConfigStore();
      await expect(store.createBackup()).rejects.toBe('nope');

      expect(store.error).toBe('创建备份失败');
    });
  });

  describe('restoreFromBackup', () => {
    it('成功后重新拉取配置', async () => {
      mockConfigService.restoreFromBackup.mockResolvedValue(undefined);
      mockConfigService.getCurrentConfig.mockResolvedValue(makeConfigData());

      const store = useConfigStore();
      await store.restoreFromBackup('bk-1', ['system']);

      expect(mockConfigService.restoreFromBackup).toHaveBeenCalledWith({
        backupId: 'bk-1',
        configTypes: ['system'],
      });
      expect(store.configData).not.toBeNull();
    });

    it('失败时记录默认错误消息并向上抛出', async () => {
      mockConfigService.restoreFromBackup.mockRejectedValue('err');

      const store = useConfigStore();
      await expect(store.restoreFromBackup('bk-1')).rejects.toBe('err');

      expect(store.error).toBe('恢复配置失败');
    });
  });

  describe('fetchBackupList', () => {
    const backup: ConfigBackup = {
      id: 'bk-1',
      timestamp: '2024-01-01T00:00:00.000Z',
      configTypes: ['system'],
      size: 128,
      user: 'admin',
    };

    it('offset 为 0 时替换备份列表', async () => {
      mockConfigService.getBackupList.mockResolvedValue({
        backups: [backup],
        total: 1,
        limit: 50,
        offset: 0,
      });

      const store = useConfigStore();
      store.backups.push({ ...backup, id: 'stale' });

      await store.fetchBackupList(10, 0);

      expect(mockConfigService.getBackupList).toHaveBeenCalledWith(10, 0);
      expect(store.backups).toHaveLength(1);
      expect(store.backups[0].id).toBe('bk-1');
      expect(store.backupTotal).toBe(1);
    });

    it('offset 大于 0 时追加备份列表', async () => {
      mockConfigService.getBackupList.mockResolvedValue({
        backups: [backup],
        total: 2,
        limit: 50,
        offset: 1,
      });

      const store = useConfigStore();
      store.backups.push({ ...backup, id: 'bk-0' });

      await store.fetchBackupList(50, 1);

      expect(store.backups.map((b) => b.id)).toEqual(['bk-0', 'bk-1']);
      expect(store.backupTotal).toBe(2);
    });

    it('失败时记录默认错误消息且不抛出', async () => {
      mockConfigService.getBackupList.mockRejectedValue('e');

      const store = useConfigStore();
      await expect(store.fetchBackupList()).resolves.toBeUndefined();

      expect(store.error).toBe('获取备份列表失败');
    });
  });

  describe('表单状态', () => {
    it('updateFormData 检测配置是否变脏', () => {
      const store = useConfigStore();
      store.setFormData({
        configType: 'system',
        config: { a: 1 },
        originalConfig: { a: 1 },
        isDirty: false,
      });

      expect(store.isFormDirty).toBe(false);

      store.updateFormData({ a: 1 });
      expect(store.isFormDirty).toBe(false);

      store.updateFormData({ a: 2 });
      expect(store.isFormDirty).toBe(true);
      expect(store.formData?.config).toEqual({ a: 2 });
    });

    it('没有表单数据时 updateFormData 不生效', () => {
      const store = useConfigStore();

      expect(() => store.updateFormData({ a: 1 })).not.toThrow();
      expect(store.formData).toBeNull();
    });

    it('clearFormData 同时清除验证、测试、预览结果', () => {
      const store = useConfigStore();
      store.setFormData({
        configType: 'system',
        config: {},
        originalConfig: {},
        isDirty: false,
      });
      store.validationResult = {
        valid: true,
        errors: [],
        warnings: [],
        impact: {
          affectedServices: [],
          requiresRestart: false,
          potentialIssues: [],
          recommendations: [],
        },
      };
      store.testResult = {
        success: true,
        tests: [],
        summary: { total: 0, passed: 0, failed: 0, warnings: 0 },
      };
      store.previewResult = {
        changes: [],
        affectedServices: [],
        potentialIssues: [],
        recommendations: [],
        rollbackPlan: [],
      };

      store.clearFormData();

      expect(store.formData).toBeNull();
      expect(store.validationResult).toBeNull();
      expect(store.testResult).toBeNull();
      expect(store.previewResult).toBeNull();
    });
  });

  describe('状态维护方法', () => {
    it('setSearchFilter 合并部分字段', () => {
      const store = useConfigStore();

      store.setSearchFilter({ keyword: '端口' });
      store.setSearchFilter({ configType: 'system', showAdvanced: true });

      expect(store.searchFilter).toEqual({
        keyword: '端口',
        configType: 'system',
        category: undefined,
        showAdvanced: true,
      });
    });

    it('clearError 清除错误', () => {
      const store = useConfigStore();
      store.error = '出错了';

      store.clearError();

      expect(store.error).toBeNull();
      expect(store.hasError).toBe(false);
    });

    it('reset 恢复全部初始状态', () => {
      const store = useConfigStore();
      store.configData = makeConfigData();
      store.loading = true;
      store.error = '错';
      store.setFormData({
        configType: 'system',
        config: {},
        originalConfig: {},
        isDirty: true,
      });
      store.historyEntries.push({
        id: 'e',
        configType: 'system',
        timestamp: '',
        changes: [],
        user: '',
        version: '',
      });
      store.historyTotal = 1;
      store.backups.push({ id: 'b', timestamp: '', configTypes: [], size: 0, user: '' });
      store.backupTotal = 1;
      store.setSearchFilter({ keyword: 'x', showAdvanced: true });

      store.reset();

      expect(store.configData).toBeNull();
      expect(store.loading).toBe(false);
      expect(store.error).toBeNull();
      expect(store.formData).toBeNull();
      expect(store.historyEntries).toEqual([]);
      expect(store.historyTotal).toBe(0);
      expect(store.backups).toEqual([]);
      expect(store.backupTotal).toBe(0);
      expect(store.searchFilter).toEqual({
        keyword: '',
        configType: undefined,
        category: undefined,
        showAdvanced: false,
      });
    });
  });
});
