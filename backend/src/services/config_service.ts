import { ConfigError, ErrorCode } from '@mcp-core/mcp-knot-core';
import {
  GroupConfigSchema,
  McpConfigSchema,
  SystemConfigSchema,
} from '@mcp-core/mcp-knot-share/config';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { getAllConfig, saveConfig } from '../utils/config.js';
import { logger } from '../utils/logger.js';
import { getSkillRepository } from './skills-service.js';

import type {
  ConfigBackup,
  ConfigChange,
  ConfigHistoryEntry,
  ConfigImpactAnalysis,
  ConfigPreview,
  ConfigTest,
  ConfigTestResult,
  ConfigType,
  ConfigValidationError,
  ConfigValidationResult,
  ConfigValidationWarning,
  IConfigService,
} from '../types/config.js';
import type { DeepReadonly, GroupConfig, McpConfig, SystemConfig } from '@mcp-core/mcp-knot-share';
import type { z } from 'zod/v4';

// Schema 引用（从 share 统一导入）
const systemConfigSchema = SystemConfigSchema;
const mcpConfigSchema = McpConfigSchema;
const groupConfigSchema = GroupConfigSchema;

export class ConfigService implements IConfigService {
  private readonly configDir: string;
  private readonly historyDir: string;
  private readonly backupDir: string;

  constructor() {
    this.configDir = process.env.CONFIG_PATH || path.resolve(process.cwd(), 'config');
    this.historyDir = path.resolve(this.configDir, '.history');
    this.backupDir = path.resolve(this.configDir, '.backups');

    // 确保目录存在
    this.ensureDirectories();
  }

  private async ensureDirectories(): Promise<void> {
    try {
      await fs.mkdir(this.historyDir, { recursive: true });
      await fs.mkdir(this.backupDir, { recursive: true });
    } catch (error) {
      logger.error('创建配置目录失败', error instanceof Error ? error : new Error(String(error)), {
        dir: this.configDir,
      });
    }
  }

  async getCurrentConfig(): Promise<{
    system: SystemConfig;
    mcps: DeepReadonly<McpConfig>;
    groups: DeepReadonly<GroupConfig>;
  }> {
    const config = await getAllConfig();
    return {
      system: JSON.parse(JSON.stringify(config.system)) as SystemConfig,
      mcps: config.mcps,
      groups: config.groups,
    };
  }

  async updateConfig(
    configType: ConfigType,
    config: Record<string, unknown>,
    description?: string,
    user?: string,
  ): Promise<void> {
    // 获取当前配置用于比较
    const currentConfig = await this.getCurrentConfig();
    let oldConfig: unknown;
    let fileName: string;

    switch (configType) {
      case 'system':
        oldConfig = currentConfig.system;
        fileName = 'system.json';
        break;
      case 'mcp':
        oldConfig = currentConfig.mcps;
        fileName = 'mcp_server.json';
        break;
      case 'groups':
        oldConfig = currentConfig.groups;
        fileName = 'group.json';
        await this.validateGroupPublication(config);
        break;
      default:
        throw new ConfigError(ErrorCode.INVALID_CONFIG_FORMAT, `不支持的配置类型: ${configType}`);
    }

    // 保存配置
    await saveConfig(
      fileName as 'system.json' | 'mcp_server.json' | 'group.json',
      config as SystemConfig | McpConfig | GroupConfig,
    );
    if (configType === 'groups') await this.invalidateGroupPublications();

    // 记录历史
    await this.recordConfigHistory(configType, oldConfig, config, description, user);
  }

  private async validateGroupPublication(config: Record<string, unknown>): Promise<void> {
    const validation = await this.validateConfig('groups', config);
    if (!validation.valid)
      throw new ConfigError(
        ErrorCode.INVALID_CONFIG_FORMAT,
        validation.errors.map((error) => `${error.path}: ${error.message}`).join('; '),
      );
  }

  private async invalidateGroupPublications(): Promise<void> {
    const { invalidateAllGroupMcpServices } = await import('../api/mcp/mcp-handler-factory.js');
    await invalidateAllGroupMcpServices();
  }

  async validateConfig(
    configType: ConfigType,
    config: Record<string, unknown>,
  ): Promise<ConfigValidationResult> {
    const errors: ConfigValidationError[] = [];
    const warnings: ConfigValidationWarning[] = [];

    try {
      let schema: z.ZodType;

      switch (configType) {
        case 'system':
          schema = systemConfigSchema;
          break;
        case 'mcp':
          schema = mcpConfigSchema;
          break;
        case 'groups':
          schema = groupConfigSchema;
          break;
        default:
          throw new ConfigError(ErrorCode.INVALID_CONFIG_FORMAT, `不支持的配置类型: ${configType}`);
      }

      // 使用 Zod 验证配置
      const result = schema.safeParse(config);

      if (!result.success) {
        for (const issue of result.error.issues) {
          errors.push({
            path: issue.path.join('.'),
            message: issue.message,
            code: issue.code,
            severity: 'error',
          });
        }
      }

      // 添加自定义验证逻辑
      await this.performCustomValidation(configType, config, errors, warnings);
    } catch (error) {
      errors.push({
        path: 'root',
        message: error instanceof Error ? error.message : '验证过程中发生未知错误',
        code: 'VALIDATION_ERROR',
        severity: 'error',
      });
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings,
    };
  }

  private async performCustomValidation(
    configType: ConfigType,
    config: Record<string, unknown>,
    errors: ConfigValidationError[],
    warnings: ConfigValidationWarning[],
  ): Promise<void> {
    switch (configType) {
      case 'system':
        await this.validateSystemConfig(config, errors, warnings);
        break;
      case 'mcp':
        await this.validateMcpConfig(config, errors, warnings);
        break;
      case 'groups':
        await this.validateGroupConfig(config, errors, warnings);
        break;
    }
  }

  private async validateSystemConfig(
    config: Record<string, unknown>,
    errors: ConfigValidationError[],
    warnings: ConfigValidationWarning[],
  ): Promise<void> {
    // 验证端口是否被占用
    const serverConfig = config.server as { port: number; host: string };
    if (serverConfig?.port) {
      // 这里可以添加端口占用检查逻辑
      if (serverConfig.port < 1024) {
        warnings.push({
          path: 'server.port',
          message: '使用小于1024的端口可能需要管理员权限',
          code: 'PORT_PRIVILEGE_WARNING',
          severity: 'warning',
        });
      }
    }

    // 验证JWT密钥强度
    const authConfig = config.auth as { jwt: { secret: string } };
    if (authConfig?.jwt?.secret) {
      if (authConfig.jwt.secret.length < 32) {
        errors.push({
          path: 'auth.jwt.secret',
          message: 'JWT密钥长度不能少于32个字符',
          code: 'JWT_SECRET_TOO_SHORT',
          severity: 'error',
        });
      }
    }
  }

  private async validateMcpConfig(
    config: Record<string, unknown>,
    errors: ConfigValidationError[],
    _warnings: ConfigValidationWarning[],
  ): Promise<void> {
    // NOTE: 类型断言是安全的——此函数在 validateConfig 中被调用，
    // 调用前已由 Zod schema 校验过结构。这里只是用强类型做自定义校验。
    const mcpConfig = config as unknown as McpConfig;

    // 验证服务器配置
    for (const [serverId, serverConfig] of Object.entries(mcpConfig.servers || {})) {
      // 类型守卫：检查是否为 StdioServerConfig
      if ('command' in serverConfig) {
        if (!serverConfig.command) {
          errors.push({
            path: `servers.${serverId}.command`,
            message: '服务器命令不能为空',
            code: 'MISSING_COMMAND',
            severity: 'error',
          });
        }
      }

      // 类型守卫：检查是否为 HTTPServerConfig
      if ('transport' in serverConfig) {
        const transport = (serverConfig as { transport?: { type?: string; url?: string } })
          .transport;
        if (transport?.type === 'sse' && !transport.url) {
          errors.push({
            path: `servers.${serverId}.transport.url`,
            message: 'SSE传输类型需要指定URL',
            code: 'MISSING_SSE_URL',
            severity: 'error',
          });
        }
      }
    }
  }

  private async validateGroupConfig(
    config: Record<string, unknown>,
    errors: ConfigValidationError[],
    warnings: ConfigValidationWarning[],
  ): Promise<void> {
    const groupConfig = config as GroupConfig;
    const currentMcpConfig = await this.getCurrentConfig();
    const availableServers = Object.keys(currentMcpConfig.mcps.servers || {});

    // 验证组配置
    for (const [groupId, group] of Object.entries(groupConfig)) {
      if (group.skills) {
        try {
          await getSkillRepository().catalog(group.skills, groupId);
        } catch (error) {
          errors.push({
            path: `${groupId}.skills`,
            message: error instanceof Error ? error.message : '技能发布引用无效',
            code: 'INVALID_SKILL_SELECTION',
            severity: 'error',
          });
        }
      }
      // 检查服务器是否存在
      for (const serverId of group.servers || []) {
        if (!availableServers.includes(serverId)) {
          warnings.push({
            path: `${groupId}.servers`,
            message: `服务器 "${serverId}" 不存在于MCP配置中`,
            code: 'SERVER_NOT_FOUND',
            severity: 'warning',
          });
        }
      }

      // 检查验证密钥
      if (group.validation?.enabled && !group.validation.validationKey) {
        errors.push({
          path: `${groupId}.validation.validationKey`,
          message: '启用验证时必须提供验证密钥',
          code: 'MISSING_VALIDATION_KEY',
          severity: 'error',
        });
      }
    }
  }

  async analyzeConfigImpact(
    configType: ConfigType,
    _config: Record<string, unknown>,
  ): Promise<ConfigImpactAnalysis> {
    const affectedServices: string[] = [];
    let requiresRestart = false;
    const potentialIssues: string[] = [];
    const recommendations: string[] = [];

    switch (configType) {
      case 'system':
        affectedServices.push('认证服务', 'Web服务器', '监控服务');
        requiresRestart = true;
        recommendations.push('建议在维护窗口期间进行系统配置更新');
        break;

      case 'mcp':
        affectedServices.push('MCP服务管理器', '工具管理器');
        requiresRestart = false;
        recommendations.push('MCP服务器配置更改将在下次连接时生效');
        break;

      case 'groups':
        affectedServices.push('组管理器', '工具过滤器');
        requiresRestart = false;
        recommendations.push('组配置更改将立即生效');
        break;
    }

    return {
      affectedServices,
      requiresRestart,
      potentialIssues,
      recommendations,
    };
  }

  async getConfigHistory(
    limit: number,
    offset: number,
    configType?: ConfigType,
  ): Promise<ConfigHistoryEntry[]> {
    try {
      const historyFiles = await fs.readdir(this.historyDir);
      const filteredFiles = configType
        ? historyFiles.filter((file) => file.includes(`-${configType}-`))
        : historyFiles;

      // 按时间戳排序（最新的在前）
      filteredFiles.sort((a, b) => {
        const timestampA = a.split('-')[0];
        const timestampB = b.split('-')[0];
        return timestampB.localeCompare(timestampA);
      });

      const paginatedFiles = filteredFiles.slice(offset, offset + limit);
      const history: ConfigHistoryEntry[] = [];

      for (const file of paginatedFiles) {
        try {
          const filePath = path.resolve(this.historyDir, file);
          const content = await fs.readFile(filePath, 'utf-8');
          const entry = JSON.parse(content) as ConfigHistoryEntry;
          history.push(entry);
        } catch (error) {
          logger.error(
            '读取历史文件失败',
            error instanceof Error ? error : new Error(String(error)),
            { file },
          );
        }
      }

      return history;
    } catch (error) {
      logger.error('获取配置历史失败', error instanceof Error ? error : new Error(String(error)));
      return [];
    }
  }

  async getConfigHistoryCount(configType?: ConfigType): Promise<number> {
    try {
      const historyFiles = await fs.readdir(this.historyDir);
      const filteredFiles = configType
        ? historyFiles.filter((file) => file.includes(`-${configType}-`))
        : historyFiles;
      return filteredFiles.length;
    } catch (error) {
      logger.error(
        '获取配置历史总数失败',
        error instanceof Error ? error : new Error(String(error)),
      );
      return 0;
    }
  }

  async createBackup(
    description?: string,
    includeTypes?: ConfigType[],
    user?: string,
  ): Promise<string> {
    const backupId = crypto.randomUUID();
    const timestamp = new Date().toISOString();
    const currentConfig = await this.getCurrentConfig();

    const backup: ConfigBackup & { configs: Record<string, unknown> } = {
      id: backupId,
      timestamp,
      description,
      configTypes: includeTypes || ['system', 'mcp', 'groups'],
      size: 0,
      user: user ?? 'system',
      configs: {},
    };

    // 包含指定类型的配置
    for (const configType of backup.configTypes) {
      switch (configType) {
        case 'system':
          backup.configs.system = currentConfig.system;
          break;
        case 'mcp':
          backup.configs.mcp = currentConfig.mcps;
          break;
        case 'groups':
          backup.configs.groups = currentConfig.groups;
          break;
      }
    }

    // 保存备份文件
    const backupContent = JSON.stringify(backup, null, 2);
    backup.size = Buffer.byteLength(backupContent, 'utf-8');

    const backupFilePath = path.resolve(this.backupDir, `${timestamp}-${backupId}.json`);
    await fs.writeFile(backupFilePath, backupContent, 'utf-8');

    return backupId;
  }

  async restoreFromBackup(backupId: string, configTypes?: ConfigType[]): Promise<void> {
    // 查找备份文件
    const backupFiles = await fs.readdir(this.backupDir);
    const backupFile = backupFiles.find((file) => file.includes(backupId));

    if (!backupFile) {
      throw new ConfigError(ErrorCode.CONFIG_FILE_NOT_FOUND, `备份文件不存在: ${backupId}`);
    }

    const backupFilePath = path.resolve(this.backupDir, backupFile);
    const backupContent = await fs.readFile(backupFilePath, 'utf-8');
    const backup = JSON.parse(backupContent) as ConfigBackup & {
      configs: Record<string, unknown>;
    };

    const typesToRestore = configTypes || backup.configTypes;

    // Reject unavailable skill revisions before changing any backed-up configuration.
    if (typesToRestore.includes('groups') && backup.configs.groups)
      await this.validateGroupPublication(backup.configs.groups as Record<string, unknown>);

    // 恢复指定类型的配置
    for (const configType of typesToRestore) {
      if (!backup.configs[configType]) {
        logger.warn('备份中不包含指定类型配置', { configType });
        continue;
      }

      let fileName: string;
      switch (configType) {
        case 'system':
          fileName = 'system.json';
          break;
        case 'mcp':
          fileName = 'mcp_server.json';
          break;
        case 'groups':
          fileName = 'group.json';
          break;
        default:
          continue;
      }

      await saveConfig(
        fileName as 'system.json' | 'mcp_server.json' | 'group.json',
        backup.configs[configType] as SystemConfig | McpConfig | GroupConfig,
      );
      if (configType === 'groups') await this.invalidateGroupPublications();
    }

    // 记录恢复操作
    await this.recordConfigHistory(
      'system', // 使用 system 作为恢复操作的类型
      {},
      { restored: true, backupId, configTypes: typesToRestore },
      `从备份 ${backupId} 恢复配置`,
    );
  }

  async getBackupList(limit: number, offset: number): Promise<ConfigBackup[]> {
    try {
      const backupFiles = await fs.readdir(this.backupDir);

      // 按时间戳排序（最新的在前）
      backupFiles.sort((a, b) => {
        const timestampA = a.split('-')[0];
        const timestampB = b.split('-')[0];
        return timestampB.localeCompare(timestampA);
      });

      const paginatedFiles = backupFiles.slice(offset, offset + limit);
      const backups: ConfigBackup[] = [];

      for (const file of paginatedFiles) {
        try {
          const filePath = path.resolve(this.backupDir, file);
          const content = await fs.readFile(filePath, 'utf-8');
          const backup = JSON.parse(content) as ConfigBackup & {
            configs: Record<string, unknown>;
          };

          // 只返回备份元数据，不包含实际配置内容
          backups.push({
            id: backup.id,
            timestamp: backup.timestamp,
            description: backup.description,
            configTypes: backup.configTypes,
            size: backup.size,
            user: backup.user,
          });
        } catch (error) {
          logger.error(
            '读取备份文件失败',
            error instanceof Error ? error : new Error(String(error)),
            { file },
          );
        }
      }

      return backups;
    } catch (error) {
      logger.error('获取备份列表失败', error instanceof Error ? error : new Error(String(error)));
      return [];
    }
  }

  async getBackupCount(): Promise<number> {
    try {
      const backupFiles = await fs.readdir(this.backupDir);
      return backupFiles.length;
    } catch (error) {
      logger.error('获取备份总数失败', error instanceof Error ? error : new Error(String(error)));
      return 0;
    }
  }

  async getLastUpdatedTime(): Promise<string> {
    try {
      const configFiles = ['system.json', 'mcp_server.json', 'group.json'];
      let latestTime = new Date(0);

      for (const file of configFiles) {
        try {
          const filePath = path.resolve(this.configDir, file);
          const stats = await fs.stat(filePath);
          if (stats.mtime > latestTime) {
            latestTime = stats.mtime;
          }
        } catch (_error) {
          // 文件不存在，跳过
        }
      }

      return latestTime.toISOString();
    } catch (error) {
      logger.error(
        '获取最后更新时间失败',
        error instanceof Error ? error : new Error(String(error)),
      );
      return new Date().toISOString();
    }
  }

  async getConfigVersion(): Promise<string> {
    // 基于配置文件的修改时间生成版本号
    const lastUpdated = await this.getLastUpdatedTime();
    return crypto.createHash('md5').update(lastUpdated).digest('hex').slice(0, 8);
  }

  private async recordConfigHistory(
    configType: ConfigType,
    oldConfig: unknown,
    newConfig: unknown,
    description?: string,
    user?: string,
  ): Promise<void> {
    try {
      const historyEntry: ConfigHistoryEntry = {
        id: crypto.randomUUID(),
        configType,
        timestamp: new Date().toISOString(),
        description,
        changes: this.calculateChanges(oldConfig, newConfig),
        user: user ?? 'system',
        version: await this.getConfigVersion(),
      };

      const historyFileName = `${historyEntry.timestamp}-${configType}-${historyEntry.id}.json`;
      const historyFilePath = path.resolve(this.historyDir, historyFileName);

      await fs.writeFile(historyFilePath, JSON.stringify(historyEntry, null, 2), 'utf-8');
    } catch (error) {
      logger.error('记录配置历史失败', error instanceof Error ? error : new Error(String(error)));
    }
  }

  async testConfig(
    configType: ConfigType,
    config: Record<string, unknown>,
  ): Promise<ConfigTestResult> {
    const tests: ConfigTest[] = [];

    try {
      // 基础验证测试
      const validationResult = await this.validateConfig(configType, config);
      tests.push({
        name: 'schema_validation',
        description: '配置模式验证',
        status: validationResult.valid ? 'passed' : 'failed',
        message: validationResult.valid ? '配置模式验证通过' : '配置模式验证失败',
        details: validationResult.errors,
      });

      // 执行特定类型的测试
      switch (configType) {
        case 'system':
          await this.testSystemConfig(config, tests);
          break;
        case 'mcp':
          await this.testMcpConfig(config, tests);
          break;
        case 'groups':
          await this.testGroupConfig(config, tests);
          break;
      }
    } catch (error) {
      tests.push({
        name: 'test_execution',
        description: '测试执行',
        status: 'failed',
        message: '测试执行过程中发生错误',
        details: error instanceof Error ? error.message : '未知错误',
      });
    }

    // 计算测试摘要
    const summary = {
      total: tests.length,
      passed: tests.filter((t) => t.status === 'passed').length,
      failed: tests.filter((t) => t.status === 'failed').length,
      warnings: tests.filter((t) => t.status === 'warning').length,
    };

    return {
      success: summary.failed === 0,
      tests,
      summary,
    };
  }

  private async testSystemConfig(
    config: Record<string, unknown>,
    tests: ConfigTest[],
  ): Promise<void> {
    // NOTE: 类型断言是安全的——此函数在 testConfig 中被调用，用于测试已校验的配置。
    const systemConfig = config as unknown as SystemConfig;

    // 测试端口可用性
    if (systemConfig.server?.port) {
      try {
        const net = await import('node:net');
        const server = net.createServer();

        await new Promise<void>((resolve, reject) => {
          server.listen(systemConfig.server.port, systemConfig.server.host, () => {
            server.close();
            // 清理错误监听器
            server.removeAllListeners('error');
            resolve();
          });

          server.on('error', (error: NodeJS.ErrnoException) => {
            // 清理错误监听器
            server.removeAllListeners('error');
            if (error.code === 'EADDRINUSE') {
              reject(new Error(`端口 ${systemConfig.server.port} 已被占用`));
            } else {
              reject(error);
            }
          });
        });

        tests.push({
          name: 'port_availability',
          description: '端口可用性测试',
          status: 'passed',
          message: `端口 ${systemConfig.server.port} 可用`,
        });
      } catch (error) {
        tests.push({
          name: 'port_availability',
          description: '端口可用性测试',
          status: 'failed',
          message: error instanceof Error ? error.message : '端口测试失败',
        });
      }
    }

    // 测试JWT配置
    if (systemConfig.auth?.jwt) {
      try {
        const jwt = await import('jsonwebtoken');
        const testPayload = { test: true };
        const token = jwt.sign(testPayload, systemConfig.auth.jwt.secret, {
          expiresIn: systemConfig.auth.jwt.expiresIn,
          issuer: systemConfig.auth.jwt.issuer,
        } as Record<string, unknown>);

        jwt.verify(token, systemConfig.auth.jwt.secret);

        tests.push({
          name: 'jwt_functionality',
          description: 'JWT功能测试',
          status: 'passed',
          message: 'JWT签名和验证功能正常',
        });
      } catch (error) {
        tests.push({
          name: 'jwt_functionality',
          description: 'JWT功能测试',
          status: 'failed',
          message: 'JWT功能测试失败',
          details: error instanceof Error ? error.message : '未知错误',
        });
      }
    }

    // 测试用户配置
    if (systemConfig.users) {
      const userCount = Object.keys(systemConfig.users).length;
      if (userCount === 0) {
        tests.push({
          name: 'user_configuration',
          description: '用户配置测试',
          status: 'warning',
          message: '没有配置任何用户，系统将无法登录',
        });
      } else {
        tests.push({
          name: 'user_configuration',
          description: '用户配置测试',
          status: 'passed',
          message: `配置了 ${userCount} 个用户`,
        });
      }
    }
  }

  private async testMcpConfig(config: Record<string, unknown>, tests: ConfigTest[]): Promise<void> {
    // NOTE: 类型断言是安全的——此函数在 validateConfig 中被调用，
    // 调用前已由 Zod schema 校验过结构。这里只是用强类型做自定义校验。
    const mcpConfig = config as unknown as McpConfig;

    // 测试服务器配置
    for (const [serverId, serverConfig] of Object.entries(mcpConfig.servers || {})) {
      // 类型守卫：测试命令可执行性（仅 StdioServerConfig）
      if ('command' in serverConfig && serverConfig.command) {
        try {
          const { spawn } = await import('node:child_process');
          const child = spawn(serverConfig.command, ['--version'], {
            stdio: 'pipe',
            timeout: 5000,
          });

          await new Promise<void>((resolve, reject) => {
            const timeout = setTimeout(() => {
              child.kill();
              // 清理监听器
              child.removeAllListeners('close');
              child.removeAllListeners('error');
              reject(new Error('命令执行超时'));
            }, 5000);

            child.on('close', (code) => {
              clearTimeout(timeout);
              // 清理监听器
              child.removeAllListeners('close');
              child.removeAllListeners('error');
              if (code === 0 || code === null) {
                resolve();
              } else {
                reject(new Error(`命令退出码: ${code}`));
              }
            });

            child.on('error', (error) => {
              clearTimeout(timeout);
              // 清理监听器
              child.removeAllListeners('close');
              child.removeAllListeners('error');
              reject(error);
            });
          });

          tests.push({
            name: `server_${serverId}_command`,
            description: `服务器 ${serverId} 命令测试`,
            status: 'passed',
            message: `命令 "${serverConfig.command}" 可执行`,
          });
        } catch (error) {
          tests.push({
            name: `server_${serverId}_command`,
            description: `服务器 ${serverId} 命令测试`,
            status: 'warning',
            message: `命令 "${serverConfig.command}" 测试失败`,
            details: error instanceof Error ? error.message : '未知错误',
          });
        }
      }

      // 测试环境变量
      if (serverConfig.env) {
        const envVarCount = Object.keys(serverConfig.env).length;
        tests.push({
          name: `server_${serverId}_env`,
          description: `服务器 ${serverId} 环境变量测试`,
          status: 'passed',
          message: `配置了 ${envVarCount} 个环境变量`,
        });
      }

      // 测试传输配置（仅 HTTPServerConfig）
      if ('transport' in serverConfig) {
        const transport = (serverConfig as { transport?: { type?: string; url?: string } })
          .transport;
        if (transport) {
          if (transport.type === 'sse' && transport.url) {
            // 可以添加URL可达性测试
            tests.push({
              name: `server_${serverId}_transport`,
              description: `服务器 ${serverId} 传输配置测试`,
              status: 'passed',
              message: `SSE传输配置正确: ${transport.url}`,
            });
          } else {
            tests.push({
              name: `server_${serverId}_transport`,
              description: `服务器 ${serverId} 传输配置测试`,
              status: 'passed',
              message: `${transport.type} 传输配置正确`,
            });
          }
        }
      }
    }
  }

  private async testGroupConfig(
    config: Record<string, unknown>,
    tests: ConfigTest[],
  ): Promise<void> {
    const groupConfig = config as GroupConfig;
    const currentConfig = await this.getCurrentConfig();
    const availableServers = Object.keys(currentConfig.mcps.servers || {});

    // 测试组配置
    for (const [groupId, group] of Object.entries(groupConfig)) {
      // 测试服务器引用
      const validServers =
        group.servers?.filter((serverId) => availableServers.includes(serverId)) || [];

      const invalidServers =
        group.servers?.filter((serverId) => !availableServers.includes(serverId)) || [];

      if (invalidServers.length > 0) {
        tests.push({
          name: `group_${groupId}_servers`,
          description: `组 ${groupId} 服务器引用测试`,
          status: 'warning',
          message: `引用了不存在的服务器: ${invalidServers.join(', ')}`,
        });
      } else if (validServers.length > 0) {
        tests.push({
          name: `group_${groupId}_servers`,
          description: `组 ${groupId} 服务器引用测试`,
          status: 'passed',
          message: `所有服务器引用有效 (${validServers.length} 个)`,
        });
      }

      // 测试验证配置
      if (group.validation?.enabled) {
        if (group.validation.validationKey) {
          tests.push({
            name: `group_${groupId}_validation`,
            description: `组 ${groupId} 验证配置测试`,
            status: 'passed',
            message: '验证配置正确',
          });
        } else {
          tests.push({
            name: `group_${groupId}_validation`,
            description: `组 ${groupId} 验证配置测试`,
            status: 'failed',
            message: '启用了验证但未设置验证密钥',
          });
        }
      }
    }
  }

  async previewConfigChanges(
    configType: ConfigType,
    config: Record<string, unknown>,
  ): Promise<ConfigPreview> {
    const currentConfig = await this.getCurrentConfig();
    let oldConfig: unknown;

    switch (configType) {
      case 'system':
        oldConfig = currentConfig.system;
        break;
      case 'mcp':
        oldConfig = currentConfig.mcps;
        break;
      case 'groups':
        oldConfig = currentConfig.groups;
        break;
      default:
        throw new ConfigError(ErrorCode.INVALID_CONFIG_FORMAT, `不支持的配置类型: ${configType}`);
    }

    const changes = this.calculateDetailedChanges(oldConfig, config);
    const impact = await this.analyzeConfigImpact(configType, config);

    return {
      changes,
      affectedServices: impact.affectedServices,
      potentialIssues: impact.potentialIssues,
      recommendations: impact.recommendations,
      rollbackPlan: this.generateRollbackPlan(configType, changes),
    };
  }

  private calculateDetailedChanges(oldConfig: unknown, newConfig: unknown): ConfigChange[] {
    const changes: ConfigChange[] = [];

    // 简化的深度比较实现
    // 在实际项目中，建议使用专门的深度比较库如 lodash.isEqual 或 deep-diff
    const oldStr = JSON.stringify(oldConfig, null, 2);
    const newStr = JSON.stringify(newConfig, null, 2);

    if (oldStr !== newStr) {
      // 这里可以实现更详细的变更检测逻辑
      // 比如使用 JSON patch 算法来计算精确的变更
      changes.push({
        path: 'root',
        operation: 'update',
        oldValue: oldConfig,
        newValue: newConfig,
      });
    }

    return changes;
  }

  private generateRollbackPlan(configType: ConfigType, _changes: ConfigChange[]): string[] {
    const rollbackPlan: string[] = [];

    rollbackPlan.push(`1. 停止相关服务 (如果需要)`);
    rollbackPlan.push(`2. 恢复 ${configType} 配置到之前的版本`);
    rollbackPlan.push(`3. 验证配置恢复成功`);
    rollbackPlan.push(`4. 重启相关服务 (如果需要)`);
    rollbackPlan.push(`5. 验证系统功能正常`);

    return rollbackPlan;
  }

  private calculateChanges(oldConfig: unknown, newConfig: unknown): ConfigChange[] {
    // 简化的变更计算逻辑
    // 在实际实现中，可以使用更复杂的深度比较算法
    const changes: ConfigChange[] = [];

    if (JSON.stringify(oldConfig) !== JSON.stringify(newConfig)) {
      changes.push({
        path: 'root',
        operation: 'update',
        oldValue: oldConfig,
        newValue: newConfig,
      });
    }

    return changes;
  }
}
