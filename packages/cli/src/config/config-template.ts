/**
 * CLI配置模板生成器
 * 提供各种配置模板和示例
 */

import type { CliConfig } from '../types/index.js';

/**
 * 配置模板类型
 */
export type ConfigTemplateType = 'basic' | 'advanced' | 'development' | 'production';

/**
 * 配置模板生成器
 */
export class ConfigTemplateGenerator {
  /**
   * 生成基础配置模板
   */
  generateBasicTemplate(): CliConfig {
    return {
      servers: {
        example_server: {
          command: 'node',
          args: ['example-mcp-server.js'],
          env: {},
          disabled: false,
        },
      },
      logging: {
        level: 'info',
      },
      transport: {
        type: 'stdio',
      },
    };
  }

  /**
   * 生成高级配置模板
   */
  generateAdvancedTemplate(): CliConfig {
    return {
      servers: {
        file_server: {
          command: 'node',
          args: ['file-server.js'],
          env: {
            NODE_ENV: 'production',
            LOG_LEVEL: 'info',
          },
          cwd: './servers',
          disabled: false,
          timeout: 30000,
        },
        database_server: {
          command: 'python',
          args: ['-m', 'database_server'],
          env: {
            PYTHONPATH: './python-servers',
            DB_URL: 'sqlite:///data.db',
          },
          disabled: false,
          timeout: 60000,
        },
        api_server: {
          command: 'uvx',
          args: ['api-server@latest'],
          env: {
            API_KEY: 'your-api-key-here',
          },
          disabled: false,
        },
      },
      logging: {
        level: 'info',
        file: './logs/mcp-knot.log',
      },
      transport: {
        type: 'stdio',
      },
    };
  }

  /**
   * 生成开发环境配置模板
   */
  generateDevelopmentTemplate(): CliConfig {
    return {
      servers: {
        dev_server: {
          command: 'npm',
          args: ['run', 'dev'],
          env: {
            NODE_ENV: 'development',
            DEBUG: '*',
          },
          cwd: './dev-server',
          disabled: false,
        },
        test_server: {
          command: 'node',
          args: ['--inspect', 'test-server.js'],
          env: {
            NODE_ENV: 'test',
          },
          disabled: true, // 默认禁用测试服务器
        },
      },
      logging: {
        level: 'debug',
      },
      transport: {
        type: 'stdio',
      },
    };
  }

  /**
   * 生成生产环境配置模板
   */
  generateProductionTemplate(): CliConfig {
    return {
      servers: {
        main_server: {
          command: 'node',
          args: ['--max-old-space-size=4096', 'main-server.js'],
          env: {
            NODE_ENV: 'production',
            LOG_LEVEL: 'warn',
          },
          disabled: false,
          timeout: 120000,
        },
        backup_server: {
          command: 'node',
          args: ['backup-server.js'],
          env: {
            NODE_ENV: 'production',
          },
          disabled: false,
          timeout: 60000,
        },
      },
      logging: {
        level: 'warn',
        file: '/var/log/mcp-knot/mcp-knot.log',
      },
      transport: {
        type: 'stdio',
      },
    };
  }

  /**
   * 根据类型生成配置模板
   */
  generateTemplate(type: ConfigTemplateType): CliConfig {
    switch (type) {
      case 'basic':
        return this.generateBasicTemplate();
      case 'advanced':
        return this.generateAdvancedTemplate();
      case 'development':
        return this.generateDevelopmentTemplate();
      case 'production':
        return this.generateProductionTemplate();
      default:
        return this.generateBasicTemplate();
    }
  }

  /**
   * 获取配置模板的JSON字符串
   */
  getTemplateJson(type: ConfigTemplateType): string {
    const template = this.generateTemplate(type);
    return JSON.stringify(template, null, 2);
  }

  /**
   * 获取带注释的配置模板
   */
  getTemplateWithComments(type: ConfigTemplateType): string {
    const template = this.generateTemplate(type);
    const json = JSON.stringify(template, null, 2);

    // 添加注释
    const comments = this.getTemplateComments(type);

    return `${comments}\n${json}`;
  }

  /**
   * 获取配置模板的注释说明
   */
  private getTemplateComments(type: ConfigTemplateType): string {
    const baseComments = `// MCP Knot CLI 配置文件
// 此文件定义了MCP服务器的配置和CLI选项

// 配置说明:
// - servers: 定义要聚合的MCP服务器
//   - command: 启动服务器的命令
//   - args: 命令参数数组
//   - env: 环境变量
//   - cwd: 工作目录
//   - disabled: 是否禁用此服务器
//   - timeout: 连接超时时间(毫秒)
// - logging: 日志配置
//   - level: 日志级别 (debug, info, warn, error)
//   - file: 日志文件路径(可选)
// - transport: 传输层配置
//   - type: 传输类型 (目前只支持 stdio)`;

    switch (type) {
      case 'development':
        return `${baseComments}

// 开发环境配置
// - 启用调试日志
// - 包含开发工具和调试选项`;

      case 'production':
        return `${baseComments}

// 生产环境配置
// - 优化内存使用
// - 减少日志输出
// - 增加超时时间`;

      case 'advanced':
        return `${baseComments}

// 高级配置示例
// - 多种类型的服务器
// - 详细的环境变量配置
// - 日志文件输出`;

      default:
        return `${baseComments}

// 基础配置模板
// - 简单的单服务器配置
// - 适合快速开始使用`;
    }
  }

  /**
   * 获取所有可用的模板类型
   */
  getAvailableTemplates(): Array<{
    type: ConfigTemplateType;
    description: string;
  }> {
    return [
      { type: 'basic', description: '基础配置 - 简单的单服务器配置' },
      { type: 'advanced', description: '高级配置 - 多服务器配置示例' },
      { type: 'development', description: '开发环境 - 包含调试选项' },
      { type: 'production', description: '生产环境 - 优化的生产配置' },
    ];
  }
}
