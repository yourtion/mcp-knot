import { beforeEach, describe, expect, it } from 'vitest';

import { ConfigTemplateGenerator } from './config-template';

import type { ConfigTemplateType } from '../types';

describe('ConfigTemplateGenerator', () => {
  let generator: ConfigTemplateGenerator;

  beforeEach(() => {
    generator = new ConfigTemplateGenerator();
  });

  describe('generateBasicTemplate', () => {
    it('应该生成基础配置模板', () => {
      const template = generator.generateBasicTemplate();

      expect(template).toHaveProperty('servers');
      expect(template).toHaveProperty('logging');
      expect(template).toHaveProperty('transport');

      expect(template.servers).toHaveProperty('example_server');
      expect(template.servers.example_server).toEqual({
        command: 'node',
        args: ['example-mcp-server.js'],
        env: {},
        disabled: false,
      });

      expect(template.logging).toEqual({
        level: 'info',
      });

      expect(template.transport).toEqual({
        type: 'stdio',
      });
    });

    it('应该生成有效的配置结构', () => {
      const template = generator.generateBasicTemplate();

      // 验证配置结构的完整性
      expect(Object.keys(template.servers)).toHaveLength(1);
      expect(template.servers.example_server.command).toBeTruthy();
      expect(Array.isArray(template.servers.example_server.args)).toBe(true);
    });
  });

  describe('generateAdvancedTemplate', () => {
    it('应该生成高级配置模板', () => {
      const template = generator.generateAdvancedTemplate();

      expect(template.servers).toHaveProperty('file_server');
      expect(template.servers).toHaveProperty('database_server');
      expect(template.servers).toHaveProperty('api_server');

      // 验证文件服务器配置
      expect(template.servers.file_server).toEqual({
        command: 'node',
        args: ['file-server.js'],
        env: {
          NODE_ENV: 'production',
          LOG_LEVEL: 'info',
        },
        cwd: './servers',
        disabled: false,
        timeout: 30000,
      });

      // 验证数据库服务器配置
      expect(template.servers.database_server).toEqual({
        command: 'python',
        args: ['-m', 'database_server'],
        env: {
          PYTHONPATH: './python-servers',
          DB_URL: 'sqlite:///data.db',
        },
        disabled: false,
        timeout: 60000,
      });

      // 验证API服务器配置
      expect(template.servers.api_server).toEqual({
        command: 'uvx',
        args: ['api-server@latest'],
        env: {
          API_KEY: 'your-api-key-here',
        },
        disabled: false,
      });

      // 验证日志配置
      expect(template.logging).toEqual({
        level: 'info',
        file: './logs/mcp-knot.log',
      });
    });

    it('应该包含多个不同类型的服务器', () => {
      const template = generator.generateAdvancedTemplate();

      expect(Object.keys(template.servers)).toHaveLength(3);

      // 验证不同的命令类型
      const commands = Object.values(template.servers).map((s) => s.command);
      expect(commands).toContain('node');
      expect(commands).toContain('python');
      expect(commands).toContain('uvx');
    });
  });

  describe('generateDevelopmentTemplate', () => {
    it('应该生成开发环境配置模板', () => {
      const template = generator.generateDevelopmentTemplate();

      expect(template.servers).toHaveProperty('dev_server');
      expect(template.servers).toHaveProperty('test_server');

      // 验证开发服务器配置
      expect(template.servers.dev_server).toEqual({
        command: 'npm',
        args: ['run', 'dev'],
        env: {
          NODE_ENV: 'development',
          DEBUG: '*',
        },
        cwd: './dev-server',
        disabled: false,
      });

      // 验证测试服务器配置
      expect(template.servers.test_server).toEqual({
        command: 'node',
        args: ['--inspect', 'test-server.js'],
        env: {
          NODE_ENV: 'test',
        },
        disabled: true, // 默认禁用
      });

      // 验证调试日志级别
      expect(template.logging.level).toBe('debug');
    });

    it('应该包含开发相关的环境变量', () => {
      const template = generator.generateDevelopmentTemplate();

      expect(template.servers.dev_server.env).toHaveProperty('NODE_ENV', 'development');
      expect(template.servers.dev_server.env).toHaveProperty('DEBUG', '*');
      expect(template.servers.test_server.env).toHaveProperty('NODE_ENV', 'test');
    });
  });

  describe('generateProductionTemplate', () => {
    it('应该生成生产环境配置模板', () => {
      const template = generator.generateProductionTemplate();

      expect(template.servers).toHaveProperty('main_server');
      expect(template.servers).toHaveProperty('backup_server');

      // 验证主服务器配置
      expect(template.servers.main_server).toEqual({
        command: 'node',
        args: ['--max-old-space-size=4096', 'main-server.js'],
        env: {
          NODE_ENV: 'production',
          LOG_LEVEL: 'warn',
        },
        disabled: false,
        timeout: 120000,
      });

      // 验证备份服务器配置
      expect(template.servers.backup_server).toEqual({
        command: 'node',
        args: ['backup-server.js'],
        env: {
          NODE_ENV: 'production',
        },
        disabled: false,
        timeout: 60000,
      });

      // 验证生产日志配置
      expect(template.logging).toEqual({
        level: 'warn',
        file: '/var/log/mcp-knot/mcp-knot.log',
      });
    });

    it('应该包含生产优化配置', () => {
      const template = generator.generateProductionTemplate();

      // 验证内存优化参数
      expect(template.servers.main_server.args).toContain('--max-old-space-size=4096');

      // 验证较长的超时时间
      expect(template.servers.main_server.timeout).toBe(120000);
      expect(template.servers.backup_server.timeout).toBe(60000);

      // 验证生产环境变量
      expect(template.servers.main_server.env.NODE_ENV).toBe('production');
      expect(template.servers.backup_server.env.NODE_ENV).toBe('production');
    });
  });

  describe('generateTemplate', () => {
    it('应该根据类型生成正确的模板', () => {
      const types: ConfigTemplateType[] = ['basic', 'advanced', 'development', 'production'];

      for (const type of types) {
        const template = generator.generateTemplate(type);
        expect(template).toHaveProperty('servers');
        expect(template).toHaveProperty('logging');
        expect(template).toHaveProperty('transport');
      }
    });

    it('应该为未知类型返回基础模板', () => {
      const template = generator.generateTemplate('unknown' as ConfigTemplateType);
      const basicTemplate = generator.generateBasicTemplate();

      expect(template).toEqual(basicTemplate);
    });

    it('应该生成不同的模板内容', () => {
      const basic = generator.generateTemplate('basic');
      const advanced = generator.generateTemplate('advanced');
      const development = generator.generateTemplate('development');
      const production = generator.generateTemplate('production');

      // 验证模板之间的差异
      expect(Object.keys(basic.servers)).toHaveLength(1);
      expect(Object.keys(advanced.servers)).toHaveLength(3);
      expect(Object.keys(development.servers)).toHaveLength(2);
      expect(Object.keys(production.servers)).toHaveLength(2);

      // 验证日志级别差异
      expect(basic.logging.level).toBe('info');
      expect(development.logging.level).toBe('debug');
      expect(production.logging.level).toBe('warn');
    });
  });

  describe('getTemplateJson', () => {
    it('应该返回格式化的JSON字符串', () => {
      const json = generator.getTemplateJson('basic');

      expect(typeof json).toBe('string');
      expect(() => JSON.parse(json)).not.toThrow();

      const parsed = JSON.parse(json);
      expect(parsed).toHaveProperty('servers');
      expect(parsed).toHaveProperty('logging');
      expect(parsed).toHaveProperty('transport');
    });

    it('各模板类型应输出对应的JSON内容', () => {
      expect(generator.getTemplateJson('basic')).toContain('example_server');
      expect(generator.getTemplateJson('advanced')).toContain('file_server');
      expect(generator.getTemplateJson('development')).toContain('dev_server');
      expect(generator.getTemplateJson('production')).toContain('main_server');
    });

    it('应该生成美化的JSON格式', () => {
      const json = generator.getTemplateJson('basic');

      // 验证JSON是否被美化（包含缩进）
      expect(json).toContain('  ');
      expect(json).toContain('\n');
    });

    it('应该为不同类型生成不同的JSON', () => {
      const basicJson = generator.getTemplateJson('basic');
      const advancedJson = generator.getTemplateJson('advanced');

      expect(basicJson).not.toBe(advancedJson);
    });
  });

  describe('getTemplateWithComments', () => {
    it('应该返回带注释的配置模板', () => {
      const template = generator.getTemplateWithComments('basic');

      expect(template).toContain('// MCP Knot CLI 配置文件');
      expect(template).toContain('// 配置说明:');
      expect(template).toContain('// - servers:');
      expect(template).toContain('// - logging:');
      expect(template).toContain('// - transport:');
      expect(template).toContain('{');
      expect(template).toContain('}');
    });

    it('应该为不同类型包含特定注释', () => {
      const developmentTemplate = generator.getTemplateWithComments('development');
      const productionTemplate = generator.getTemplateWithComments('production');
      const advancedTemplate = generator.getTemplateWithComments('advanced');

      expect(developmentTemplate).toContain('// 开发环境配置');
      expect(developmentTemplate).toContain('// - 启用调试日志');

      expect(productionTemplate).toContain('// 生产环境配置');
      expect(productionTemplate).toContain('// - 优化内存使用');

      expect(advancedTemplate).toContain('// 高级配置示例');
      expect(advancedTemplate).toContain('// - 日志文件输出');
    });

    it('应该包含JSON配置内容', () => {
      const template = generator.getTemplateWithComments('basic');
      const jsonPart = template
        .split('\n')
        .filter((line) => !line.startsWith('//'))
        .join('\n');

      expect(() => JSON.parse(jsonPart.trim())).not.toThrow();
    });
  });

  describe('getAvailableTemplates', () => {
    it('应该返回所有可用的模板类型', () => {
      const templates = generator.getAvailableTemplates();

      expect(templates).toHaveLength(4);
      expect(templates.map((t) => t.type)).toEqual([
        'basic',
        'advanced',
        'development',
        'production',
      ]);
    });

    it('应该包含每个模板的描述', () => {
      const templates = generator.getAvailableTemplates();

      for (const template of templates) {
        expect(template).toHaveProperty('type');
        expect(template).toHaveProperty('description');
        expect(typeof template.type).toBe('string');
        expect(typeof template.description).toBe('string');
        expect(template.description.length).toBeGreaterThan(0);
      }
    });

    it('应该包含中文描述', () => {
      const templates = generator.getAvailableTemplates();

      expect(templates[0].description).toContain('基础配置');
      expect(templates[1].description).toContain('高级配置');
      expect(templates[2].description).toContain('开发环境');
      expect(templates[3].description).toContain('生产环境');
    });
  });

  describe('模板一致性验证', () => {
    it('所有模板都应该有相同的基础结构', () => {
      const types: ConfigTemplateType[] = ['basic', 'advanced', 'development', 'production'];

      for (const type of types) {
        const template = generator.generateTemplate(type);

        expect(template).toHaveProperty('servers');
        expect(template).toHaveProperty('logging');
        expect(template).toHaveProperty('transport');
        expect(typeof template.servers).toBe('object');
        expect(typeof template.logging).toBe('object');
        expect(typeof template.transport).toBe('object');
      }
    });

    it('所有服务器配置都应该有必需的字段', () => {
      const types: ConfigTemplateType[] = ['basic', 'advanced', 'development', 'production'];

      for (const type of types) {
        const template = generator.generateTemplate(type);

        for (const [_serverId, serverConfig] of Object.entries(template.servers)) {
          expect(serverConfig).toHaveProperty('command');
          expect(typeof serverConfig.command).toBe('string');
          expect(serverConfig.command.length).toBeGreaterThan(0);

          if (serverConfig.args) {
            expect(Array.isArray(serverConfig.args)).toBe(true);
          }

          if (serverConfig.env) {
            expect(typeof serverConfig.env).toBe('object');
          }
        }
      }
    });

    it('所有模板的transport类型都应该是stdio', () => {
      const types: ConfigTemplateType[] = ['basic', 'advanced', 'development', 'production'];

      for (const type of types) {
        const template = generator.generateTemplate(type);
        expect(template.transport.type).toBe('stdio');
      }
    });
  });
});
