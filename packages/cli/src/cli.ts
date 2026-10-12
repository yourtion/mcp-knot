#!/usr/bin/env node

/**
 * MCP Knot CLI 主入口文件
 * 处理命令行参数并启动MCP服务器
 */

import { CompatibilityOptionsSchema } from '@mcp-core/mcp-knot-protocol';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { CliConfigManager } from './config/cli-config-manager.js';
import { CliMcpServer } from './server/cli-mcp-server.js';

import type { ConfigTemplateType } from './config/config-template.js';
import type { CliError } from './types/index.js';

/**
 * 命令行选项接口
 */
export interface CliOptions {
  configPath: string;
  verbose: boolean;
  help: boolean;
  version: boolean;
  generateConfig: boolean;
  templateType: ConfigTemplateType;
  validateConfig: boolean;
  listTemplates: boolean;
  listPresets: boolean;
  init: boolean;
  initAll: boolean;
  overwrite: boolean;
  /**
   * `--no-legacy-inbound`：关闭入站 legacy shim（inbound.enabled=false）。
   */
  noLegacyInbound?: boolean;
  /**
   * `--modern-only-upstream`：上游仅走现代协议（outbound.modernOnly=true）。
   */
  modernOnlyUpstream?: boolean;
}

/**
 * 解析命令行参数
 */
export function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = {
    configPath: './mcp_server.json',
    verbose: false,
    help: false,
    version: false,
    generateConfig: false,
    templateType: 'basic',
    validateConfig: false,
    listTemplates: false,
    listPresets: false,
    init: false,
    initAll: false,
    overwrite: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    switch (arg) {
      case '-h':
      case '--help':
        options.help = true;
        break;
      case '-v':
      case '--verbose':
        options.verbose = true;
        break;
      case '--version':
        options.version = true;
        break;
      case '-c':
      case '--config':
        if (i + 1 < args.length) {
          options.configPath = args[++i];
        } else {
          throw new Error('--config 选项需要指定配置文件路径');
        }
        break;
      case '--generate-config':
        options.generateConfig = true;
        break;
      case '--template':
        if (i + 1 < args.length) {
          const templateType = args[++i] as ConfigTemplateType;
          if (['basic', 'advanced', 'development', 'production'].includes(templateType)) {
            options.templateType = templateType;
          } else {
            throw new Error(`无效的模板类型: ${templateType}`);
          }
        } else {
          throw new Error('--template 选项需要指定模板类型');
        }
        break;
      case '--validate':
        options.validateConfig = true;
        break;
      case '--list-templates':
        options.listTemplates = true;
        break;
      case '--list-presets':
        options.listPresets = true;
        break;
      case '--init':
        options.init = true;
        break;
      case '--init-all':
        options.initAll = true;
        break;
      case '--overwrite':
        options.overwrite = true;
        break;
      case '--no-legacy-inbound':
        options.noLegacyInbound = true;
        break;
      case '--modern-only-upstream':
        options.modernOnlyUpstream = true;
        break;
      default:
        // 如果不是选项，则作为配置文件路径
        if (!arg.startsWith('-') && options.configPath === './mcp_server.json') {
          options.configPath = arg;
        }
        break;
    }
  }

  return options;
}

/**
 * 显示帮助信息
 */
function showHelp(): void {
  console.log(`
MCP Knot CLI - 聚合多个MCP服务的命令行界面

用法:
  mcp-knot [选项] [配置文件路径]

选项:
  -h, --help              显示帮助信息
  -v, --verbose           启用详细日志输出
  --version               显示版本信息
  -c, --config <path>     指定配置文件路径 (默认: ./mcp_server.json)
  --generate-config       生成配置文件模板
  --template <type>       指定配置模板类型 (basic, advanced, development, production)
  --validate              验证配置文件
  --list-templates        列出所有可用的配置模板
  --list-presets          列出所有可用的服务器预设
  --init                  快速初始化配置文件（包含常用服务器示例）
  --init-all              初始化所有配置文件（包含组配置）
  --overwrite             覆盖已存在的配置文件
  --no-legacy-inbound     关闭入站 legacy 协议 shim（仅接受现代协议客户端）
  --modern-only-upstream  预留选项（CLI 上游连接尚未实现，当前不生效）

示例:
  mcp-knot                                    # 使用默认配置文件
  mcp-knot config.json                        # 使用指定配置文件
  mcp-knot -c config.json -v                  # 使用指定配置文件并启用详细日志
  mcp-knot --generate-config                  # 生成基础配置模板
  mcp-knot --generate-config --template advanced  # 生成高级配置模板
  mcp-knot --validate -c config.json          # 验证配置文件
  mcp-knot --list-templates                   # 列出所有模板类型
  mcp-knot --list-presets                     # 列出所有可用的服务器预设
  mcp-knot --init                             # 快速初始化配置文件
  mcp-knot --init-all --overwrite             # 初始化所有配置并覆盖已存在文件

配置文件格式:
  {
    "servers": {
      "server_name": {
        "command": "node",
        "args": ["server.js"],
        "env": {},
        "disabled": false
      }
    },
    "logging": {
      "level": "info"
    },
    "transport": {
      "type": "stdio"
    }
  }
`);
}

/**
 * 显示版本信息
 */
function showVersion(): void {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  console.log(`MCP Knot CLI v${pkg.version}`);
}

/**
 * 生成配置文件模板
 */
async function generateConfig(templateType: ConfigTemplateType): Promise<void> {
  const configManager = new CliConfigManager();
  const template = configManager.getConfigTemplateWithComments(templateType);

  console.log(`# MCP Knot CLI 配置文件模板 (${templateType})`);
  console.log('# 将以下内容保存为 mcp_server.json');
  console.log('');
  console.log(template);
}

/**
 * 验证配置文件
 */
async function validateConfig(configPath: string): Promise<void> {
  const configManager = new CliConfigManager();

  try {
    console.log(`验证配置文件: ${configPath}`);

    // 加载配置
    const config = await configManager.loadConfig(configPath);

    // 详细验证
    const result = configManager.validateConfigDetailed(config);

    // 显示验证结果
    console.log(`\n${configManager.formatValidationResult(result)}`);

    if (!result.valid) {
      process.exit(1);
    }
  } catch (error) {
    handleCliError(error);
    process.exit(1);
  }
}

/**
 * 列出所有可用的配置模板
 */
async function listTemplates(): Promise<void> {
  const configManager = new CliConfigManager();
  const templates = configManager.getAvailableTemplates();

  console.log('可用的配置模板:');
  console.log('');

  for (const template of templates) {
    console.log(`  ${template.type.padEnd(12)} - ${template.description}`);
  }

  console.log('');
  console.log('使用方法:');
  console.log('  mcp-knot --generate-config --template <type>');
}

/**
 * 初始化配置文件
 */
async function initConfig(
  includeGroups: boolean,
  overwrite: boolean,
  configDir: string,
): Promise<void> {
  const { DefaultConfigGenerator } = await import('@mcp-core/mcp-knot-core');

  console.log('正在初始化配置文件...');
  console.log(`配置目录: ${configDir}`);

  const generator = new DefaultConfigGenerator({
    includeExamples: true,
    includeGroups,
    configDir,
    overwrite,
  });

  const result = await generator.initConfigFiles();

  console.log('\n初始化结果:');

  if (result.createdFiles.length > 0) {
    console.log('✅ 已创建配置文件:');
    for (const file of result.createdFiles) {
      console.log(`  - ${file}`);
    }
  }

  if (result.skippedFiles.length > 0) {
    console.log('⏭️  已跳过（文件已存在）:');
    for (const file of result.skippedFiles) {
      console.log(`  - ${file}`);
    }
  }

  if (result.errors.length > 0) {
    console.log('❌ 错误:');
    for (const error of result.errors) {
      console.log(`  - ${error}`);
    }
    process.exit(1);
  }

  if (result.createdFiles.length > 0) {
    console.log('\n📝 下一步:');
    console.log('  1. 根据需要修改配置文件');
    console.log('  2. 运行: mcp-knot');
    console.log('\n💡 提示: 使用 mcp-knot --list-presets 查看所有可用的服务器预设');
  }
}

/**
 * 列出所有可用的服务器预设
 */
async function listServerPresets(): Promise<void> {
  const { DefaultConfigGenerator } = await import('@mcp-core/mcp-knot-core');

  const generator = new DefaultConfigGenerator();
  const presets = generator.getAvailableServerPresets();

  console.log('可用的 MCP 服务器预设:');
  console.log('');

  for (const preset of presets) {
    console.log(`  ${preset.id.padEnd(20)} - ${preset.name}`);
    console.log(`                      ${preset.description}`);
  }

  console.log('');
  console.log('使用方法:');
  console.log(
    '  mcp-knot --init          # 初始化默认配置（包含 fetch, time, sequential-thinking）',
  );
  console.log('  mcp-knot --init-all      # 初始化所有配置（包含组配置）');
}

/**
 * 设置日志级别
 */
function setupLogging(verbose: boolean): void {
  if (verbose) {
    // 在详细模式下显示调试信息
    const originalLog = console.log;
    const _originalDebug = console.debug;

    console.debug = (...args: unknown[]) => {
      originalLog('[DEBUG]', ...args);
    };
  } else {
    // 在非详细模式下隐藏调试信息
    console.debug = () => {};
  }
}

/**
 * 处理CLI错误
 */
function handleCliError(error: unknown): void {
  if (isCliError(error)) {
    console.error(`错误 (${error.code}): ${error.message}`);

    if (error.details) {
      console.error('详细信息:', error.details);
    }

    // 根据错误类型提供帮助信息
    switch (error.code) {
      case 'CONFIG_FILE_NOT_FOUND':
        console.error('\n提示: 使用 --generate-config 生成配置文件模板');
        break;
      case 'INVALID_CONFIG_FORMAT':
        console.error('\n提示: 检查配置文件的JSON格式是否正确');
        break;
    }
  } else if (error instanceof Error) {
    console.error('错误:', error.message);
  } else {
    console.error('未知错误:', error);
  }
}

/**
 * 检查是否为CLI错误
 */
function isCliError(error: unknown): error is CliError {
  return error instanceof Error && 'code' in error;
}

/**
 * 主函数 - 启动CLI MCP服务器
 */
async function main() {
  try {
    // 解析命令行参数
    const options = parseArgs(process.argv.slice(2));

    // 设置日志级别
    setupLogging(options.verbose);

    // 处理特殊选项
    if (options.help) {
      showHelp();
      return;
    }

    if (options.version) {
      showVersion();
      return;
    }

    if (options.listTemplates) {
      await listTemplates();
      return;
    }

    if (options.listPresets) {
      await listServerPresets();
      return;
    }

    if (options.generateConfig) {
      await generateConfig(options.templateType);
      return;
    }

    if (options.validateConfig) {
      await validateConfig(options.configPath);
      return;
    }

    if (options.init || options.initAll) {
      const configDir = process.cwd();
      await initConfig(options.initAll, options.overwrite, configDir);
      return;
    }

    console.log('启动MCP Knot CLI服务器...');
    console.log(`配置文件: ${options.configPath}`);

    // 创建配置管理器
    const configManager = new CliConfigManager();

    // 加载配置
    const config = await configManager.loadConfig(options.configPath);

    // 应用详细模式到配置
    if (options.verbose && config.logging.level === 'info') {
      config.logging.level = 'debug';
    }

    // 创建并启动CLI MCP服务器
    // 将启动 flag 映射到协议兼容层配置：--no-legacy-inbound 关闭入站 legacy
    // shim；--modern-only-upstream 限定上游仅走现代协议。经 schema 回填默认值
    // 后交给 cli-mcp-server，由 InboundProtocolAdapter 据此解析 stdio 的 legacy
    // 取值。
    const compat = CompatibilityOptionsSchema.parse({
      inbound: { enabled: !options.noLegacyInbound },
      outbound: { modernOnly: options.modernOnlyUpstream ?? false },
    });
    const server = new CliMcpServer();
    await server.initialize(config, compat);
    await server.start();

    console.log('MCP Knot CLI服务器启动成功');
    console.log('等待MCP客户端连接...');

    // 处理优雅关闭
    const shutdown = async (signal: string) => {
      console.log(`\n收到 ${signal} 信号，正在关闭MCP Knot CLI服务器...`);
      try {
        await server.shutdown();
        console.log('MCP Knot CLI服务器已安全关闭');
        process.exit(0);
      } catch (error) {
        console.error('关闭服务器时出错:', error);
        process.exit(1);
      }
    };

    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));

    // 处理未捕获的异常
    process.on('uncaughtException', (error) => {
      console.error('未捕获的异常:', error);
      shutdown('uncaughtException').catch(() => process.exit(1));
    });

    process.on('unhandledRejection', (reason, promise) => {
      console.error('未处理的Promise拒绝:', reason, 'at:', promise);
      shutdown('unhandledRejection').catch(() => process.exit(1));
    });
  } catch (error) {
    handleCliError(error);
    process.exit(1);
  }
}

// 仅当本模块作为入口（直接运行 dist/cli.js 或经 bin 动态导入）时才启动；
// 被测试 import 时（既不直接运行也未由 bin 设置标记）不触发 main()。
const isMainEntry =
  import.meta.url === pathToFileURL(resolve(process.argv[1] ?? '')).href ||
  process.env.MCP_KNOT_CLI_RUN === '1';
if (isMainEntry) {
  main().catch((error) => {
    handleCliError(error);
    process.exit(1);
  });
}
