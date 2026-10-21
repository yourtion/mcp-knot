import { GetSkillPayloadSchema, ListSkillsPayloadSchema } from '@mcp-core/mcp-knot-core/skills';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startFixture } from '../../../scripts/agent-validation/fixture.js';

// Ordinary CI: real production router and TCP upstreams, no credentials or model calls.
describe('real agent protocol regressions', () => {
  let fixture: Awaited<ReturnType<typeof startFixture>>;
  const clients: Client[] = [];
  beforeAll(async () => {
    fixture = await startFixture();
  }, 30000);
  afterAll(async () => {
    await Promise.all(clients.map((client) => client.close()));
    await fixture?.close();
  });
  async function connect(endpoint: string, mode: 'auto' | 'legacy' = 'auto') {
    const client = new Client(
      { name: 'agent-regression', version: '1' },
      {
        versionNegotiation: { mode },
        capabilities: { extensions: { 'io.modelcontextprotocol/skills': {} } },
      },
    );
    clients.push(client);
    await client.connect(new StreamableHTTPClientTransport(new URL(endpoint)));
    return client;
  }
  it('preserves descriptions and results from each same-named upstream tool', async () => {
    const direct = await connect(fixture.urls.alpha);
    const hub = await connect(`${fixture.baseUrl}/both/mcp`);
    const upstream = await direct.listTools();
    const aggregated = await hub.listTools();
    for (const tool of upstream.tools) {
      expect(
        aggregated.tools.find((candidate) => candidate.name === `alpha_${tool.name}`)?.description,
      ).toBe(tool.description);
    }
    const args = { message: 'route-check', a: 17, b: 25 };
    const original = await direct.callTool({ name: 'echo', arguments: args });
    expect((await hub.callTool({ name: 'alpha_echo', arguments: args })).content).toEqual(
      original.content,
    );
    expect((await hub.callTool({ name: 'beta_echo', arguments: args })).content).toEqual([
      { type: 'text', text: JSON.stringify({ backend: 'beta', message: 'route-check', sum: 42 }) },
    ]);
    expect(await hub.callTool({ name: 'alpha_fail', arguments: {} })).toMatchObject({
      isError: true,
      content: [{ type: 'text', text: 'CONTROLLED_ERROR:alpha' }],
    });
  });
  it('supports legacy → modern → legacy and concurrent mixed clients on one Group', async () => {
    for (const mode of ['legacy', 'auto', 'legacy'] as const) {
      const client = await connect(`${fixture.baseUrl}/alpha/mcp`, mode);
      expect(client.getProtocolEra()).toBe(mode === 'auto' ? 'modern' : 'legacy');
      expect((await client.listTools()).tools.map((tool) => tool.name)).toContain('alpha_echo');
      await client.close();
    }
    await Promise.all(
      Array.from({ length: 6 }, async (_, index) => {
        const client = await connect(`${fixture.baseUrl}/alpha/mcp`, index % 2 ? 'legacy' : 'auto');
        expect(
          await client.callTool({
            name: 'alpha_echo',
            arguments: { message: `client-${index}`, a: index, b: 1 },
          }),
        ).toMatchObject({
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                backend: 'alpha',
                message: `client-${index}`,
                sum: index + 1,
              }),
            },
          ],
        });
      }),
    );
  });
  it('keeps tools and pinned skill files inside their Group after a source update', async () => {
    const restricted = await connect(`${fixture.baseUrl}/beta/mcp`);
    expect(
      (await restricted.listTools()).tools.some((tool) => tool.name.startsWith('alpha_')),
    ).toBe(false);
    await expect(
      restricted.callTool({ name: 'alpha_echo', arguments: { message: 'isolated', a: 1, b: 2 } }),
    ).rejects.toMatchObject({ code: -32602 });
    const client = await connect(`${fixture.baseUrl}/fulfillment/mcp`);
    expect(fixture.first.revision).not.toBe(fixture.second.revision);
    const list = await client.request(
      { method: 'skills/list', params: {} },
      ListSkillsPayloadSchema,
    );
    expect(list.skills).toEqual(fixture.first.skills);
    const skill = list.skills[0];
    expect(
      await client.request(
        { method: 'skills/get', params: { uri: skill.uri } },
        GetSkillPayloadSchema,
      ),
    ).toMatchObject({ skill });
    for (const file of skill.resources) {
      const content = (await client.readResource({ uri: file.uri })).contents[0];
      const bytes =
        'text' in content ? Buffer.from(content.text) : Buffer.from(content.blob, 'base64');
      expect(bytes.length).toBe(file.size);
      expect(`sha256:${createHash('sha256').update(bytes).digest('hex')}`).toBe(file.digest);
      expect(bytes.toString()).toContain('choose West');
      await expect(restricted.readResource({ uri: file.uri })).rejects.toMatchObject({
        code: -32602,
      });
    }
  });
  it('surfaces an unavailable backend without breaking the healthy one', async () => {
    const client = await connect(`${fixture.baseUrl}/both/mcp`);
    await fixture.stopBeta();
    expect(
      await client.callTool({ name: 'beta_echo', arguments: { message: 'outage', a: 1, b: 2 } }),
    ).toMatchObject({ isError: true });
    expect(
      await client.callTool({ name: 'alpha_echo', arguments: { message: 'survivor', a: 1, b: 2 } }),
    ).toMatchObject({
      content: [
        { type: 'text', text: JSON.stringify({ backend: 'alpha', message: 'survivor', sum: 3 }) },
      ],
    });
  });
});
