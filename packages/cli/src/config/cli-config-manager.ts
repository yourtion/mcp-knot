/**
 * CLI配置管理器
 * 负责加载、验证和管理CLI配置
 */

import { createCliLogger } from '@mcp-core/mcp-knot-share';
import { CliConfigSchema, CliServerConfigSchema } from '@mcp-core/mcp-knot-share/config';
import { access, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { z } from 'zod/v4';

import { CliErrorCode } from '../types/index.js';
import { ConfigTemplateGenerator, type ConfigTemplateType } from './config-template.js';
import { ConfigValidator, type ValidationResult } from './config-validator.js';

import type { CliConfig, CliError } from '../types/index.js';

/**
 * CLI配置管理器类
 */
export class CliConfigManager {
  private configCache = new Map<string, CliConfig>();
  private validator = new ConfigValidator();
  private templateGenerator = new ConfigTemplateGenerator();
  private logger = createCliLogger(); // 使用默认配置，会自动检测环境

  /**
   * 加载配置文件
   */
  async loadConfig(configPath: string): Promise<CliConfig> {
    this.logger.debug('加载配置文件', { context: { configPath } });

    try {
      // 解析配置文件路径
      const resolvedPath = resolve(configPath);

      // 检查缓存
      if (this.configCache.has(resolvedPath)) {
        this.logger.debug('使用缓存的配置');
        return this.configCache.get(resolvedPath)!;
      }

      // 检查文件是否存在
      await this.checkFileExists(resolvedPath);

      // 读取配置文件
      const configContent = await readFile(resolvedPath, 'utf-8');

      // 解析JSON
      let rawConfig: unknown;
      try {
        rawConfig = JSON.parse(configContent);
      } catch (parseError) {
        throw this.createConfigError(
          CliErrorCode.INVALID_CONFIG_FORMAT,
          `配置文件JSON格式无效: ${(parseError as Error).message}`,
          {
            configPath: resolvedPath,
            parseError: (parseError as Error).message,
          },
        );
      }

      // 验证配置结构
      const validatedConfig = this.validateConfigStructure(rawConfig, resolvedPath);

      // 缓存配置
      this.configCache.set(resolvedPath, validatedConfig);

      this.logger.debug('配置文件加载成功', {
        context: {
          configPath: resolvedPath,
          serverCount: Object.keys(validatedConfig.servers).length,
          loggingLevel: validatedConfig.logging.level,
        },
      });

      return validatedConfig;
    } catch (error) {
      this.logger.error('加载配置文件失败:', error as Error, {
        context: { configPath },
      });

      if (this.isConfigError(error)) {
        throw error;
      }

      throw this.createConfigError(
        CliErrorCode.CONFIG_FILE_NOT_FOUND,
        `无法加载配置文件: ${(error as Error).message}`,
        { configPath, originalError: (error as Error).message },
      );
    }
  }

  /**
   * 验证配置
   */
  validateConfig(config: CliConfig): boolean {
    try {
      CliConfigSchema.parse(config);
      return true;
    } catch (error) {
      this.logger.error('配置验证失败:', error as Error);
      return false;
    }
  }

  /**
   * 详细验证配置
   */
  validateConfigDetailed(config: unknown): ValidationResult {
    return this.validator.validateConfig(config);
  }

  /**
   * 格式化验证结果
   */
  formatValidationResult(result: ValidationResult): string {
    return this.validator.formatValidationResult(result);
  }

  /**
   * 生成默认配置
   */
  generateDefaultConfig(): CliConfig {
    return this.templateGenerator.generateBasicTemplate();
  }

  /**
   * 生成指定类型的配置模板
   */
  generateConfigTemplate(type: ConfigTemplateType): CliConfig {
    return this.templateGenerator.generateTemplate(type);
  }

  /**
   * 获取配置文件模板
   */
  getConfigTemplate(type: ConfigTemplateType = 'basic'): string {
    return this.templateGenerator.getTemplateJson(type);
  }

  /**
   * 获取带注释的配置模板
   */
  getConfigTemplateWithComments(type: ConfigTemplateType = 'basic'): string {
    return this.templateGenerator.getTemplateWithComments(type);
  }

  /**
   * 获取所有可用的模板类型
   */
  getAvailableTemplates() {
    return this.templateGenerator.getAvailableTemplates();
  }

  /**
   * 清除配置缓存
   */
  clearCache(): void {
    this.configCache.clear();
    this.logger.debug('配置缓存已清除');
  }

  /**
   * 获取缓存状态
   */
  getCacheStatus() {
    return {
      cacheSize: this.configCache.size,
      cachedPaths: Array.from(this.configCache.keys()),
    };
  }

  /**
   * 检查文件是否存在
   */
  private async checkFileExists(filePath: string): Promise<void> {
    try {
      await access(filePath);
    } catch (_error) {
      throw this.createConfigError(
        CliErrorCode.CONFIG_FILE_NOT_FOUND,
        `配置文件不存在: ${filePath}`,
        { filePath },
      );
    }
  }

  /**
   * 验证配置结构
   */
  private validateConfigStructure(rawConfig: unknown, configPath: string): CliConfig {
    try {
      return CliConfigSchema.parse(rawConfig);
    } catch (error) {
      if (error instanceof z.ZodError) {
        const errorMessages = error.issues
          .map((err) => `${err.path.join('.')}: ${err.message}`)
          .join('; ');

        throw this.createConfigError(
          CliErrorCode.INVALID_CONFIG_FORMAT,
          `配置文件格式无效: ${errorMessages}`,
          {
            configPath,
            validationErrors: error.issues,
            errorMessages,
          },
        );
      }

      throw error;
    }
  }

  /**
   * 创建配置错误
   */
  private createConfigError(code: CliErrorCode, message: string, details?: unknown): CliError {
    const error = new Error(message) as CliError;
    error.code = code;
    error.details = details;
    return error;
  }

  /**
   * 检查是否为配置错误
   */
  private isConfigError(error: unknown): error is CliError {
    return error instanceof Error && 'code' in error;
  }

  /**
   * 验证服务器配置
   */
  validateServerConfig(serverConfig: unknown): boolean {
    try {
      CliServerConfigSchema.parse(serverConfig);
      return true;
    } catch (error) {
      this.logger.error('服务器配置验证失败:', error as Error);
      return false;
    }
  }

  /**
   * 合并配置
   */
  mergeConfigs(baseConfig: CliConfig, overrideConfig: Partial<CliConfig>): CliConfig {
    return {
      servers: { ...baseConfig.servers, ...overrideConfig.servers },
      logging: { ...baseConfig.logging, ...overrideConfig.logging },
      transport: { ...baseConfig.transport, ...overrideConfig.transport },
    };
  }
}
