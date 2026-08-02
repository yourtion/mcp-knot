/**
 * 统一配置管理器
 * 配置的唯一读写校验入口
 */

import {
  GroupConfigSchema,
  McpConfigSchema,
  type SchemaValidationResult,
  SystemConfigSchema,
  CompatibilityOptionsSchema,
  validateCrossReferences,
  validateWithSchema,
} from '@mcp-core/mcp-knot-share/config';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type {
  CompatibilityConfig,
  GroupConfig,
  McpConfig,
  SystemConfig,
} from '@mcp-core/mcp-knot-share/config';

/**
 * 所有配置的加载结果
 */
export interface AllConfig {
  mcps: McpConfig;
  groups: GroupConfig;
  system: SystemConfig;
}

/**
 * 配置文件类型
 */
export type ConfigFileType = 'mcp_server.json' | 'group.json' | 'system.json';

/**
 * 统一配置管理器
 *
 * 所有配置的读取、写入、校验都通过此类完成。
 * Backend 和 CLI 都应使用此类，不再各自实现配置逻辑。
 */
export class ConfigManager {
  private configDir: string;

  constructor(configDir?: string) {
    this.configDir = configDir ?? process.env.CONFIG_PATH ?? path.resolve(process.cwd(), 'config');
  }

  /**
   * 读取所有配置
   */
  async loadAll(): Promise<AllConfig> {
    const [mcps, groups, system] = await Promise.all([
      this.loadMcpConfig(),
      this.loadGroupConfig(),
      this.loadSystemConfig(),
    ]);

    return { mcps, groups, system };
  }

  /**
   * 读取 MCP 配置
   */
  async loadMcpConfig(): Promise<McpConfig> {
    const filePath = path.resolve(this.configDir, 'mcp_server.json');
    return this.loadConfigFile<McpConfig>(filePath, { servers: {} });
  }

  /**
   * 读取组配置
   */
  async loadGroupConfig(): Promise<GroupConfig> {
    const filePath = path.resolve(this.configDir, 'group.json');
    return this.loadConfigFile<GroupConfig>(filePath, {} as GroupConfig);
  }

  /**
   * 读取系统配置
   */
  async loadSystemConfig(): Promise<SystemConfig> {
    const filePath = path.resolve(this.configDir, 'system.json');
    return this.loadConfigFile<SystemConfig>(filePath, {} as SystemConfig);
  }

  /**
   * 保存 MCP 配置
   */
  async saveMcpConfig(config: McpConfig): Promise<void> {
    const filePath = path.resolve(this.configDir, 'mcp_server.json');
    await this.saveConfigFile(filePath, config);
  }

  /**
   * 保存组配置
   */
  async saveGroupConfig(config: GroupConfig): Promise<void> {
    const filePath = path.resolve(this.configDir, 'group.json');
    await this.saveConfigFile(filePath, config);
  }

  /**
   * 保存系统配置
   */
  async saveSystemConfig(config: SystemConfig): Promise<void> {
    const filePath = path.resolve(this.configDir, 'system.json');
    await this.saveConfigFile(filePath, config);
  }

  /**
   * 读取并解析 P7 协议兼容层配置段。
   *
   * SystemConfigSchema 已用 `.prefault({})` 保证 compatibility 字段缺失/为空时
   * 解析为「默认全开」的 CompatibilityConfig；此处对未经 schema 解析的 system
   * （如 loadSystemConfig 返回的原始 JSON）兜底再走一遍 schema，确保字段完整。
   */
  getCompatibility(system?: SystemConfig): CompatibilityConfig {
    const compat = system?.compatibility;
    if (compat) {
      return CompatibilityOptionsSchema.parse(compat);
    }
    return CompatibilityOptionsSchema.parse({});
  }

  /**
   * 通用保存方法
   */
  async saveConfig(
    configType: ConfigFileType,
    data: McpConfig | GroupConfig | SystemConfig,
  ): Promise<void> {
    switch (configType) {
      case 'mcp_server.json':
        return this.saveMcpConfig(data as McpConfig);
      case 'group.json':
        return this.saveGroupConfig(data as GroupConfig);
      case 'system.json':
        return this.saveSystemConfig(data as SystemConfig);
      default:
        throw new Error(`不支持的配置文件类型: ${configType}`);
    }
  }

  // ========================================
  // 校验方法 (使用 share 的 Zod schemas)
  // ========================================

  /**
   * 校验 MCP 配置
   */
  validateMcpConfig(config: unknown): SchemaValidationResult<McpConfig> {
    return validateWithSchema(McpConfigSchema, config);
  }

  /**
   * 校验组配置
   */
  validateGroupConfig(config: unknown): SchemaValidationResult<GroupConfig> {
    return validateWithSchema(GroupConfigSchema, config);
  }

  /**
   * 校验系统配置
   */
  validateSystemConfig(config: unknown): SchemaValidationResult<SystemConfig> {
    return validateWithSchema(SystemConfigSchema, config);
  }

  /**
   * 校验所有配置 (schema 校验 + 交叉引用校验)
   */
  validateAll(
    mcpConfig: unknown,
    groupConfig: unknown,
    systemConfig?: unknown,
  ):
    | {
        success: true;
        data: {
          mcpConfig: McpConfig;
          groupConfig: GroupConfig;
          systemConfig?: SystemConfig;
        };
      }
    | { success: false; errors: string[] } {
    const allErrors: string[] = [];

    // Schema 校验 MCP
    const mcpResult = this.validateMcpConfig(mcpConfig);
    if (!mcpResult.success) {
      allErrors.push(...(mcpResult.errors ?? []).map((e: string) => `MCP配置错误: ${e}`));
      return { success: false, errors: allErrors };
    }

    // Schema 校验 Group
    const groupResult = this.validateGroupConfig(groupConfig);
    if (!groupResult.success) {
      allErrors.push(...(groupResult.errors ?? []).map((e: string) => `组配置错误: ${e}`));
      return { success: false, errors: allErrors };
    }

    // 交叉引用校验
    const crossRefResult = validateCrossReferences(
      mcpResult.data?.servers as Record<string, unknown>,
      groupResult.data!,
    );
    if (!crossRefResult.valid) {
      allErrors.push(...crossRefResult.errors.map((e: string) => `交叉引用错误: ${e}`));
      return { success: false, errors: allErrors };
    }

    // Schema 校验 System (可选)
    let parsedSystemConfig: SystemConfig | undefined;
    if (systemConfig) {
      const sysResult = this.validateSystemConfig(systemConfig);
      if (!sysResult.success) {
        allErrors.push(...(sysResult.errors ?? []).map((e: string) => `系统配置错误: ${e}`));
        return { success: false, errors: allErrors };
      }
      parsedSystemConfig = sysResult.data;
    }

    return {
      success: true,
      data: {
        mcpConfig: mcpResult.data!,
        groupConfig: groupResult.data!,
        systemConfig: parsedSystemConfig,
      },
    };
  }

  // ========================================
  // 私有方法
  // ========================================

  /**
   * 读取并解析 JSON 配置文件
   */
  private async loadConfigFile<T>(filePath: string, defaultValue: T): Promise<T> {
    try {
      const content = await readFile(filePath, 'utf-8');
      return JSON.parse(content) as T;
    } catch {
      // 文件不存在或解析失败，返回默认值
      return defaultValue;
    }
  }

  /**
   * 安全写入配置文件 (原子写入)
   */
  private async saveConfigFile(filePath: string, data: unknown): Promise<void> {
    const dir = path.dirname(filePath);
    await mkdir(dir, { recursive: true });

    const tempPath = `${filePath}.tmp`;
    await writeFile(tempPath, JSON.stringify(data, null, 2), 'utf-8');
    await rename(tempPath, filePath);
  }
}
