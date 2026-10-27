import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';

import { ApiToMcpWebService } from './api-to-mcp-web-service.js';

vi.mock('./api_tool_integration_service.js', () => ({
  ApiToolIntegrationService: class {
    async initialize() {}
    async reloadConfig() {}
    async shutdown() {}
  },
}));

it('preserves complete source configuration on a description-only edit with real disk readback', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mcp-config-preservation-'));
  const path = join(directory, 'api-tools.json');
  const service = new ApiToMcpWebService();
  vi.stubEnv('QA_PRESERVE_KEY', 'runtime-only-value');
  const config = {
    id: 'saved-id',
    name: 'saved-name',
    description: 'before',
    api: {
      url: 'http://127.0.0.1:8181/api/ping',
      method: 'POST' as const,
      headers: { 'X-QA': '${QA_PRESERVE_KEY}' },
      queryParams: { source: 'qa' },
      body: { value: 'keep' },
      timeout: 12000,
      retries: 2,
    },
    parameters: {
      type: 'object' as const,
      properties: { query: { type: 'string' as const } },
      required: ['query'],
    },
    response: { jsonata: 'data', errorPath: 'error', successCondition: 'ok = true' },
    security: { allowedDomains: ['127.0.0.1'] },
    cache: { enabled: true, ttl: 60 },
  };
  try {
    await writeFile(path, JSON.stringify({ version: '1.0.0', tools: [config] }));
    await service.initialize(path);
    const { configs } = await service.getConfigs();
    expect(configs[0]).toMatchObject({
      id: config.id,
      name: config.name,
      api: { url: config.api.url },
    });
    const loaded = await service.getConfigDetails(config.id);
    expect(loaded).toEqual(config);
    const edited = { ...loaded!, description: 'after' };
    expect((await service.updateConfig(config.id, edited)).success).toBe(true);
    expect(JSON.parse(await readFile(path, 'utf-8')).tools).toEqual([
      { ...config, description: 'after' },
    ]);
  } finally {
    await service.shutdown();
    vi.unstubAllEnvs();
    await rm(directory, { recursive: true, force: true });
  }
});
