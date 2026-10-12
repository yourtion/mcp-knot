import { INVALID_PARAMS, ProtocolError, ResourceTemplate } from '@modelcontextprotocol/server';

import { ValidationError } from '../errors/index.js';
import {
  GetSkillParamsSchema,
  GetSkillResultSchema,
  ListSkillsParamsSchema,
  ListSkillsResultSchema,
  SKILLS_EXTENSION,
} from './schemas.js';

import type { SkillCatalog } from './catalog.js';
import type { McpServer } from '@modelcontextprotocol/server';

/** Register before serving. Custom extension methods author the full wire envelope. */
export function registerSkills(server: McpServer, catalog: SkillCatalog, pageSize = 10): void {
  const cacheHint = { ttlMs: 60_000, cacheScope: 'private' as const };
  server.server.registerCapabilities({ resources: {}, extensions: { [SKILLS_EXTENSION]: {} } });

  server.server.setRequestHandler(
    'skills/list',
    {
      params: ListSkillsParamsSchema,
      result: ListSkillsResultSchema,
    },
    async ({ cursor }) => {
      try {
        return { resultType: 'complete' as const, ...cacheHint, ...catalog.list(cursor, pageSize) };
      } catch (error) {
        if (error instanceof ValidationError)
          throw new ProtocolError(INVALID_PARAMS, error.message);
        throw error;
      }
    },
  );

  server.server.setRequestHandler(
    'skills/get',
    {
      params: GetSkillParamsSchema,
      result: GetSkillResultSchema,
    },
    async ({ uri }) => {
      const skill = catalog.get(uri);
      if (!skill) throw new ProtocolError(INVALID_PARAMS, 'Unknown skill URI');
      return { resultType: 'complete' as const, ...cacheHint, skill };
    },
  );

  server.registerResource(
    'skill_files',
    new ResourceTemplate('skill://{+path}', {
      list: async () => ({ resources: catalog.resources() }),
    }),
    { description: 'Published skill instructions and supporting files', cacheHint },
    async (uri) => {
      const contents = catalog.read(uri.href);
      if (!contents) throw new ProtocolError(INVALID_PARAMS, 'Unknown skill file URI');
      return { contents: [contents] };
    },
  );
}
