import { skillSourceFromCommand, SkillMarketError } from '@mcp-core/mcp-knot-core/skills';
import { Hono } from 'hono';

import { getSkillMarketService } from '../../services/skill-market-service.js';
import { getSkillRepository } from '../../services/skills-service.js';

import type { SkillMarketService } from '../../services/skill-market-service.js';

/** Authenticated control plane. Does not alter Group publication selections. */
export function createSkillsApi(options: { market?: SkillMarketService } = {}) {
  const skillsApi = new Hono();
  skillsApi.use('*', async (context, next) => {
    if (context.get('auth')?.user.role !== 'admin')
      return context.json(
        { success: false, error: { code: 'FORBIDDEN', message: 'Administrator access required' } },
        403,
      );
    await next();
  });
  skillsApi.onError((error, context) => {
    if (error instanceof SkillMarketError) {
      if (error.retryAfterSeconds !== undefined)
        context.header('Retry-After', String(error.retryAfterSeconds));
      return context.json(
        { success: false, error: { code: error.code, message: error.message } },
        error.status,
      );
    }
    return context.json(
      { success: false, error: { code: 'SKILLS_ERROR', message: error.message } },
      400,
    );
  });
  skillsApi.get('/market/search', async (context) => {
    context.header('Cache-Control', 'private, no-store');
    const data = await (options.market ?? getSkillMarketService()).search(context.req.query());
    return context.json({ success: true, data });
  });
  skillsApi.get('/sources', async (context) => {
    const repository = getSkillRepository();
    const sources = await repository.listSources();
    const data = await Promise.all(
      sources.map(async (source) => ({ ...source, latest: await repository.latest(source.id) })),
    );
    return context.json({ success: true, data });
  });
  skillsApi.post('/sources', async (context) => {
    const body: unknown = await context.req.json();
    const source =
      body &&
      typeof body === 'object' &&
      'command' in body &&
      'id' in body &&
      typeof body.command === 'string' &&
      typeof body.id === 'string'
        ? skillSourceFromCommand(body.id, body.command)
        : body;
    const data = await getSkillRepository().saveSource(source);
    return context.json({ success: true, data }, 201);
  });
  for (const operation of ['sync', 'update'] as const) {
    skillsApi.post(`/sources/:sourceId/${operation}`, async (context) => {
      const data = await getSkillRepository().sync(context.req.param('sourceId'), operation);
      return context.json({ success: true, data });
    });
  }
  return skillsApi;
}

export const skillsApi = createSkillsApi();
