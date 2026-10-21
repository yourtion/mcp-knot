/**
 * DefaultConfigGenerator 测试
 */

import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DefaultConfigGenerator } from './default-generator.js';

describe('DefaultConfigGenerator', () => {
  let testDir: string;
  let generator: DefaultConfigGenerator;

  beforeEach(async () => {
    // 创建临时测试目录
    testDir = await mkdtemp(join(tmpdir(), 'mcp-knot-test-'));
    generator = new DefaultConfigGenerator({ configDir: testDir });
  });

  afterEach(async () => {
    // 清理临时目录
    if (existsSync(testDir)) {
      await rm(testDir, { recursive: true, force: true });
    }
  });

  describe('getAvailableServerPresets', () => {
    it('应该返回所有可用的服务器预设', () => {
      const presets = generator.getAvailableServerPresets();

      expect(Array.isArray(presets)).toBe(true);
      expect(presets.length).toBeGreaterThan(0);

      // 验证默认预设存在
      const presetIds = presets.map((p) => p.id);
      expect(presetIds).toContain('fetch');
      expect(presetIds).toContain('time');
      expect(presetIds).toContain('sequential-thinking');
      expect(presetIds).toContain('filesystem');
      expect(presetIds).toContain('memory');
      expect(presetIds).toContain('brave-search');
      expect(presetIds).toContain('github');
      expect(presetIds).toContain('context7');
    });

    it('每个预设应该包含必需的字段', () => {
      const presets = generator.getAvailableServerPresets();

      for (const preset of presets) {
        expect(preset).toHaveProperty('id');
        expect(preset).toHaveProperty('name');
        expect(preset).toHaveProperty('description');
        expect(preset).toHaveProperty('config');
        expect(typeof preset.id).toBe('string');
        expect(typeof preset.name).toBe('string');
        expect(typeof preset.description).toBe('string');
        expect(typeof preset.config).toBe('object');
      }
    });

    it('服务器配置应该包含 command 或 url 字段', () => {
      const presets = generator.getAvailableServerPresets();

      for (const preset of presets) {
        const cfg = preset.config as Record<string, unknown>;
        const hasCommand = 'command' in cfg;
        const hasUrl = 'url' in cfg;
        expect(hasCommand || hasUrl).toBe(true);
      }
    });

    it('需要额外配置的预设应该包含相应标记', () => {
      const presets = generator.getAvailableServerPresets();

      const filesystemPreset = presets.find((p) => p.id === 'filesystem');
      expect(filesystemPreset?.requiresAdditionalConfig).toBe(true);
      expect(filesystemPreset?.additionalConfigNote).toBeDefined();

      const bravePreset = presets.find((p) => p.id === 'brave-search');
      expect(bravePreset?.requiresAdditionalConfig).toBe(true);
      expect(bravePreset?.additionalConfigNote).toBeDefined();

      const fetchPreset = presets.find((p) => p.id === 'fetch');
      expect(fetchPreset?.requiresAdditionalConfig).toBeUndefined();
    });
  });

  describe('initConfigFiles', () => {
    it('应该创建 mcp_server.json 文件', async () => {
      const result = await generator.initConfigFiles();

      expect(result.createdFiles).toHaveLength(1);
      expect(result.createdFiles[0]).toContain('mcp_server.json');
      expect(result.errors).toHaveLength(0);

      // 验证文件存在
      const serviceConfigPath = join(testDir, 'mcp_server.json');
      expect(existsSync(serviceConfigPath)).toBe(true);
    });

    it('应该创建包含默认服务器的配置', async () => {
      await generator.initConfigFiles();

      const serviceConfigPath = join(testDir, 'mcp_server.json');
      const content = await readFile(serviceConfigPath, 'utf-8');
      const config = JSON.parse(content);

      expect(config).toHaveProperty('servers');
      expect(config.servers).toHaveProperty('fetch');
      expect(config.servers).toHaveProperty('time');
      expect(config.servers).toHaveProperty('sequential-thinking');
    });

    it('应该包含全局设置', async () => {
      await generator.initConfigFiles();

      const serviceConfigPath = join(testDir, 'mcp_server.json');
      const content = await readFile(serviceConfigPath, 'utf-8');
      const config = JSON.parse(content);

      expect(config).toHaveProperty('settings');
      expect(config.settings).toHaveProperty('logLevel');
      expect(config.settings).toHaveProperty('connectionTimeout');
      expect(config.settings).toHaveProperty('maxConcurrentConnections');
    });

    it('当 includeGroups=true 时应该创建 group.json', async () => {
      generator = new DefaultConfigGenerator({
        configDir: testDir,
        includeGroups: true,
      });

      const result = await generator.initConfigFiles();

      expect(result.createdFiles).toHaveLength(2);
      expect(result.createdFiles.some((file) => file.includes('group.json'))).toBe(true);

      // 验证组配置文件存在
      const groupConfigPath = join(testDir, 'group.json');
      expect(existsSync(groupConfigPath)).toBe(true);
    });

    it('group.json 应该包含默认组和 web-tools 组', async () => {
      generator = new DefaultConfigGenerator({
        configDir: testDir,
        includeGroups: true,
      });

      await generator.initConfigFiles();

      const groupConfigPath = join(testDir, 'group.json');
      const content = await readFile(groupConfigPath, 'utf-8');
      const config = JSON.parse(content);

      expect(config).toHaveProperty('default');
      expect(config).toHaveProperty('web-tools');
      expect(config.default.name).toBe('默认组');
      expect(config['web-tools'].name).toBe('Web工具组');
    });

    it('当文件已存在且 overwrite=false 时应该跳过', async () => {
      // 第一次创建
      const result1 = await generator.initConfigFiles();
      expect(result1.createdFiles).toHaveLength(1);
      expect(result1.skippedFiles).toHaveLength(0);

      // 第二次调用（不覆盖）
      const result2 = await generator.initConfigFiles();
      expect(result2.createdFiles).toHaveLength(0);
      expect(result2.skippedFiles).toHaveLength(1);
    });

    it('当 overwrite=true 时应该覆盖已存在的文件', async () => {
      // 第一次创建
      await generator.initConfigFiles();

      // 第二次创建（覆盖）
      generator = new DefaultConfigGenerator({
        configDir: testDir,
        overwrite: true,
      });

      const result = await generator.initConfigFiles();
      expect(result.createdFiles).toHaveLength(1);
      expect(result.skippedFiles).toHaveLength(0);
    });

    it('应该在目录不存在时自动创建', async () => {
      const newDir = join(testDir, 'subdir', 'nested');

      generator = new DefaultConfigGenerator({
        configDir: newDir,
      });

      const result = await generator.initConfigFiles();

      expect(result.createdFiles).toHaveLength(1);
      expect(existsSync(join(newDir, 'mcp_server.json'))).toBe(true);
    });

    it('生成的 JSON 应该格式化良好', async () => {
      await generator.initConfigFiles();

      const serviceConfigPath = join(testDir, 'mcp_server.json');
      const content = await readFile(serviceConfigPath, 'utf-8');

      // 验证 JSON 格式化（包含换行和缩进）
      expect(content).toContain('\n');
      expect(content).toContain('  ');
    });

    it('应该正确处理服务器配置', async () => {
      await generator.initConfigFiles();

      const serviceConfigPath = join(testDir, 'mcp_server.json');
      const content = await readFile(serviceConfigPath, 'utf-8');
      const config = JSON.parse(content);

      // 验证 fetch 服务器配置
      expect((config.servers.fetch as Record<string, unknown>).command).toBe('uvx');
      expect((config.servers.fetch as Record<string, unknown>).args).toContain('mcp-server-fetch');
      expect((config.servers.fetch as Record<string, unknown>).disabled).toBe(false);
    });

    it('环境变量应该正确配置', async () => {
      generator = new DefaultConfigGenerator({
        configDir: testDir,
        includeGroups: true,
      });

      // 手动创建包含需要环境变量的服务器的配置
      const presets = generator.getAvailableServerPresets();
      const bravePreset = presets.find((p) => p.id === 'brave-search');

      expect(bravePreset?.config.env).toBeDefined();
      expect(bravePreset?.config.env?.BRAVE_API_KEY).toBeDefined();
    });
  });

  describe('配置选项', () => {
    it('应该支持自定义配置目录', async () => {
      const customDir = join(testDir, 'custom');

      generator = new DefaultConfigGenerator({
        configDir: customDir,
      });

      await generator.initConfigFiles();

      expect(existsSync(join(customDir, 'mcp_server.json'))).toBe(true);
    });

    it('应该支持覆盖选项', async () => {
      // 创建初始配置
      await generator.initConfigFiles();

      // 使用 overwrite 选项重新创建
      generator = new DefaultConfigGenerator({
        configDir: testDir,
        overwrite: true,
      });

      const result = await generator.initConfigFiles();

      expect(result.createdFiles).toHaveLength(1);
      expect(result.skippedFiles).toHaveLength(0);
    });

    it('应该支持 includeGroups 选项', async () => {
      generator = new DefaultConfigGenerator({
        configDir: testDir,
        includeGroups: false,
      });

      let result = await generator.initConfigFiles();
      expect(result.createdFiles).toHaveLength(1);

      generator = new DefaultConfigGenerator({
        configDir: testDir,
        includeGroups: true,
        overwrite: true,
      });

      result = await generator.initConfigFiles();
      expect(result.createdFiles).toHaveLength(2);
    });
  });

  describe('错误处理', () => {
    it('应该拒绝无效的预设 ID', () => {
      const presets = generator.getAvailableServerPresets();
      const invalidId = 'non-existent-preset';

      expect(presets.some((p) => p.id === invalidId)).toBe(false);
    });

    it('应该处理文件系统错误', async () => {
      // 使用无效路径（在某些系统上可能无法创建）
      const invalidDir = '/invalid/path/that/cannot/be/created/1234567890';

      generator = new DefaultConfigGenerator({
        configDir: invalidDir,
      });

      const result = await generator.initConfigFiles();

      // 应该返回错误而不是抛出异常
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.createdFiles).toHaveLength(0);
    });
  });

  describe('服务器预设详细信息', () => {
    it('fetch 预设应该有正确的配置', () => {
      const presets = generator.getAvailableServerPresets();
      const fetch = presets.find((p) => p.id === 'fetch');

      expect(fetch).toBeDefined();
      expect(fetch?.name).toBe('Fetch');
      expect(fetch?.description).toBe('Web fetching and HTTP requests');
      const fetchConfig = fetch?.config as Record<string, unknown>;
      expect(fetchConfig.command).toBe('uvx');
      expect(fetchConfig.args).toContain('mcp-server-fetch');
    });

    it('time 预设应该有正确的配置', () => {
      const presets = generator.getAvailableServerPresets();
      const time = presets.find((p) => p.id === 'time');

      expect(time).toBeDefined();
      expect(time?.name).toBe('Time');
      expect(time?.description).toBe('Time and date functionality');
      const timeConfig = time?.config as Record<string, unknown>;
      expect(timeConfig.command).toBe('uvx');
      expect(timeConfig.args).toContain('mcp-server-time');
    });

    it('sequential-thinking 预设应该有正确的配置', () => {
      const presets = generator.getAvailableServerPresets();
      const st = presets.find((p) => p.id === 'sequential-thinking');

      expect(st).toBeDefined();
      expect(st?.name).toBe('Sequential Thinking');
      expect(st?.description).toBe('Sequential thinking capabilities');
      if (st && 'command' in st.config) {
        expect((st.config as Record<string, unknown>).command).toBe('npx');
        expect((st.config as Record<string, unknown>).args).toContain(
          '@modelcontextprotocol/server-sequential-thinking',
        );
      }
    });

    it('context7 预设应该有正确的配置', () => {
      const presets = generator.getAvailableServerPresets();
      const ctx = presets.find((p) => p.id === 'context7');

      expect(ctx).toBeDefined();
      expect(ctx?.name).toBe('Context7');
      expect(ctx?.description).toContain('documentation');
      if (ctx && 'url' in ctx.config) {
        expect((ctx.config as Record<string, unknown>).url).toBe('https://mcp.context7.com/mcp');
        expect((ctx.config as Record<string, unknown>).type).toBe('streaming');
      }
      expect(ctx?.requiresAdditionalConfig).toBeUndefined();
    });

    it('filesystem 预设应该标记需要额外配置', () => {
      const presets = generator.getAvailableServerPresets();
      const fs = presets.find((p) => p.id === 'filesystem');

      expect(fs?.requiresAdditionalConfig).toBe(true);
      expect(fs?.additionalConfigNote).toContain('/path/to/allowed/directory');
    });

    it('brave-search 预设应该包含 API 密钥配置', () => {
      const presets = generator.getAvailableServerPresets();
      const brave = presets.find((p) => p.id === 'brave-search');

      expect(brave?.requiresAdditionalConfig).toBe(true);
      expect(brave?.config.env?.BRAVE_API_KEY).toBeDefined();
      expect(brave?.additionalConfigNote).toContain('BRAVE_API_KEY');
    });

    it('github 预设应该包含访问令牌配置', () => {
      const presets = generator.getAvailableServerPresets();
      const github = presets.find((p) => p.id === 'github');

      expect(github?.requiresAdditionalConfig).toBe(true);
      expect(github?.config.env?.GITHUB_PERSONAL_ACCESS_TOKEN).toBeDefined();
      expect(github?.additionalConfigNote).toContain('GITHUB_PERSONAL_ACCESS_TOKEN');
    });
  });
});
