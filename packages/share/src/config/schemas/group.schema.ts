/**
 * Group / GroupConfig 统一 Zod Schema
 * 合并了 share 的 Group（有 id、tools）和 core 的 GroupConfig（有 toolFilter）
 */
import { z } from 'zod/v4';

import { GroupSkillsSchema } from './skills.schema.js';

/**
 * 工具过滤规则 Schema
 */
export const ToolFilterSchema = z.object({
  include: z.array(z.string()).optional(),
  exclude: z.array(z.string()).optional(),
  patterns: z.array(z.string()).optional(),
});

/**
 * 组验证配置 Schema
 */
export const GroupValidationSchema = z.object({
  enabled: z.boolean(),
  validationKey: z.string().optional(),
  createdAt: z.string().optional(),
  lastUpdated: z.string().optional(),
});

/**
 * 单个 Group Schema
 */
export const GroupSchema = z
  .object({
    id: z.string().min(1, { error: '组ID不能为空' }),
    name: z.string().min(1, { error: '组名称不能为空' }),
    description: z.string().optional(),
    servers: z.array(z.string().min(1, { error: '服务器名称不能为空' })),
    tools: z.array(z.string()),
    skills: GroupSkillsSchema.optional(),
    toolFilter: ToolFilterSchema.optional(),
    validation: GroupValidationSchema.optional(),
    // P4: 协议层 cacheHint 组级覆盖（默认 ttlMs=60000, cacheScope='public'）
    cacheHints: z
      .object({
        toolsListTtlMs: z.number().int().nonnegative().optional(),
        toolsListCacheScope: z.enum(['public', 'private']).optional(),
      })
      .optional(),
  })
  .refine((group) => group.servers.length > 0 || (group.skills?.include.length ?? 0) > 0, {
    path: ['servers'],
    message: '每个组至少需要包含一个服务器或已发布技能',
  });

/**
 * GroupConfig Schema（组名到组的映射）
 */
export const GroupConfigSchema = z.record(z.string(), GroupSchema);
