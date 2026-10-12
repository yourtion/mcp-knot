import { SkillRepository } from '@mcp-core/mcp-knot-core/skills';
import { resolve } from 'node:path';

let repository: SkillRepository | undefined;
export function getSkillRepository(): SkillRepository {
  const directory = resolve(process.env.CONFIG_PATH || resolve(process.cwd(), 'config'), '.skills');
  if (repository?.directory !== directory) repository = new SkillRepository(directory);
  return repository;
}
