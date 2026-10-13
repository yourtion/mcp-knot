import { z } from 'zod/v4';

export const SkillSourceIdSchema = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/);
const skillNames = z
  .array(
    z
      .string()
      .min(1)
      .refine(
        (name) => !['/', '\\', '\0'].some((part) => name.includes(part)) && !name.startsWith('-'),
      ),
  )
  .min(1)
  .refine((names) => new Set(names).size === names.length, 'Duplicate skill names');
const repository = z.string().refine((value) => {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash;
  } catch {
    return false;
  }
}, 'Repository must be an HTTPS URL without credentials');

export const SkillSourceSchema = z.discriminatedUnion('type', [
  z.object({
    id: SkillSourceIdSchema,
    type: z.literal('git'),
    repository,
    ref: z
      .string()
      .regex(/^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/)
      .default('HEAD'),
    skills: skillNames,
  }),
  z.object({
    id: SkillSourceIdSchema,
    type: z.literal('local'),
    directory: z.string().min(1),
    skills: skillNames,
  }),
  z.object({
    id: SkillSourceIdSchema,
    type: z.literal('skills-cli'),
    repository: z.string().regex(/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/),
    skills: skillNames,
    cliVersion: z
      .string()
      .regex(/^(latest|\d+\.\d+\.\d+)$/)
      .default('latest'),
  }),
]);

export const SkillSelectionSchema = z.object({
  sourceId: SkillSourceIdSchema,
  revision: z.string().regex(/^[a-f0-9]{64}$/),
  skill: z.string().min(1),
});
export const GroupSkillsSchema = z.object({ include: z.array(SkillSelectionSchema) });

export type SkillSource = z.infer<typeof SkillSourceSchema>;
export type SkillSelection = z.infer<typeof SkillSelectionSchema>;
