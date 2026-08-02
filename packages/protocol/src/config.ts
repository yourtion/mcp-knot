import { z } from 'zod';

export const InboundOptionsSchema = z.object({
  enabled: z.boolean().default(true),
  legacyMode: z.enum(['reject', 'shim']).default('shim'),
});

export const OutboundOptionsSchema = z.object({
  enabled: z.boolean().default(true),
  modernOnly: z.boolean().default(false),
  mrtrLegacyDegradation: z.enum(['shim', 'reject']).default('shim'),
});

export const ErrorOptionsSchema = z.object({
  unified: z.boolean().default(true),
});

export const CompatibilityOptionsSchema = z.object({
  // zod v4：容器级 `.default({})` 直接落值、不再走子 schema 填充字段默认值；
  // 改用 `.prefault({})`，缺省时以空对象过一遍子 schema，从而触发字段级 default。
  inbound: InboundOptionsSchema.prefault({}),
  outbound: OutboundOptionsSchema.prefault({}),
  errors: ErrorOptionsSchema.prefault({}),
});

export type CompatibilityOptions = z.infer<typeof CompatibilityOptionsSchema>;

export const defaultCompatibilityOptions: CompatibilityOptions = CompatibilityOptionsSchema.parse(
  {},
);
