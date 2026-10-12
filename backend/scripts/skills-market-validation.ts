import { Hono } from 'hono';
/** Read-only market search smoke test against a local configuration directory. */
import { strict as assert } from 'node:assert';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { skillsApi } from '../src/api/skills/index.js';
import { getSkillRepository } from '../src/services/skills-service.js';
import { getAllConfig, resetConfigInstances } from '../src/utils/config.js';

import type { AuthContext } from '../src/types/auth.js';

const { values } = parseArgs({
  options: {
    directory: { type: 'string' },
    q: { type: 'string', default: 'grill-me' },
    owner: { type: 'string' },
    limit: { type: 'string', default: '3' },
  },
});
if (!values.directory)
  throw new Error('Usage: --directory <config-directory> --q grill-me [--owner mattpocock]');
process.env.CONFIG_PATH = resolve(values.directory);
resetConfigInstances();
const sourcesBefore = await getSkillRepository().listSources();
const groupsBefore = (await getAllConfig()).groups;
const app = new Hono();
app.use('*', async (context, next) => {
  context.set('auth', {
    user: { id: 'validation', username: 'validation', role: 'admin' },
  } as AuthContext);
  await next();
});
app.route('/api/skills', skillsApi);
const query = new URLSearchParams({
  q: values.q!,
  limit: values.limit!,
  ...(values.owner && { owner: values.owner }),
});
const response = await app.request(`/api/skills/market/search?${query}`);
const body = await response.json();
assert.equal(response.status, 200, JSON.stringify(body));
assert.deepEqual(await getSkillRepository().listSources(), sourcesBefore);
assert.deepEqual((await getAllConfig()).groups, groupsBefore);
assert.equal(response.headers.get('Cache-Control'), 'private, no-store');
process.stdout.write(
  JSON.stringify(
    {
      status: response.status,
      query: body.data.query,
      cached: body.data.cached,
      items: body.data.items.map(
        (item: { id: string; source: string; importable: boolean; local: unknown }) => ({
          id: item.id,
          source: item.source,
          importable: item.importable,
          local: item.local,
        }),
      ),
      sourceAndGroupConfigUnchanged: true,
    },
    null,
    2,
  ) + '\n',
);
