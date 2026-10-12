/**
 * CLI配置验证器
 * 提供详细的配置验证和错误报告
 */

import type { CliConfig, CliError, CliErrorCode } from '../types/index.js';

/**
 * 验证结果接口
 */
export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
  warnings: ValidationWarning[];
}

/**
 * 验证错误接口
 */
export interface ValidationError {
  path: string[];
  message: string;
  code: string;
  severity: 'error' | 'warning';
}

/**
 * 验证警告接口
 */
export interface ValidationWarning {
  path: string[];
  message: string;
  suggestion?: string;
}

/**
 * 配置验证器类
 */
export class ConfigValidator {
  /**
   * 验证完整配置
   */
  validateConfig(config: unknown): ValidationResult {
    const result: ValidationResult = {
      valid: true,
      errors: [],
      warnings: [],
    };

    try {
      // 基础结构验证
      this.validateBasicStructure(config, result);

      if (result.valid && typeof config === 'object' && config !== null) {
        const typedConfig = config as CliConfig;

        // 服务器配置验证
        this.validateServers(typedConfig.servers, result);

        // 日志配置验证
        this.validateLogging(typedConfig.logging, result);

        // 传输配置验证
        this.validateTransport(typedConfig.transport, result);

        // 业务逻辑验证
        this.validateBusinessLogic(typedConfig, result);
      }
    } catch (error) {
      result.valid = false;
      result.errors.push({
        path: [],
        message: `配置验证失败: ${(error as Error).message}`,
        code: 'VALIDATION_ERROR',
        severity: 'error',
      });
    }

    return result;
  }

  /**
   * 验证基础结构
   */
  private validateBasicStructure(config: unknown, result: ValidationResult): void {
    if (config === null || config === undefined) {
      result.valid = false;
      result.errors.push({
        path: [],
        message: '配置不能为空',
        code: 'CONFIG_NULL',
        severity: 'error',
      });
      return;
    }

    if (typeof config !== 'object') {
      result.valid = false;
      result.errors.push({
        path: [],
        message: '配置必须是对象',
        code: 'CONFIG_NOT_OBJECT',
        severity: 'error',
      });
      return;
    }

    const requiredFields = ['servers'];
    for (const field of requiredFields) {
      if (!(field in config)) {
        result.valid = false;
        result.errors.push({
          path: [field],
          message: `缺少必需字段: ${field}`,
          code: 'MISSING_REQUIRED_FIELD',
          severity: 'error',
        });
      }
    }
  }

  /**
   * 验证服务器配置
   */
  private validateServers(servers: unknown, result: ValidationResult): void {
    if (!servers || typeof servers !== 'object') {
      result.valid = false;
      result.errors.push({
        path: ['servers'],
        message: 'servers 必须是对象',
        code: 'SERVERS_NOT_OBJECT',
        severity: 'error',
      });
      return;
    }

    const serverEntries = Object.entries(servers);

    if (serverEntries.length === 0) {
      result.valid = false;
      result.errors.push({
        path: ['servers'],
        message: '至少需要配置一个服务器',
        code: 'NO_SERVERS',
        severity: 'error',
      });
      return;
    }

    // 验证每个服务器配置
    for (const [serverId, serverConfig] of serverEntries) {
      this.validateServerConfig(serverId, serverConfig, result);
    }

    // 检查是否所有服务器都被禁用
    const allDisabled = serverEntries.every(
      ([, config]: [string, unknown]) =>
        config &&
        typeof config === 'object' &&
        (config as Record<string, unknown>).disabled === true,
    );

    if (allDisabled) {
      result.warnings.push({
        path: ['servers'],
        message: '所有服务器都被禁用',
        suggestion: '至少启用一个服务器以确保CLI正常工作',
      });
    }
  }

  /**
   * 验证单个服务器配置
   */
  private validateServerConfig(
    serverId: string,
    serverConfig: unknown,
    result: ValidationResult,
  ): void {
    const basePath = ['servers', serverId];

    if (!serverConfig || typeof serverConfig !== 'object') {
      result.valid = false;
      result.errors.push({
        path: basePath,
        message: '服务器配置必须是对象',
        code: 'SERVER_CONFIG_NOT_OBJECT',
        severity: 'error',
      });
      return;
    }

    const config = serverConfig as Record<string, unknown>;

    // 验证必需字段
    if (!config.command || typeof config.command !== 'string' || config.command.trim() === '') {
      result.valid = false;
      result.errors.push({
        path: [...basePath, 'command'],
        message: '服务器命令不能为空',
        code: 'EMPTY_COMMAND',
        severity: 'error',
      });
    }

    // 验证可选字段类型
    if (config.args !== undefined && !Array.isArray(config.args)) {
      result.valid = false;
      result.errors.push({
        path: [...basePath, 'args'],
        message: 'args 必须是字符串数组',
        code: 'INVALID_ARGS_TYPE',
        severity: 'error',
      });
    }

    if (config.env !== undefined && (typeof config.env !== 'object' || config.env === null)) {
      result.valid = false;
      result.errors.push({
        path: [...basePath, 'env'],
        message: 'env 必须是对象',
        code: 'INVALID_ENV_TYPE',
        severity: 'error',
      });
    }

    if (
      config.timeout !== undefined &&
      (typeof config.timeout !== 'number' || config.timeout <= 0)
    ) {
      result.valid = false;
      result.errors.push({
        path: [...basePath, 'timeout'],
        message: 'timeout 必须是正数',
        code: 'INVALID_TIMEOUT',
        severity: 'error',
      });
    }

    // 添加警告
    if (config.timeout && typeof config.timeout === 'number' && config.timeout < 5000) {
      result.warnings.push({
        path: [...basePath, 'timeout'],
        message: '超时时间可能过短',
        suggestion: '建议设置至少5秒的超时时间',
      });
    }

    if (config.timeout && typeof config.timeout === 'number' && config.timeout > 300000) {
      result.warnings.push({
        path: [...basePath, 'timeout'],
        message: '超时时间可能过长',
        suggestion: '超过5分钟的超时时间可能不合理',
      });
    }
  }

  /**
   * 验证日志配置
   */
  private validateLogging(logging: unknown, result: ValidationResult): void {
    if (!logging) {
      // 日志配置是可选的，使用默认值
      return;
    }

    if (typeof logging !== 'object' || logging === null) {
      result.valid = false;
      result.errors.push({
        path: ['logging'],
        message: 'logging 必须是对象',
        code: 'LOGGING_NOT_OBJECT',
        severity: 'error',
      });
      return;
    }

    const config = logging as Record<string, unknown>;

    // 验证日志级别
    if (config.level !== undefined) {
      const validLevels = ['debug', 'info', 'warn', 'error'];
      if (!validLevels.includes(config.level as string)) {
        result.valid = false;
        result.errors.push({
          path: ['logging', 'level'],
          message: `无效的日志级别: ${config.level}`,
          code: 'INVALID_LOG_LEVEL',
          severity: 'error',
        });
      }
    }

    // 验证日志文件路径
    if (config.file !== undefined && typeof config.file !== 'string') {
      result.valid = false;
      result.errors.push({
        path: ['logging', 'file'],
        message: '日志文件路径必须是字符串',
        code: 'INVALID_LOG_FILE_TYPE',
        severity: 'error',
      });
    }
  }

  /**
   * 验证传输配置
   */
  private validateTransport(transport: unknown, result: ValidationResult): void {
    if (!transport) {
      // 传输配置是可选的，使用默认值
      return;
    }

    if (typeof transport !== 'object' || transport === null) {
      result.valid = false;
      result.errors.push({
        path: ['transport'],
        message: 'transport 必须是对象',
        code: 'TRANSPORT_NOT_OBJECT',
        severity: 'error',
      });
      return;
    }

    const config = transport as Record<string, unknown>;

    // 验证传输类型
    if (config.type !== undefined && config.type !== 'stdio') {
      result.valid = false;
      result.errors.push({
        path: ['transport', 'type'],
        message: `不支持的传输类型: ${config.type}`,
        code: 'UNSUPPORTED_TRANSPORT_TYPE',
        severity: 'error',
      });
    }
  }

  /**
   * 验证业务逻辑
   */
  private validateBusinessLogic(config: CliConfig, result: ValidationResult): void {
    // 检查服务器ID命名规范
    for (const serverId of Object.keys(config.servers)) {
      if (!/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(serverId)) {
        result.warnings.push({
          path: ['servers', serverId],
          message: '服务器ID建议使用字母开头，只包含字母、数字、下划线和连字符',
          suggestion: '例如: my_server, api-server, fileServer1',
        });
      }
    }

    // 检查重复的命令
    const commands = new Set<string>();
    for (const [serverId, serverConfig] of Object.entries(config.servers)) {
      const commandKey =
        'command' in serverConfig
          ? `${serverConfig.command} ${(serverConfig.args || []).join(' ')}`
          : serverConfig.url;
      if (commands.has(commandKey)) {
        result.warnings.push({
          path: ['servers', serverId],
          message: '检测到重复的服务器命令',
          suggestion: '确保不同的服务器使用不同的命令或参数',
        });
      }
      commands.add(commandKey);
    }
  }

  /**
   * 创建验证错误
   */
  createValidationError(message: string, details?: unknown): CliError {
    const error = new Error(message) as CliError;
    error.code = 'INVALID_CONFIG_FORMAT' as CliErrorCode;
    error.details = details;
    return error;
  }

  /**
   * 格式化验证结果为可读字符串
   */
  formatValidationResult(result: ValidationResult): string {
    const lines: string[] = [];

    if (result.valid) {
      lines.push('✅ 配置验证通过');
    } else {
      lines.push('❌ 配置验证失败');
    }

    if (result.errors.length > 0) {
      lines.push('\n错误:');
      for (const error of result.errors) {
        const path = error.path.length > 0 ? `[${error.path.join('.')}] ` : '';
        lines.push(`  • ${path}${error.message}`);
      }
    }

    if (result.warnings.length > 0) {
      lines.push('\n警告:');
      for (const warning of result.warnings) {
        const path = warning.path.length > 0 ? `[${warning.path.join('.')}] ` : '';
        lines.push(`  • ${path}${warning.message}`);
        if (warning.suggestion) {
          lines.push(`    建议: ${warning.suggestion}`);
        }
      }
    }

    return lines.join('\n');
  }
}
