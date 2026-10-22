import { ErrorCode } from '@mcp-core/mcp-knot-core';
/**
 * 配置工具测试
 * 覆盖 getAllConfig 返回结构、配置目录解析、实例缓存与 saveConfig 分发
 */
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { resetConfigInstances } from './config.js';

import type { GroupConfig, McpConfig, SystemConfig } from '@mcp-core/mcp-knot-share/config';

const { MockJsonStorage, instances } = vi.hoisted(() => {
  const instances: Array<{
    filePath: string;
    defaultValue?: unknown;
    write: ReturnType<typeof vi.fn>;
    read: () => Promise<unknown>;
  }> = [];

  class MockJsonStorage {
    filePath: string;
    defaultValue?: unknown;
    write = vi.fn(async () => undefined);

    constructor(filePath: string, defaultValue?: unknown) {
      this.filePath = filePath;
      this.defaultValue = defaultValue;
      instances.push(this);
    }

    async read(): Promise<unknown> {
      return this.defaultValue;
    }
  }

  return { MockJsonStorage, instances };
});

vi.mock('./json_storage.js', () => ({
  JsonStorage: MockJsonStorage,
}));

describe('配置工具', () => {
  beforeEach(() => {
    resetConfigInstances();
    instances.length = 0;
    vi.clearAllMocks();
    delete process.env.CONFIG_PATH;
  });

  describe('getAllConfig', () => {
    it('返回 mcps、groups、system 与 apiToolsConfigPath', async () => {
      const { getAllConfig } = await import('./config.js');
      const config = await getAllConfig();

      expect(config).toHaveProperty('mcps');
      expect(config).toHaveProperty('groups');
      expect(config).toHaveProperty('system');
      // 即使 api-tools.json 不存在也始终返回路径
      expect(config.apiToolsConfigPath).toBeDefined();
      expect(config.apiToolsConfigPath).toMatch(/api-tools\.json$/);
    });

    it('未设置 CONFIG_PATH 时使用 cwd 下的 config 目录', async () => {
      const { getAllConfig } = await import('./config.js');
      const config = await getAllConfig();

      const configDir = path.resolve(process.cwd(), 'config');
      expect(config.apiToolsConfigPath).toBe(path.resolve(configDir, 'api-tools.json'));
      expect(instances.map((i) => i.filePath).toSorted()).toEqual(
        [
          path.resolve(configDir, 'group.json'),
          path.resolve(configDir, 'mcp_server.json'),
          path.resolve(configDir, 'system.json'),
        ].toSorted(),
      );
    });

    it('设置 CONFIG_PATH 时优先使用环境变量目录', async () => {
      vi.stubEnv('CONFIG_PATH', '/custom-config-dir');
      const { getAllConfig } = await import('./config.js');
      const config = await getAllConfig();

      expect(config.apiToolsConfigPath).toBe('/custom-config-dir/api-tools.json');
      expect(instances.map((i) => i.filePath)).toContain('/custom-config-dir/mcp_server.json');
    });

    it('MCP 服务器配置的默认值为 { servers: {} }', async () => {
      const { getAllConfig } = await import('./config.js');
      const config = await getAllConfig();

      expect(config.mcps).toEqual({ servers: {} });
    });

    it('重复调用复用同一批 JsonStorage 实例', async () => {
      const { getAllConfig } = await import('./config.js');
      await getAllConfig();
      await getAllConfig();

      // 三种配置各一个实例，且不因重复调用重建
      expect(instances).toHaveLength(3);
    });
  });

  describe('saveConfig', () => {
    async function loadAndInit() {
      const configModule = await import('./config.js');
      await configModule.getAllConfig();
      return configModule;
    }

    it('按类型分发到对应实例并写入数据', async () => {
      const { saveConfig } = await loadAndInit();
      const [mcpStorage, groupStorage, systemStorage] = instances;

      const mcpData: McpConfig = { servers: {} };
      const groupData = {} as GroupConfig;
      const systemData = {} as SystemConfig;

      await saveConfig('mcp_server.json', mcpData);
      await saveConfig('group.json', groupData);
      await saveConfig('system.json', systemData);

      expect(mcpStorage!.write).toHaveBeenCalledWith(mcpData);
      expect(groupStorage!.write).toHaveBeenCalledWith(groupData);
      expect(systemStorage!.write).toHaveBeenCalledWith(systemData);
      expect(mcpStorage!.write).toHaveBeenCalledTimes(1);
    });

    it('不支持的配置类型抛出 ConfigError', async () => {
      const { saveConfig } = await loadAndInit();

      await expect(saveConfig('unknown.json' as 'mcp_server.json', {})).rejects.toMatchObject({
        code: ErrorCode.INVALID_CONFIG_FORMAT,
        message: expect.stringContaining('unknown.json'),
      });
      // 三个实例都没有被写入
      for (const storage of instances) {
        expect(storage.write).not.toHaveBeenCalled();
      }
    });
  });

  describe('asMutable', () => {
    it('原样返回传入对象（类型层转换）', async () => {
      const { asMutable } = await import('./config.js');
      const source = { servers: { a: 1 } };

      expect(asMutable(source)).toBe(source);
    });
  });
});
