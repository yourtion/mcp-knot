import { describe, expect, it, vi } from 'vitest';

import { SkillsShMarketProvider } from './market.js';

const skill = {
  id: 'mattpocock/skills/grill-me',
  name: 'grill-me',
  source: 'mattpocock/skills',
  installs: 100,
};
const response = (
  body: unknown = { skills: [skill], searchType: 'fuzzy' },
  headers: HeadersInit = {},
) => Response.json(body, { headers });

describe('skills.sh market provider', () => {
  it('uses public search without credentials, normalizes metadata, and leaves remote names as data', async () => {
    const fetcher = vi.fn(async () => response());
    const provider = new SkillsShMarketProvider({ fetch: fetcher });
    const result = await provider.search({ q: ' grill-me ', owner: 'MattPocock', limit: '3' });
    const [url, init] = fetcher.mock.calls[0] as unknown as [URL, RequestInit];
    expect(url.pathname).toBe('/api/search');
    expect(url.searchParams.get('q')).toBe('grill-me');
    expect(url.searchParams.get('owner')).toBe('mattpocock');
    expect(url.searchParams.get('limit')).toBe('3');
    expect(init.headers).not.toHaveProperty('Authorization');
    expect(result).toMatchObject({
      cached: false,
      items: [
        {
          ...skill,
          slug: 'grill-me',
          sourceType: 'github',
          importable: true,
          installUrl: 'https://github.com/mattpocock/skills',
          url: 'https://skills.sh/mattpocock/skills/grill-me',
        },
      ],
    });
  });

  it.each([
    { q: 'x' },
    { q: '   ' },
    { q: 'grill', owner: '../someone' },
    { q: 'grill', limit: 201 },
  ])('rejects invalid queries before fetching: %j', async (query) => {
    const fetcher = vi.fn(async () => response());
    await expect(
      new SkillsShMarketProvider({ fetch: fetcher }).search(query),
    ).rejects.toMatchObject({ code: 'INVALID_MARKET_QUERY', status: 400 });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('expires bounded caches, obeys cache headers, and returns independent copies', async () => {
    let now = 1000;
    const fetcher = vi.fn(async () =>
      response(undefined, { 'Cache-Control': 'public, max-age=60, s-maxage=1' }),
    );
    const provider = new SkillsShMarketProvider({
      fetch: fetcher,
      now: () => now,
      maxCacheEntries: 1,
    });
    const first = await provider.search({ q: 'grill' });
    first.items[0].name = 'mutated';
    expect((await provider.search({ q: 'grill' })).items[0].name).toBe('grill-me');
    now += 1001;
    expect((await provider.search({ q: 'grill' })).cached).toBe(false);
    await provider.search({ q: 'react' });
    expect((await provider.search({ q: 'grill' })).cached).toBe(false);
    expect(fetcher).toHaveBeenCalledTimes(4);
    const uncached = vi.fn(async () => response(undefined, { 'Cache-Control': 'no-store' }));
    const other = new SkillsShMarketProvider({ fetch: uncached });
    await other.search({ q: 'grill' });
    await other.search({ q: 'grill' });
    expect(uncached).toHaveBeenCalledTimes(2);
  });

  it('deduplicates concurrent requests and does not share mutable result objects', async () => {
    let finish!: (response: Response) => void;
    const fetcher = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          finish = resolve;
        }),
    );
    const provider = new SkillsShMarketProvider({ fetch: fetcher });
    const first = provider.search({ q: 'grill' });
    const next = provider.search({ q: 'grill' });
    await Promise.resolve();
    finish(response());
    const results = await Promise.all([first, next]);
    expect(fetcher).toHaveBeenCalledTimes(1);
    results[0].items[0].name = 'changed';
    expect(results[1].items[0].name).toBe('grill-me');
  });

  it('honors rate-limit cooldown across queries and resumes after Retry-After', async () => {
    let now = 1000;
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 429, headers: { 'Retry-After': '10' } }))
      .mockResolvedValue(response());
    const provider = new SkillsShMarketProvider({ fetch: fetcher, now: () => now });
    await expect(provider.search({ q: 'grill' })).rejects.toMatchObject({
      status: 429,
      retryAfterSeconds: 10,
    });
    now += 1000;
    await expect(provider.search({ q: 'other' })).rejects.toMatchObject({
      status: 429,
      retryAfterSeconds: 9,
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    now += 9000;
    expect((await provider.search({ q: 'grill' })).items).toHaveLength(1);
  });

  it('handles HTTP failures and malformed responses without converting failures into empty search results', async () => {
    for (const invalid of [
      new Response(null, { status: 503 }),
      new Response('not-json'),
      response({ skills: [{ ...skill, id: 'someone/else/skill' }] }),
    ]) {
      const provider = new SkillsShMarketProvider({ fetch: vi.fn(async () => invalid) });
      await expect(provider.search({ q: 'grill' })).rejects.toMatchObject({
        status: invalid.status === 503 ? 503 : 502,
      });
    }
    const provider = new SkillsShMarketProvider({
      fetch: vi.fn(async () => {
        throw new Error('network failure');
      }),
    });
    await expect(provider.search({ q: 'grill' })).rejects.toMatchObject({
      code: 'MARKET_UNAVAILABLE',
      status: 503,
    });
  });

  it('serves still-fresh cached results during rate-limit cooldown', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(response())
      .mockResolvedValue(new Response(null, { status: 429, headers: { 'Retry-After': '20' } }));
    const provider = new SkillsShMarketProvider({ fetch: fetcher });
    await provider.search({ q: 'grill' });
    await expect(provider.search({ q: 'other' })).rejects.toMatchObject({ status: 429 });
    expect((await provider.search({ q: 'grill' })).cached).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('aborts a slow upstream and reports a timeout', async () => {
    const fetcher: typeof fetch = (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), { once: true });
      });
    await expect(
      new SkillsShMarketProvider({ fetch: fetcher, timeoutMs: 10 }).search({ q: 'grill' }),
    ).rejects.toMatchObject({ code: 'MARKET_TIMEOUT', status: 504 });
  });

  it('preserves well-known results without proposing an unsupported Git import', async () => {
    const provider = new SkillsShMarketProvider({
      fetch: vi.fn(async () =>
        response({
          skills: [
            {
              id: 'mintlify.com/docs',
              name: 'Docs',
              source: 'mintlify.com',
              sourceType: 'well-known',
              installs: 10,
              installUrl: 'https://mintlify.com',
            },
          ],
        }),
      ),
    });
    expect((await provider.search({ q: 'docs' })).items[0]).toMatchObject({
      sourceType: 'well-known',
      importable: false,
      installUrl: 'https://mintlify.com/',
    });
  });
});
