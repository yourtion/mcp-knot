/**
 * SystemConfig 统一 Zod Schema
 */
import { z } from 'zod/v4';

import { CompatibilityOptionsSchema } from './compatibility.schema.js';

/**
 * 系统配置 Schema
 */
export const SystemConfigSchema = z.object({
  server: z.object({
    port: z.number().min(1).max(65535),
    host: z.string().min(1),
  }),
  auth: z.object({
    jwt: z.object({
      secret: z.string().min(32),
      expiresIn: z.string(),
      refreshExpiresIn: z.string(),
      issuer: z.string(),
    }),
    security: z.object({
      maxLoginAttempts: z.number().min(1),
      lockoutDuration: z.number().min(0),
      passwordMinLength: z.number().min(4),
      requireStrongPassword: z.boolean(),
    }),
  }),
  users: z.record(
    z.string(),
    z.object({
      id: z.string(),
      username: z.string(),
      password: z.string().min(1, { error: '密码不能为空' }),
      role: z.string(),
      groups: z.array(z.string()),
      createdAt: z.string(),
    }),
  ),
  ui: z.object({
    title: z.string(),
    theme: z.string(),
    features: z.object({
      apiToMcp: z.boolean(),
      debugging: z.boolean(),
      monitoring: z.boolean(),
    }),
  }),
  monitoring: z.object({
    metricsEnabled: z.boolean(),
    logLevel: z.string(),
    retentionDays: z.number().min(1),
  }),
  oauth: z
    .object({
      // 模式：internal（内置 AS）/ external（对接外部 IdP）/ both
      mode: z.enum(['internal', 'external', 'both']),
      // Hub 作为 Protected Resource 的规范 URI（RFC8707 audience 标识）
      resource: z.string().url(),
      scopes: z.array(z.string()).default(['mcp:tools', 'mcp:resources']),
      // 内置 AS 配置（mode 为 internal/both 时必填）
      internal: z
        .object({
          issuer: z.string().url().optional(),
          tokenTtlSeconds: z.number().int().positive().default(3600),
          clients: z
            .array(
              z.object({
                clientId: z.string().min(1),
                clientSecret: z.string().min(1), // bcrypt 哈希
                scopes: z.array(z.string()).default(['mcp:tools']),
              }),
            )
            .default([]),
        })
        .optional(),
      // 外部 IdP 配置（mode 为 external/both 时必填）
      external: z
        .object({
          issuer: z.string().url(),
          metadataUrl: z.string().url().optional(),
          clientId: z.string().min(1),
          clientSecret: z.string().min(1),
          introspectionEndpoint: z.string().url().optional(),
          jwksUri: z.string().url().optional(),
          audience: z.string().min(1),
        })
        .optional(),
    })
    .optional(), // 整个 oauth 块可选

  // P5：subscriptions/listen（上游工具集变更 fan-out）调参。
  // 整块 optional —— 现有 system.json 无此字段时不报错；提供时内部字段都有默认值。
  subscriptions: z
    .object({
      enabled: z.boolean().default(true),
      // 轮询兜底周期（对不支持 listChanged 推送的上游 server）
      pollIntervalMs: z.number().int().positive().default(60_000),
      // 近期收到 listChanged 主动推送的 server 降频窗口（避免轮询与推送重复触发）
      pollBackoffMs: z.number().int().positive().default(300_000),
      // 同一 server 短时间内多次变更的合并窗口（debounce）
      fanoutDebounceMs: z.number().int().nonnegative().default(500),
    })
    .optional(),

  // P5：MRTR（Multi Round-Trip Requests）中转配置。
  // stateKey 为 hex 编码的 HMAC key（≥32 字节解码后）；未提供则启动时随机生成 32 字节
  // （进程重启后旧 state 失效，可接受：TTL 本就 600s）。
  mrtr: z
    .object({
      enabled: z.boolean().default(true),
      // Hub mint 的 requestState 的 TTL（秒）
      stateTtlSeconds: z.number().int().positive().default(600),
      // HMAC key（hex 编码）。多实例部署需显式配置以共享；单实例默认随机生成。
      stateKey: z.string().optional(),
    })
    .optional(),

  // P7：协议兼容层配置（双向 era 翻译 + 错误归一）。
  // 整块 optional（与 subscriptions/mrtr 一致），未配置时由 ConfigManager.getCompatibility()
  // 兜底解析为「默认全开」；提供时 `.prefault({})` 触发字段级 default（zod v4 容器级
  // `.default({})` 不会回填字段默认值，Task 2 在 4.3.6 下验证）。
  compatibility: CompatibilityOptionsSchema.prefault({}).optional(),
});
