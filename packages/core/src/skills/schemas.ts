import { z } from 'zod/v4';

/** SEP-2640: https://github.com/modelcontextprotocol/ext-skills/blob/main/specification/stable/skills.mdx */
export const SKILLS_EXTENSION = 'io.modelcontextprotocol/skills';
export const MAX_SKILL_FILES = 512;
export const MAX_SKILL_BYTES = 16 * 1024 * 1024;

const FrontmatterValidationSchema = z
  .object({
    // Agent Skills' reference validator supports Unicode names and NFKC comparisons.
    // Validate a normalized copy without changing the published frontmatter.
    name: z.string().refine((value) => {
      const normalized = value.normalize('NFKC');
      return (
        [...normalized].length <= 64 &&
        normalized === normalized.toLowerCase() &&
        /^[\p{L}\p{N}]+(?:-[\p{L}\p{N}]+)*$/u.test(normalized)
      );
    }, 'Skill name must be 1–64 lowercase letters/digits with single hyphens'),
    description: z
      .string()
      .min(1)
      .refine((value) => [...value].length <= 1024)
      .refine((value) => value.trim().length > 0),
    license: z.string().optional(),
    compatibility: z
      .string()
      .min(1)
      .refine((value) => [...value].length <= 500)
      .optional(),
    metadata: z
      .custom<Record<string, string>>(
        (value) =>
          value !== null &&
          typeof value === 'object' &&
          !Array.isArray(value) &&
          Object.values(value).every((entry) => typeof entry === 'string'),
        'Metadata must be a string-to-string map',
      )
      .optional(),
    'allowed-tools': z.string().optional(),
  })
  .catchall(z.json());

function isJsonValue(value: unknown, ancestors = new Set<object>()): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object' || ancestors.has(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) return false;
  ancestors.add(value);
  const valid = Object.values(value).every((entry) => isJsonValue(entry, ancestors));
  ancestors.delete(value);
  return valid;
}

// Parsing a Zod object drops own __proto__ keys. Validate without rebuilding the
// object so every original JSON field survives, without assigning prototype keys.
export const SkillFrontmatterSchema = z.custom<z.infer<typeof FrontmatterValidationSchema>>(
  (value) => isJsonValue(value) && FrontmatterValidationSchema.safeParse(value).success,
  'Invalid Agent Skills frontmatter or non-JSON metadata',
);

export const SkillResourceSchema = z.object({
  uri: z.string().min(1),
  digest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  size: z.number().int().nonnegative(),
});

export const SkillEntrySchema = z.object({
  uri: z.string().min(1),
  frontmatter: SkillFrontmatterSchema,
  resources: z.union([z.array(SkillResourceSchema), z.literal('dynamic')]),
});

export const ListSkillsParamsSchema = z.object({ cursor: z.string().optional() });
export const GetSkillParamsSchema = z.object({ uri: z.string().min(1) });

const cacheFields = {
  resultType: z.literal('complete'),
  ttlMs: z.number().int().nonnegative(),
  cacheScope: z.enum(['public', 'private']),
};

export const ListSkillsResultSchema = z.object({
  ...cacheFields,
  skills: z.array(SkillEntrySchema),
  nextCursor: z.string().optional(),
});

export const GetSkillResultSchema = z.object({ ...cacheFields, skill: SkillEntrySchema });

/** SDK v2 removes the wire-only resultType before applying a client's custom result schema. */
export const ListSkillsPayloadSchema = ListSkillsResultSchema.omit({ resultType: true });
export const GetSkillPayloadSchema = GetSkillResultSchema.omit({ resultType: true });

export type SkillFrontmatter = z.infer<typeof SkillFrontmatterSchema>;
export type SkillResource = z.infer<typeof SkillResourceSchema>;
export type SkillEntry = z.infer<typeof SkillEntrySchema>;
export type StaticSkillEntry = Omit<SkillEntry, 'resources'> & { resources: SkillResource[] };
