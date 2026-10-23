/**
 * CLI 入口 main() 场景测试
 *
 * 通过 MCP_KNOT_CLI_RUN=1 触发 isMainEntry 守卫，动态 import 后 main()
 * 随模块执行；外部依赖（配置管理器 / 服务器 / 核心包 / 协议 schema）全部
 * mock，argv / process.exit / console 均在测试内构造，保证确定性。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const configManagerMocks = vi.hoisted(() => ({
  loadConfig: vi.fn(),
  validateConfigDetailed: vi.fn(),
  formatValidationResult: vi.fn(),
  getConfigTemplateWithComments: vi.fn(),
  getAvailableTemplates: vi.fn(),
}));

const serverMocks = vi.hoisted(() => ({
  initialize: vi.fn(),
  start: vi.fn(),
  shutdown: vi.fn(),
}));

const generatorMocks = vi.hoisted(() => ({
  constructedWith: undefined as unknown,
  initConfigFiles: vi.fn(),
  getAvailableServerPresets: vi.fn(),
}));

const compatParse = vi.hoisted(() => vi.fn((value: unknown) => value));

vi.mock('./config/cli-config-manager.js', () => ({
  // 需支持 new 调用，使用普通 function 并返回 mock 对象
  CliConfigManager: vi.fn(function CliConfigManager() {
    return configManagerMocks;
  }),
}));

vi.mock('./server/cli-mcp-server.js', () => ({
  CliMcpServer: vi.fn(function CliMcpServer() {
    return serverMocks;
  }),
}));

vi.mock('@mcp-core/mcp-knot-core', () => ({
  DefaultConfigGenerator: vi.fn(function DefaultConfigGenerator(options: unknown) {
    generatorMocks.constructedWith = options;
    return {
      initConfigFiles: generatorMocks.initConfigFiles,
      getAvailableServerPresets: generatorMocks.getAvailableServerPresets,
    };
  }),
}));

vi.mock('@mcp-core/mcp-knot-protocol', () => ({
  CompatibilityOptionsSchema: { parse: compatParse },
}));

/** 以给定 argv 运行 CLI 入口（main 会随 import 执行） */
async function runCli(args: string[]): Promise<void> {
  process.argv = ['node', '/fake/dist/cli.js', ...args];
  process.env.MCP_KNOT_CLI_RUN = '1';
  vi.resetModules();
  await import('./cli');
}

describe('CLI main 场景', () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let originalArgv: string[];
  let originalDebug: (...data: unknown[]) => void;

  beforeEach(() => {
    originalArgv = process.argv;
    originalDebug = console.debug;
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
  });

  afterEach(() => {
    process.argv = originalArgv;
    delete process.env.MCP_KNOT_CLI_RUN;
    console.debug = originalDebug;
  });

  describe('入口守卫', () => {
    it('未设置 MCP_KNOT_CLI_RUN 时不执行 main', async () => {
      delete process.env.MCP_KNOT_CLI_RUN;
      vi.resetModules();
      await import('./cli');

      expect(configManagerMocks.loadConfig).not.toHaveBeenCalled();
      expect(serverMocks.initialize).not.toHaveBeenCalled();
    });

    it('设置 MCP_KNOT_CLI_RUN=1 时执行 main 并走服务器启动路径', async () => {
      configManagerMocks.loadConfig.mockResolvedValue({
        servers: { s: { command: 'node' } },
        logging: { level: 'info' },
        transport: { type: 'stdio' },
      });
      serverMocks.initialize.mockResolvedValue(undefined);
      serverMocks.start.mockResolvedValue(undefined);
      vi.spyOn(process, 'on').mockImplementation((() => process) as never);

      await runCli([]);
      await vi.waitFor(() => {
        expect(serverMocks.start).toHaveBeenCalledTimes(1);
      });

      expect(configManagerMocks.loadConfig).toHaveBeenCalledWith('./mcp_server.json');
      expect(exitSpy).not.toHaveBeenCalled();
    });
  });

  describe('帮助与版本', () => {
    it('--help 应打印用法说明且不加载配置', async () => {
      await runCli(['--help']);

      await vi.waitFor(() => {
        expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('用法:'));
      });
      expect(consoleLogSpy).toHaveBeenCalledWith(
        expect.stringContaining('MCP Knot CLI - 聚合多个MCP服务的命令行界面'),
      );
      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('--modern-only-upstream'));
      expect(configManagerMocks.loadConfig).not.toHaveBeenCalled();
      expect(serverMocks.initialize).not.toHaveBeenCalled();
      expect(exitSpy).not.toHaveBeenCalled();
    });

    it('--version 应打印版本号', async () => {
      await runCli(['--version']);

      await vi.waitFor(() => {
        expect(consoleLogSpy).toHaveBeenCalledWith(
          expect.stringMatching(/^MCP Knot CLI v\d+\.\d+\.\d+$/),
        );
      });
    });
  });

  describe('--list-templates', () => {
    it('应列出模板类型与使用方法', async () => {
      configManagerMocks.getAvailableTemplates.mockReturnValue([
        { type: 'basic', description: '基础配置' },
        { type: 'advanced', description: '高级配置模板' },
      ]);

      await runCli(['--list-templates']);

      await vi.waitFor(() => {
        expect(consoleLogSpy).toHaveBeenCalledWith('可用的配置模板:');
      });
      // type 语句应 padEnd(12) 对齐
      expect(consoleLogSpy).toHaveBeenCalledWith('  basic        - 基础配置');
      expect(consoleLogSpy).toHaveBeenCalledWith('  advanced     - 高级配置模板');
      expect(consoleLogSpy).toHaveBeenCalledWith('  mcp-knot --generate-config --template <type>');
      expect(configManagerMocks.loadConfig).not.toHaveBeenCalled();
    });
  });

  describe('--list-presets', () => {
    it('应列出服务器预设及说明', async () => {
      generatorMocks.getAvailableServerPresets.mockReturnValue([
        { id: 'fetch', name: 'Fetch 服务器', description: '网页抓取能力' },
      ]);

      await runCli(['--list-presets']);

      await vi.waitFor(() => {
        expect(consoleLogSpy).toHaveBeenCalledWith('可用的 MCP 服务器预设:');
      });
      expect(consoleLogSpy).toHaveBeenCalledWith('  fetch                - Fetch 服务器');
      expect(consoleLogSpy).toHaveBeenCalledWith('                      网页抓取能力');
      expect(consoleLogSpy).toHaveBeenCalledWith(
        '  mcp-knot --init-all      # 初始化所有配置（包含组配置）',
      );
    });
  });

  describe('--generate-config', () => {
    it('应按模板类型输出配置模板', async () => {
      configManagerMocks.getConfigTemplateWithComments.mockReturnValue('// 模板内容');

      await runCli(['--generate-config', '--template', 'advanced']);

      await vi.waitFor(() => {
        expect(consoleLogSpy).toHaveBeenCalledWith('# MCP Knot CLI 配置文件模板 (advanced)');
      });
      expect(configManagerMocks.getConfigTemplateWithComments).toHaveBeenCalledWith('advanced');
      expect(consoleLogSpy).toHaveBeenCalledWith('# 将以下内容保存为 mcp_server.json');
      expect(consoleLogSpy).toHaveBeenCalledWith('');
      expect(consoleLogSpy).toHaveBeenCalledWith('// 模板内容');
      expect(exitSpy).not.toHaveBeenCalled();
    });
  });

  describe('--validate', () => {
    const configPath = 'cfg.json';

    it('配置有效时应输出通过结果且不退出', async () => {
      configManagerMocks.loadConfig.mockResolvedValue({
        servers: { s: { command: 'node' } },
        logging: { level: 'info' },
        transport: { type: 'stdio' },
      });
      configManagerMocks.validateConfigDetailed.mockReturnValue({
        valid: true,
        errors: [],
        warnings: [],
      });
      configManagerMocks.formatValidationResult.mockReturnValue('✅ 配置验证通过');

      await runCli(['--validate', '-c', configPath]);

      await vi.waitFor(() => {
        expect(consoleLogSpy).toHaveBeenCalledWith(`验证配置文件: ${configPath}`);
      });
      expect(consoleLogSpy).toHaveBeenCalledWith('\n✅ 配置验证通过');
      expect(configManagerMocks.loadConfig).toHaveBeenCalledWith(configPath);
      expect(exitSpy).not.toHaveBeenCalled();
      expect(serverMocks.initialize).not.toHaveBeenCalled();
    });

    it('配置无效时应以退出码 1 结束', async () => {
      configManagerMocks.loadConfig.mockResolvedValue({
        servers: { s: { command: '' } },
      });
      configManagerMocks.validateConfigDetailed.mockReturnValue({
        valid: false,
        errors: [{ path: ['servers', 's', 'command'], message: '命令为空' }],
        warnings: [],
      });
      configManagerMocks.formatValidationResult.mockReturnValue('❌ 配置验证失败');

      await runCli(['--validate', '-c', configPath]);

      await vi.waitFor(() => {
        expect(exitSpy).toHaveBeenCalledWith(1);
      });
      expect(consoleLogSpy).toHaveBeenCalledWith('\n❌ 配置验证失败');
    });

    it('加载配置失败时应输出错误与提示并以 1 退出', async () => {
      const error = new Error('配置文件不存在: cfg.json') as Error & {
        code: string;
        details?: unknown;
      };
      error.code = 'CONFIG_FILE_NOT_FOUND';
      configManagerMocks.loadConfig.mockRejectedValue(error);

      await runCli(['--validate', '-c', configPath]);

      await vi.waitFor(() => {
        expect(exitSpy).toHaveBeenCalledWith(1);
      });
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        '错误 (CONFIG_FILE_NOT_FOUND): 配置文件不存在: cfg.json',
      );
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        '\n提示: 使用 --generate-config 生成配置文件模板',
      );
    });
  });

  describe('--init / --init-all', () => {
    it('--init 应以当前目录与默认选项构造生成器', async () => {
      generatorMocks.initConfigFiles.mockResolvedValue({
        createdFiles: ['mcp_server.json'],
        skippedFiles: [],
        errors: [],
      });

      await runCli(['--init']);

      await vi.waitFor(() => {
        expect(consoleLogSpy).toHaveBeenCalledWith('✅ 已创建配置文件:');
      });
      expect(generatorMocks.constructedWith).toEqual({
        includeExamples: true,
        includeGroups: false,
        configDir: process.cwd(),
        overwrite: false,
      });
      expect(consoleLogSpy).toHaveBeenCalledWith('  - mcp_server.json');
      expect(consoleLogSpy).toHaveBeenCalledWith('\n📝 下一步:');
      expect(consoleLogSpy).toHaveBeenCalledWith('  1. 根据需要修改配置文件');
      expect(exitSpy).not.toHaveBeenCalled();
    });

    it('--init-all --overwrite 应传递组配置与覆盖标记', async () => {
      generatorMocks.initConfigFiles.mockResolvedValue({
        createdFiles: [],
        skippedFiles: [],
        errors: [],
      });

      await runCli(['--init-all', '--overwrite']);

      await vi.waitFor(() => {
        expect(generatorMocks.initConfigFiles).toHaveBeenCalledTimes(1);
      });
      expect(generatorMocks.constructedWith).toEqual({
        includeExamples: true,
        includeGroups: true,
        configDir: process.cwd(),
        overwrite: true,
      });
    });

    it('初始化出错时应列出错误并以 1 退出', async () => {
      generatorMocks.initConfigFiles.mockResolvedValue({
        createdFiles: [],
        skippedFiles: ['mcp_server.json'],
        errors: ['boom'],
      });

      await runCli(['--init']);

      await vi.waitFor(() => {
        expect(exitSpy).toHaveBeenCalledWith(1);
      });
      expect(consoleLogSpy).toHaveBeenCalledWith('⏭️  已跳过（文件已存在）:');
      expect(consoleLogSpy).toHaveBeenCalledWith('  - mcp_server.json');
      expect(consoleLogSpy).toHaveBeenCalledWith('❌ 错误:');
      expect(consoleLogSpy).toHaveBeenCalledWith('  - boom');
      // 无创建文件时不应输出“下一步”指引
      expect(consoleLogSpy).not.toHaveBeenCalledWith('\n📝 下一步:');
    });
  });

  describe('服务器启动路径', () => {
    let onSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      onSpy = vi.spyOn(process, 'on').mockImplementation((() => process) as never);
      configManagerMocks.loadConfig.mockResolvedValue({
        servers: { s: { command: 'node' } },
        logging: { level: 'info' },
        transport: { type: 'stdio' },
      });
      serverMocks.initialize.mockResolvedValue(undefined);
      serverMocks.start.mockResolvedValue(undefined);
      serverMocks.shutdown.mockResolvedValue(undefined);
    });

    async function runServerCli(args: string[] = []): Promise<void> {
      await runCli(args);
      await vi.waitFor(() => {
        expect(consoleLogSpy).toHaveBeenCalledWith('等待MCP客户端连接...');
      });
    }

    it('默认应加载配置并初始化服务器', async () => {
      await runServerCli(['-c', 'my.json']);

      expect(consoleLogSpy).toHaveBeenCalledWith('启动MCP Knot CLI服务器...');
      expect(consoleLogSpy).toHaveBeenCalledWith('配置文件: my.json');
      expect(configManagerMocks.loadConfig).toHaveBeenCalledWith('my.json');
      expect(serverMocks.initialize).toHaveBeenCalledTimes(1);
      expect(serverMocks.start).toHaveBeenCalledTimes(1);
      expect(consoleLogSpy).toHaveBeenCalledWith('MCP Knot CLI服务器启动成功');
    });

    it('兼容层选项默认为入站开启、上游不限现代协议', async () => {
      await runServerCli();

      expect(compatParse).toHaveBeenCalledWith({
        inbound: { enabled: true },
        outbound: { modernOnly: false },
      });
    });

    it('--no-legacy-inbound / --modern-only-upstream 应映射到兼容层选项', async () => {
      await runServerCli(['--no-legacy-inbound', '--modern-only-upstream']);

      expect(compatParse).toHaveBeenCalledWith({
        inbound: { enabled: false },
        outbound: { modernOnly: true },
      });
    });

    it('verbose 下配置日志级别为 info 时应提升为 debug', async () => {
      const config = {
        servers: { s: { command: 'node' } },
        logging: { level: 'info' },
        transport: { type: 'stdio' },
      };
      configManagerMocks.loadConfig.mockResolvedValue(config);

      await runServerCli(['-v']);

      expect(config.logging.level).toBe('debug');
    });

    it('verbose 下配置日志级别非 info 时保持原级别', async () => {
      const config = {
        servers: { s: { command: 'node' } },
        logging: { level: 'warn' },
        transport: { type: 'stdio' },
      };
      configManagerMocks.loadConfig.mockResolvedValue(config);

      await runServerCli(['-v']);

      expect(config.logging.level).toBe('warn');
    });

    it('非 verbose 下配置日志级别保持不变', async () => {
      const config = {
        servers: { s: { command: 'node' } },
        logging: { level: 'info' },
        transport: { type: 'stdio' },
      };
      configManagerMocks.loadConfig.mockResolvedValue(config);

      await runServerCli();

      expect(config.logging.level).toBe('info');
    });

    it('应注册 SIGINT/SIGTERM/未捕获异常/未处理拒绝处理器', async () => {
      await runServerCli();

      const registeredEvents = onSpy.mock.calls.map(([event]) => event);
      expect(registeredEvents).toContain('SIGINT');
      expect(registeredEvents).toContain('SIGTERM');
      expect(registeredEvents).toContain('uncaughtException');
      expect(registeredEvents).toContain('unhandledRejection');
    });

    it('SIGINT 处理器应优雅关闭并以 0 退出', async () => {
      await runServerCli();

      const sigintHandler = onSpy.mock.calls.find(
        ([event]) => event === 'SIGINT',
      )?.[1] as () => Promise<void>;
      await sigintHandler();

      expect(consoleLogSpy).toHaveBeenCalledWith(
        '\n收到 SIGINT 信号，正在关闭MCP Knot CLI服务器...',
      );
      expect(serverMocks.shutdown).toHaveBeenCalledTimes(1);
      expect(consoleLogSpy).toHaveBeenCalledWith('MCP Knot CLI服务器已安全关闭');
      expect(exitSpy).toHaveBeenCalledWith(0);
    });

    it('关闭失败时 SIGTERM 处理器应以 1 退出', async () => {
      serverMocks.shutdown.mockRejectedValue(new Error('关闭失败'));

      await runServerCli();
      const sigtermHandler = onSpy.mock.calls.find(
        ([event]) => event === 'SIGTERM',
      )?.[1] as () => Promise<void>;
      await sigtermHandler();

      expect(consoleErrorSpy).toHaveBeenCalledWith('关闭服务器时出错:', expect.any(Error));
      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it('uncaughtException 处理器应打印异常并关闭', async () => {
      await runServerCli();

      const handler = onSpy.mock.calls.find(([event]) => event === 'uncaughtException')?.[1] as (
        error: Error,
      ) => void;
      const error = new Error('意外错误');
      handler(error);

      expect(consoleErrorSpy).toHaveBeenCalledWith('未捕获的异常:', error);
      await vi.waitFor(() => {
        expect(serverMocks.shutdown).toHaveBeenCalledTimes(1);
      });
    });

    it('unhandledRejection 处理器应打印原因与 promise', async () => {
      await runServerCli();

      const handler = onSpy.mock.calls.find(([event]) => event === 'unhandledRejection')?.[1] as (
        reason: unknown,
        promise: unknown,
      ) => void;
      const reason = new Error('拒绝原因');
      const promise = Promise.resolve();
      handler(reason, promise);

      expect(consoleErrorSpy).toHaveBeenCalledWith('未处理的Promise拒绝:', reason, 'at:', promise);
      await vi.waitFor(() => {
        expect(serverMocks.shutdown).toHaveBeenCalledTimes(1);
      });
    });
  });

  describe('setupLogging', () => {
    it('verbose 模式下 console.debug 应转发为 [DEBUG] 日志', async () => {
      configManagerMocks.loadConfig.mockResolvedValue({
        servers: { s: { command: 'node' } },
        logging: { level: 'info' },
        transport: { type: 'stdio' },
      });
      serverMocks.initialize.mockResolvedValue(undefined);
      serverMocks.start.mockResolvedValue(undefined);
      vi.spyOn(process, 'on').mockImplementation((() => process) as never);

      await runCli(['-v']);
      await vi.waitFor(() => {
        expect(consoleLogSpy).toHaveBeenCalledWith('等待MCP客户端连接...');
      });

      console.debug('调试消息');
      expect(consoleLogSpy).toHaveBeenCalledWith('[DEBUG]', '调试消息');
    });

    it('非 verbose 模式下 console.debug 应被静默', async () => {
      configManagerMocks.loadConfig.mockResolvedValue({
        servers: { s: { command: 'node' } },
        logging: { level: 'info' },
        transport: { type: 'stdio' },
      });
      serverMocks.initialize.mockResolvedValue(undefined);
      serverMocks.start.mockResolvedValue(undefined);
      vi.spyOn(process, 'on').mockImplementation((() => process) as never);

      await runCli([]);
      await vi.waitFor(() => {
        expect(consoleLogSpy).toHaveBeenCalledWith('等待MCP客户端连接...');
      });

      console.debug('不应出现');
      const forwarded = consoleLogSpy.mock.calls.filter((call) => call[0] === '[DEBUG]');
      expect(forwarded).toHaveLength(0);
    });
  });

  describe('handleCliError 错误形态', () => {
    it('带 code 的配置错误应打印错误码与详细信息提示', async () => {
      const error = new Error('配置文件JSON格式无效') as Error & {
        code: string;
        details?: unknown;
      };
      error.code = 'INVALID_CONFIG_FORMAT';
      error.details = { configPath: 'cfg.json' };
      configManagerMocks.loadConfig.mockRejectedValue(error);

      await runCli([]);

      await vi.waitFor(() => {
        expect(exitSpy).toHaveBeenCalledWith(1);
      });
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        '错误 (INVALID_CONFIG_FORMAT): 配置文件JSON格式无效',
      );
      expect(consoleErrorSpy).toHaveBeenCalledWith('详细信息:', { configPath: 'cfg.json' });
      expect(consoleErrorSpy).toHaveBeenCalledWith('\n提示: 检查配置文件的JSON格式是否正确');
    });

    it('普通 Error 应打印错误消息', async () => {
      configManagerMocks.loadConfig.mockRejectedValue(new Error('boom'));

      await runCli([]);

      await vi.waitFor(() => {
        expect(consoleErrorSpy).toHaveBeenCalledWith('错误:', 'boom');
      });
      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it('非 Error 抛出物应打印未知错误', async () => {
      configManagerMocks.loadConfig.mockRejectedValue('字符串错误');

      await runCli([]);

      await vi.waitFor(() => {
        expect(consoleErrorSpy).toHaveBeenCalledWith('未知错误:', '字符串错误');
      });
      expect(exitSpy).toHaveBeenCalledWith(1);
    });
  });
});
