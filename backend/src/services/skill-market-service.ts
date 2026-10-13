import { SkillsShMarketProvider, SkillMarketError } from '@mcp-core/mcp-knot-core/skills';

import { getAllConfig } from '../utils/config.js';
import { getSkillRepository } from './skills-service.js';

import type {
  SkillMarketItem,
  SkillMarketProvider,
  SkillRepository,
} from '@mcp-core/mcp-knot-core/skills';
import type { DeepReadonly, GroupConfig } from '@mcp-core/mcp-knot-share';
import type { SkillSource } from '@mcp-core/mcp-knot-share/config';

function githubRepository(source: SkillSource): string | undefined {
  if (source.type === 'skills-cli') return source.repository.replace(/\.git$/, '').toLowerCase();
  if (source.type !== 'git') return undefined;
  const url = new URL(source.repository);
  if (!['github.com', 'www.github.com'].includes(url.hostname) || url.port) return undefined;
  const path = url.pathname
    .replace(/^\//, '')
    .replace(/\/$/, '')
    .replace(/\.git$/, '');
  return /^[^/]+\/[^/]+$/.test(path) ? path.toLowerCase() : undefined;
}

/** Market metadata is cached upstream; import/publication state is recomputed on every call. */
export class SkillMarketService {
  constructor(
    private readonly provider: SkillMarketProvider,
    private readonly repository: SkillRepository,
    private readonly getGroups: () => Promise<DeepReadonly<GroupConfig>>,
  ) {}

  private async localState(items: SkillMarketItem[]) {
    const [sources, groups] = await Promise.all([this.repository.listSources(), this.getGroups()]);
    const matching = sources.filter((source) =>
      items.some(
        (item) =>
          item.sourceType === 'github' && githubRepository(source) === item.source.toLowerCase(),
      ),
    );
    const imports = await Promise.all(
      matching.map(async (source) => ({
        source,
        imported: await this.repository.latest(source.id),
      })),
    );
    return { groups, imports };
  }

  async search(input: unknown) {
    const result = await this.provider.search(input);
    const { groups, imports } = await this.localState(result.items).catch((cause: unknown) => {
      throw new SkillMarketError(
        'MARKET_LOCAL_STATE_UNAVAILABLE',
        'Unable to read local skill import/publication state',
        503,
        undefined,
        { cause },
      );
    });
    const items = result.items.map((item) => {
      const candidates =
        item.sourceType === 'github'
          ? imports.filter(({ source }) => githubRepository(source) === item.source.toLowerCase())
          : [];
      const available = candidates.flatMap(
        ({ source, imported }) =>
          imported?.selections
            .filter(
              (selection) => selection.skill.normalize('NFKC') === item.slug.normalize('NFKC'),
            )
            .map((selection) => ({ ...selection, sourceId: source.id })) ?? [],
      );
      const sourceIds = new Set(candidates.map(({ source }) => source.id));
      const publishedIn = Object.entries(groups).flatMap(
        ([groupId, group]) =>
          group.skills?.include
            .filter(
              (selection) =>
                sourceIds.has(selection.sourceId) &&
                selection.skill.normalize('NFKC') === item.slug.normalize('NFKC'),
            )
            .map((selection) => ({ groupId, ...selection })) ?? [],
      );
      return {
        ...item,
        local: {
          imported: available.length > 0,
          imports: available,
          published: publishedIn.length > 0,
          publishedIn,
        },
        ...(item.importable && {
          importOptions: {
            git: {
              type: 'git' as const,
              repository: `https://github.com/${item.source}.git`,
              ref: 'HEAD',
              skills: [item.slug],
            },
            skillsCli: {
              type: 'skills-cli' as const,
              repository: item.source,
              cliVersion: 'latest',
              skills: [item.slug],
            },
          },
        }),
      };
    });
    return { ...result, items };
  }
}

let provider: { key: string; value: SkillsShMarketProvider } | undefined;
export function getSkillMarketService(): SkillMarketService {
  const baseUrl = process.env.SKILLS_MARKET_API_URL ?? 'https://skills.sh';
  const key = baseUrl;
  if (provider?.key !== key) {
    provider = {
      key,
      value: new SkillsShMarketProvider({
        baseUrl,
      }),
    };
  }
  return new SkillMarketService(
    provider.value,
    getSkillRepository(),
    async () => (await getAllConfig()).groups,
  );
}
