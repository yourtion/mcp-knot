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
    it('应该返回全部 8 个预设，ID 列表与定义一致', () => {
      const presets = generator.getAvailableServerPresets();

      expect(presets.map((p) => p.id)).toEqual([
        'fetch',
        'time',
        'sequential-thinking',
        'context7',
        'filesystem',
        'memory',
        'brave-search',
        'github',
      ]);
    });

    it('每个预设的字段与内容精确匹配', () => {
      expect(generator.getAvailableServerPresets()).toEqual([
        {
          id: 'fetch',
          name: 'Fetch',
          description: 'Web fetching and HTTP requests',
          config: { command: 'uvx', args: ['mcp-server-fetch'], disabled: false },
        },
        {
          id: 'time',
          name: 'Time',
          description: 'Time and date functionality',
          config: { command: 'uvx', args: ['mcp-server-time'], disabled: false },
        },
        {
          id: 'sequential-thinking',
          name: 'Sequential Thinking',
          description: 'Sequential thinking capabilities',
          config: {
            command: 'npx',
            args: ['-y', '@modelcontextprotocol/server-sequential-thinking'],
            disabled: false,
          },
        },
        {
          id: 'context7',
          name: 'Context7',
          description: 'Up-to-date documentation and code examples for any library',
          config: { type: 'streaming', url: 'https://mcp.context7.com/mcp' },
        },
        {
          id: 'filesystem',
          name: 'Filesystem',
          description: 'File system operations',
          config: {
            command: 'npx',
            args: ['-y', '@modelcontextprotocol/server-filesystem', '/path/to/allowed/directory'],
            disabled: false,
          },
          requiresAdditionalConfig: true,
          additionalConfigNote: '请将 /path/to/allowed/directory 替换为实际的文件系统路径',
        },
        {
          id: 'memory',
          name: 'Memory',
          description: 'Persistent memory storage',
          config: {
            command: 'npx',
            args: ['-y', '@modelcontextprotocol/server-memory'],
            disabled: false,
          },
        },
        {
          id: 'brave-search',
          name: 'Brave Search',
          description: 'Brave search engine integration',
          config: {
            command: 'npx',
            args: ['-y', '@modelcontextprotocol/server-brave-search'],
            env: { BRAVE_API_KEY: 'your-api-key-here' },
            disabled: false,
          },
          requiresAdditionalConfig: true,
          additionalConfigNote: '请设置 BRAVE_API_KEY 环境变量',
        },
        {
          id: 'github',
          name: 'GitHub',
          description: 'GitHub repository management',
          config: {
            command: 'npx',
            args: ['-y', '@modelcontextprotocol/server-github'],
            env: { GITHUB_PERSONAL_ACCESS_TOKEN: 'your-token-here' },
            disabled: false,
          },
          requiresAdditionalConfig: true,
          additionalConfigNote: '请设置 GITHUB_PERSONAL_ACCESS_TOKEN 环境变量',
        },
      ]);
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

    it('应该创建包含精确默认内容的服务器配置', async () => {
      await generator.initConfigFiles();

      const serviceConfigPath = join(testDir, 'mcp_server.json');
      const content = await readFile(serviceConfigPath, 'utf-8');
      const config = JSON.parse(content);

      expect(config).toEqual({
        servers: {
          fetch: { command: 'uvx', args: ['mcp-server-fetch'], disabled: false },
          time: { command: 'uvx', args: ['mcp-server-time'], disabled: false },
          'sequential-thinking': {
            command: 'npx',
            args: ['-y', '@modelcontextprotocol/server-sequential-thinking'],
            disabled: false,
          },
          context7: { type: 'streaming', url: 'https://mcp.context7.com/mcp' },
        },
        settings: {
          logLevel: 'info',
          connectionTimeout: 30000,
          maxConcurrentConnections: 10,
        },
      });
      // 服务器写入顺序与默认预设顺序一致
      expect(Object.keys(config.servers)).toEqual([
        'fetch',
        'time',
        'sequential-thinking',
        'context7',
      ]);
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

    it('group.json 应该包含精确的默认组和 web-tools 组', async () => {
      generator = new DefaultConfigGenerator({
        configDir: testDir,
        includeGroups: true,
      });

      await generator.initConfigFiles();

      const groupConfigPath = join(testDir, 'group.json');
      const content = await readFile(groupConfigPath, 'utf-8');
      const config = JSON.parse(content);

      expect(config).toEqual({
        default: {
          id: 'default',
          name: '默认组',
          description: '包含所有默认服务器',
          servers: ['fetch', 'time', 'sequential-thinking', 'context7'],
          tools: [],
        },
        'web-tools': {
          id: 'web-tools',
          name: 'Web工具组',
          description: '仅包含Web相关工具',
          servers: ['fetch'],
          tools: [],
          toolFilter: { include: ['fetch'] },
        },
      });
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

    it('mcp_server.json 已存在且不覆盖时，includeGroups 只创建 group.json', async () => {
      await generator.initConfigFiles(); // 先创建 mcp_server.json

      generator = new DefaultConfigGenerator({
        configDir: testDir,
        includeGroups: true,
        overwrite: false,
      });
      const result = await generator.initConfigFiles();

      expect(result.createdFiles).toEqual([join(testDir, 'group.json')]);
      expect(result.skippedFiles).toEqual([join(testDir, 'mcp_server.json')]);
      expect(result.errors).toHaveLength(0);
    });

    it('写入失败时返回包含目标路径的错误信息', async () => {
      // 将 .tmp 临时文件路径占位为目录，导致 writeFile 失败
      const { mkdir } = await import('node:fs/promises');
      await mkdir(join(testDir, 'mcp_server.json.tmp'));

      const result = await generator.initConfigFiles();

      expect(result.createdFiles).toHaveLength(0);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain('无法写入配置文件');
      expect(result.errors[0]).toContain(join(testDir, 'mcp_server.json'));
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
    it('应该处理文件系统错误', async () => {
      // 使用无效路径（在某些系统上可能无法创建）
      const invalidDir = '/invalid/path/that/cannot/be/created/1234567890';

      generator = new DefaultConfigGenerator({
        configDir: invalidDir,
      });

      const result = await generator.initConfigFiles();

      // 应该返回错误而不是抛出异常
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors[0]).toContain('配置目录无法创建');
      expect(result.createdFiles).toHaveLength(0);
    });
  });
});
