import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import api from '@/services/api';
import { ApiToMcpService } from '@/services/api-to-mcp';

import type { ApiConfigListResponse, ApiToolConfig } from '@/types/api-to-mcp';
import type { AxiosResponse } from 'axios';
import type { Mock } from 'vitest';

// Mock axios
vi.mock('@/services/api', () => ({
  default: {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
  },
  handleApiResponse: vi.fn(
    (response: unknown) => (response as { data: { data: unknown } }).data.data,
  ),
}));

describe('ApiToMcpService', () => {
  let apiToMcpService: ApiToMcpService;

  beforeEach(() => {
    apiToMcpService = new ApiToMcpService();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('getConfigs', () => {
    it('should fetch API configs successfully', async () => {
      const mockResponse: ApiConfigListResponse = {
        configs: [
          {
            id: 'test-config-1',
            name: 'Test API',
            description: 'Test API configuration',
            status: 'active',
            api: {
              url: 'https://api.example.com/test',
              method: 'GET',
            },
            toolsGenerated: 5,
            lastUpdated: '2023-01-01T00:00:00Z',
          },
        ],
      };

      (api.get as unknown as Mock).mockResolvedValue({
        data: {
          success: true,
          data: mockResponse,
          timestamp: new Date().toISOString(),
        },
      } as unknown as AxiosResponse);

      const result = await apiToMcpService.getConfigs();

      expect(result).toEqual(mockResponse);
      expect(api.get).toHaveBeenCalledWith('/api-to-mcp/configs');
    });

    it('should throw error when API call fails', async () => {
      (api.get as unknown as Mock).mockRejectedValue(new Error('Network error'));

      await expect(apiToMcpService.getConfigs()).rejects.toThrow('Network error');
      expect(api.get).toHaveBeenCalledWith('/api-to-mcp/configs');
    });
  });

  describe('getConfigDetails', () => {
    it('should fetch API config details successfully', async () => {
      const mockConfig: ApiToolConfig = {
        id: 'test-config-1',
        name: 'Test API',
        description: 'Test API configuration',
        api: {
          url: 'https://api.example.com/test',
          method: 'GET',
          headers: {},
          timeout: 10000,
        },
        parameters: {
          type: 'object',
          properties: {},
          required: [],
        },
        response: {
          statusCodePath: '',
          dataPath: '',
          errorMessagePath: '',
          successCodes: [200],
          errorCodes: [400],
        },
      };

      (api.get as unknown as Mock).mockResolvedValue({
        data: {
          success: true,
          data: mockConfig,
          timestamp: new Date().toISOString(),
        },
      });

      const result = await apiToMcpService.getConfigDetails('test-config-1');

      expect(result).toEqual(mockConfig);
      expect(api.get).toHaveBeenCalledWith('/api-to-mcp/configs/test-config-1');
    });
  });

  describe('createConfig', () => {
    it('should create API config successfully', async () => {
      const mockConfig: ApiToolConfig = {
        id: 'new-config',
        name: 'New API',
        description: 'New API configuration',
        api: {
          url: 'https://api.example.com/new',
          method: 'POST',
          headers: {},
          timeout: 10000,
        },
        parameters: {
          type: 'object',
          properties: {},
          required: [],
        },
        response: {
          statusCodePath: '',
          dataPath: '',
          errorMessagePath: '',
          successCodes: [200],
          errorCodes: [400],
        },
      };

      const mockResult = {
        id: 'new-config',
        message: 'Config created successfully',
        config: mockConfig,
      };

      (api.post as unknown as Mock).mockResolvedValue({
        data: {
          success: true,
          data: mockResult,
          timestamp: new Date().toISOString(),
        },
      });

      const result = await apiToMcpService.createConfig(mockConfig);

      expect(result).toEqual(mockResult);
      expect(api.post).toHaveBeenCalledWith('/api-to-mcp/configs', {
        config: mockConfig,
      });
    });
  });

  describe('updateConfig', () => {
    it('should update API config successfully', async () => {
      const mockConfig: ApiToolConfig = {
        id: 'existing-config',
        name: 'Updated API',
        description: 'Updated API configuration',
        api: {
          url: 'https://api.example.com/updated',
          method: 'PUT',
          headers: {},
          timeout: 15000,
        },
        parameters: {
          type: 'object',
          properties: {},
          required: [],
        },
        response: {
          statusCodePath: '',
          dataPath: '',
          errorMessagePath: '',
          successCodes: [200],
          errorCodes: [400],
        },
      };

      const mockResult = {
        id: 'existing-config',
        message: 'Config updated successfully',
        config: mockConfig,
      };

      (api.put as unknown as Mock).mockResolvedValue({
        data: {
          success: true,
          data: mockResult,
          timestamp: new Date().toISOString(),
        },
      });

      const result = await apiToMcpService.updateConfig('existing-config', mockConfig);

      expect(result).toEqual(mockResult);
      expect(api.put).toHaveBeenCalledWith('/api-to-mcp/configs/existing-config', {
        config: mockConfig,
      });
    });
  });

  describe('deleteConfig', () => {
    it('should delete API config successfully', async () => {
      const mockResult = {
        id: 'config-to-delete',
        message: 'Config deleted successfully',
      };

      (api.delete as unknown as Mock).mockResolvedValue({
        data: {
          success: true,
          data: mockResult,
          timestamp: new Date().toISOString(),
        },
      });

      const result = await apiToMcpService.deleteConfig('config-to-delete');

      expect(result).toEqual(mockResult);
      expect(api.delete).toHaveBeenCalledWith('/api-to-mcp/configs/config-to-delete');
    });
  });

  describe('testConfig', () => {
    it('should test API config successfully', async () => {
      const mockParameters = { param1: 'value1', param2: 42 };
      const mockResponse = {
        success: true,
        response: { result: 'success' },
        executionTime: 150,
      };

      (api.post as unknown as Mock).mockResolvedValue({
        data: mockResponse,
      });

      const result = await apiToMcpService.testConfig('test-config', mockParameters);

      expect(result).toEqual(mockResponse);
      expect(api.post).toHaveBeenCalledWith('/api-to-mcp/configs/test-config/test', {
        parameters: mockParameters,
      });
    });
  });

  describe('importConfig', () => {
    it('should import config from file successfully', async () => {
      const mockFile = new File(['{}'], 'test.json', {
        type: 'application/json',
      });
      const mockImportConfig = {
        format: 'openapi' as const,
        source: mockFile,
        options: {
          includeParameters: true,
          includeSecurity: false,
          generateTools: true,
        },
      };

      const mockResult = {
        configs: [
          {
            id: 'imported-config',
            name: 'Imported API',
            description: 'Imported API configuration',
            status: 'active' as const,
            api: {
              url: 'https://api.example.com/imported',
              method: 'GET',
            },
            toolsGenerated: 3,
            lastUpdated: '2023-01-01T00:00:00Z',
          },
        ],
        message: 'Import successful',
      };

      (api.post as unknown as Mock).mockResolvedValue({
        data: {
          success: true,
          data: mockResult,
          timestamp: new Date().toISOString(),
        },
      });

      const result = await apiToMcpService.importConfig(mockImportConfig);

      expect(result).toEqual(mockResult);
    });

    it('should import config from URL successfully', async () => {
      const mockImportConfig = {
        format: 'openapi' as const,
        source: 'https://api.example.com/openapi.json',
        options: {
          includeParameters: true,
          includeSecurity: false,
          generateTools: true,
        },
      };

      const mockResult = {
        configs: [],
        message: 'Import successful',
      };

      (api.post as unknown as Mock).mockResolvedValue({
        data: {
          success: true,
          data: mockResult,
          timestamp: new Date().toISOString(),
        },
      });

      const result = await apiToMcpService.importConfig(mockImportConfig);

      expect(result).toEqual(mockResult);
      expect(api.post).toHaveBeenCalledWith('/api-to-mcp/configs/import', mockImportConfig);
    });
  });

  describe('exportConfig', () => {
    it('should export config successfully', async () => {
      const mockExportConfig = {
        format: 'json' as const,
        configs: ['config-1', 'config-2'],
        options: {
          includeMetadata: true,
          includeSecurity: false,
        },
      };

      const mockResult = {
        data: '{"configs":[]}',
        filename: 'api-config-export.json',
        message: 'Export successful',
      };

      (api.post as unknown as Mock).mockResolvedValue({
        data: {
          success: true,
          data: mockResult,
          timestamp: new Date().toISOString(),
        },
      });

      const result = await apiToMcpService.exportConfig(mockExportConfig);

      expect(result).toEqual(mockResult);
      expect(api.post).toHaveBeenCalledWith('/api-to-mcp/configs/export', mockExportConfig);
    });
  });

  describe('validateConfig', () => {
    it('should validate config successfully', async () => {
      const mockConfig: ApiToolConfig = {
        id: 'test-config',
        name: 'Test API',
        description: 'Test API configuration',
        api: {
          url: 'https://api.example.com/test',
          method: 'GET',
          headers: {},
          timeout: 10000,
        },
        parameters: {
          type: 'object',
          properties: {},
          required: [],
        },
        response: {
          statusCodePath: '',
          dataPath: '',
          errorMessagePath: '',
          successCodes: [200],
          errorCodes: [400],
        },
      };

      const mockResult = {
        valid: true,
        errors: [],
        warnings: [],
      };

      (api.post as unknown as Mock).mockResolvedValue({
        data: {
          success: true,
          data: mockResult,
          timestamp: new Date().toISOString(),
        },
      });

      const result = await apiToMcpService.validateConfig(mockConfig);

      expect(result).toEqual(mockResult);
      expect(api.post).toHaveBeenCalledWith('/api-to-mcp/configs/validate', {
        config: mockConfig,
      });
    });
  });

  describe('generateToolPreview', () => {
    it('should generate tool preview successfully', async () => {
      const mockResult = {
        tools: [
          {
            name: 'test-tool',
            description: 'Test tool',
            inputSchema: {
              type: 'object',
              properties: {},
            },
            serverName: 'test-server',
          },
        ],
        message: 'Tool preview generated',
      };

      (api.post as unknown as Mock).mockResolvedValue({
        data: {
          success: true,
          data: mockResult,
          timestamp: new Date().toISOString(),
        },
      });

      const result = await apiToMcpService.generateToolPreview('test-config');

      expect(result).toEqual(mockResult);
      expect(api.post).toHaveBeenCalledWith('/api/to-mcp/configs/test-config/preview', {});
    });
  });

  describe('getConfigStats', () => {
    it('should fetch config stats successfully', async () => {
      const mockStats = {
        totalConfigs: 10,
        activeConfigs: 8,
        totalTools: 25,
        lastUpdated: '2023-01-01T00:00:00Z',
      };

      (api.get as unknown as Mock).mockResolvedValue({
        data: {
          success: true,
          data: mockStats,
          timestamp: new Date().toISOString(),
        },
      });

      const result = await apiToMcpService.getConfigStats();

      expect(result).toEqual(mockStats);
      expect(api.get).toHaveBeenCalledWith('/api-to-mcp/configs/stats');
    });
  });

  describe('importConfig 请求体构造', () => {
    it('文件源使用 FormData 上传并序列化选项', async () => {
      const mockFile = new File(['{}'], 'spec.json', { type: 'application/json' });
      const options = { includeParameters: true, includeSecurity: false, generateTools: true };

      (api.post as unknown as Mock).mockResolvedValue({
        data: { success: true, data: { configs: [], message: 'ok' }, timestamp: '' },
      });

      await apiToMcpService.importConfig({ format: 'openapi', source: mockFile, options });

      expect(api.post).toHaveBeenCalledWith('/api-to-mcp/configs/import', expect.any(FormData), {
        headers: { 'Content-Type': 'multipart/form-data' },
      });

      const formData = (api.post as unknown as Mock).mock.calls[0][1] as FormData;
      expect(formData.get('file')).toBe(mockFile);
      expect(formData.get('format')).toBe('openapi');
      expect(formData.get('options')).toBe(JSON.stringify(options));
    });

    it('文件源未提供选项时不附加 options 字段', async () => {
      const mockFile = new File(['{}'], 'spec.json', { type: 'application/json' });

      (api.post as unknown as Mock).mockResolvedValue({
        data: { success: true, data: { configs: [], message: 'ok' }, timestamp: '' },
      });

      await apiToMcpService.importConfig({ format: 'json', source: mockFile });

      const formData = (api.post as unknown as Mock).mock.calls[0][1] as FormData;
      expect(formData.get('file')).toBe(mockFile);
      expect(formData.get('format')).toBe('json');
      expect(formData.get('options')).toBeNull();
    });

    it('字符串源以普通 JSON 体提交且无 options 时省略该字段', async () => {
      (api.post as unknown as Mock).mockResolvedValue({
        data: { success: true, data: { configs: [], message: 'ok' }, timestamp: '' },
      });

      await apiToMcpService.importConfig({
        format: 'openapi',
        source: 'https://api.example.com/openapi.json',
      });

      expect(api.post).toHaveBeenCalledWith('/api-to-mcp/configs/import', {
        source: 'https://api.example.com/openapi.json',
        format: 'openapi',
        options: undefined,
      });
    });
  });
});
