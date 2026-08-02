/**
 * P7 协议兼容层配置 Schema（单一来源）
 *
 * 本文件是 CompatibilityOptionsSchema 的唯一定义位置。
 * protocol 包（@mcp-core/mcp-knot-protocol）通过 re-export 引用，
 * 避免 protocol↔share 循环依赖。
 *
 * zod v4 关键约束：子 schema 用 `.prefault({})` 而非 `.default({})`，
 * 否则容器级默认值直接落值、不再走子 schema 触发字段级 default
 * （Task 2 在 zod 4.3.6 下验证的事实）。
 */
import { z } from 'zod/v4';

/**
 * 入站（legacy → modern）翻译选项
 */
export const InboundOptionsSchema = z.object({
  enabled: z.boolean().default(true),
  legacyMode: z.enum(['reject', 'shim']).default('shim'),
});

/**
 * 出站（modern → legacy 上游）翻译选项
 */
export const OutboundOptionsSchema = z.object({
  enabled: z.boolean().default(true),
  modernOnly: z.boolean().default(false),
  mrtrLegacyDegradation: z.enum(['shim', 'reject']).default('shim'),
});

/**
 * 错误归一选项
 */
export const ErrorOptionsSchema = z.object({
  unified: z.boolean().default(true),
});

/**
 * 协议兼容层总开关与子段配置。
 *
 * 三段都用 `.prefault({})`：缺失或为 `{}` 时以空对象过一遍子 schema，
 * 从而触发字段级 default，保证默认值（全开）一致回填。
 */
export const CompatibilityOptionsSchema = z.object({
  inbound: InboundOptionsSchema.prefault({}),
  outbound: OutboundOptionsSchema.prefault({}),
  errors: ErrorOptionsSchema.prefault({}),
});

export type CompatibilityOptions = z.infer<typeof CompatibilityOptionsSchema>;

/**
 * 默认 compatibility 配置（单一实例）。
 *
 * 集中在此计算并由 protocol 包 re-export，保证 share 与 protocol 共用同一份引用，
 * 避免两份等值但不同引用的对象。
 */
export const defaultCompatibilityOptions: CompatibilityOptions = CompatibilityOptionsSchema.parse(
  {},
);
