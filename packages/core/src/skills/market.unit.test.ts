import { describe, expect, it, vi } from 'vitest';

import { SkillMarketError, SkillsShMarketProvider } from './market.js';

import type { SkillMarketResult } from './market.js';

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

  describe('constructor configuration', () => {
    it.each([
      { timeoutMs: 0 },
      { timeoutMs: 1.5 },
      { timeoutMs: Number.NaN },
      { cacheTtlMs: -1 },
      { cacheTtlMs: 0.5 },
      { maxCacheEntries: 0 },
      { maxCacheEntries: 2.5 },
    ])('rejects invalid numeric options: %j', (options) => {
      expect(() => new SkillsShMarketProvider(options)).toThrow(SkillMarketError);
      try {
        new SkillsShMarketProvider(options);
      } catch (error) {
        expect(error).toMatchObject({
          code: 'MARKET_CONFIGURATION_ERROR',
          status: 503,
          message: 'Invalid market timeout or cache configuration',
        });
      }
    });

    it('accepts boundary values for timeout and cache options', () => {
      expect(
        () => new SkillsShMarketProvider({ timeoutMs: 1, cacheTtlMs: 0, maxCacheEntries: 1 }),
      ).not.toThrow();
    });

    it.each([
      'http://skills.sh',
      'https://user@skills.sh',
      'https://user:pass@skills.sh',
      'https://skills.sh?query=1',
      'https://skills.sh#fragment',
      'https://skills.sh/path',
    ])('rejects non-HTTPS-origin base URLs: %s', (baseUrl) => {
      expect(() => new SkillsShMarketProvider({ baseUrl })).toThrow(
        'Market base URL must be an HTTPS origin',
      );
    });

    it('rejects unparseable base URLs with the original cause', () => {
      try {
        new SkillsShMarketProvider({ baseUrl: 'not a url' });
        expect.unreachable('constructor should throw');
      } catch (error) {
        expect(error).toMatchObject({
          code: 'MARKET_CONFIGURATION_ERROR',
          status: 503,
          message: 'Invalid market base URL',
        });
        expect((error as SkillMarketError).cause).toBeInstanceOf(TypeError);
      }
    });

    it('uses a custom HTTPS origin for requests and item URLs', async () => {
      const fetcher = vi.fn(async () => response());
      const provider = new SkillsShMarketProvider({
        baseUrl: 'https://market.example',
        fetch: fetcher,
      });
      const result = await provider.search({ q: 'grill' });
      const [url, init] = fetcher.mock.calls[0] as unknown as [URL, RequestInit];
      expect(url.origin).toBe('https://market.example');
      expect(url.pathname).toBe('/api/search');
      expect(init.headers).toEqual({ Accept: 'application/json' });
      expect(result.items[0].url).toBe('https://market.example/mattpocock/skills/grill-me');
    });
  });

  describe('query normalization boundaries', () => {
    it('accepts a 39-character owner and normalizes it to lowercase', async () => {
      const fetcher = vi.fn(async () => response());
      const owner = 'A'.repeat(39);
      await new SkillsShMarketProvider({ fetch: fetcher }).search({ q: 'grill', owner });
      const [url] = fetcher.mock.calls[0] as unknown as [URL, RequestInit];
      expect(url.searchParams.get('owner')).toBe(owner.toLowerCase());
    });

    it.each(['a'.repeat(40), '-owner'])('rejects out-of-range owner %s', async (owner) => {
      const fetcher = vi.fn(async () => response());
      await expect(
        new SkillsShMarketProvider({ fetch: fetcher }).search({ q: 'grill', owner }),
      ).rejects.toMatchObject({ code: 'INVALID_MARKET_QUERY', status: 400 });
      expect(fetcher).not.toHaveBeenCalled();
    });

    it('rejects a zero limit before fetching', async () => {
      const fetcher = vi.fn(async () => response());
      await expect(
        new SkillsShMarketProvider({ fetch: fetcher }).search({ q: 'grill', limit: 0 }),
      ).rejects.toMatchObject({ code: 'INVALID_MARKET_QUERY', status: 400 });
      expect(fetcher).not.toHaveBeenCalled();
    });

    it('reports the trimmed query as the canonical result query', async () => {
      const provider = new SkillsShMarketProvider({ fetch: vi.fn(async () => response()) });
      expect((await provider.search({ q: ' grill-me ' })).query).toBe('grill-me');
    });
  });

  describe('HTTP status and Retry-After handling', () => {
    it.each([
      [404, 502],
      [500, 503],
      [502, 503],
    ])('maps upstream HTTP %i to status %i', async (upstream, mapped) => {
      const provider = new SkillsShMarketProvider({
        fetch: vi.fn(async () => new Response(null, { status: upstream })),
      });
      await expect(provider.search({ q: 'grill' })).rejects.toMatchObject({
        code: 'MARKET_UNAVAILABLE',
        status: mapped,
        message: `Skill market returned HTTP ${upstream}`,
      });
    });

    it('forwards Retry-After seconds on non-429 failures without entering cooldown', async () => {
      const fetcher = vi.fn(
        async () => new Response(null, { status: 503, headers: { 'Retry-After': '30' } }),
      );
      const provider = new SkillsShMarketProvider({ fetch: fetcher });
      await expect(provider.search({ q: 'grill' })).rejects.toMatchObject({
        status: 503,
        retryAfterSeconds: 30,
      });
      // 5xx 不触发限流冷却：下一次请求仍应真正发出
      await expect(provider.search({ q: 'other' })).rejects.toMatchObject({ status: 503 });
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

    it('falls back to a 60-second cooldown when 429 omits a usable Retry-After', async () => {
      const fetcher = vi
        .fn()
        .mockResolvedValueOnce(new Response(null, { status: 429 }))
        .mockResolvedValue(response());
      const provider = new SkillsShMarketProvider({ fetch: fetcher });
      await expect(provider.search({ q: 'grill' })).rejects.toMatchObject({
        status: 429,
        retryAfterSeconds: 60,
      });
      await expect(provider.search({ q: 'other' })).rejects.toMatchObject({
        status: 429,
        retryAfterSeconds: 60,
      });
      expect(fetcher).toHaveBeenCalledTimes(1);
    });

    it('rejects malformed numeric Retry-After headers', async () => {
      const provider = new SkillsShMarketProvider({
        fetch: vi.fn(
          async () => new Response(null, { status: 429, headers: { 'Retry-After': '12abc' } }),
        ),
      });
      await expect(provider.search({ q: 'grill' })).rejects.toMatchObject({
        retryAfterSeconds: 60,
      });
    });

    it('parses HTTP-date Retry-After headers into a clamped second count', async () => {
      const now = Date.now();
      const future = new Date(now + 30_500).toUTCString();
      const futureProvider = new SkillsShMarketProvider({
        fetch: vi.fn(
          async () => new Response(null, { status: 429, headers: { 'Retry-After': future } }),
        ),
        now: () => now,
      });
      const first = await futureProvider
        .search({ q: 'grill' })
        .catch((error: SkillMarketError) => error);
      expect([29, 30, 31]).toContain(first.retryAfterSeconds);

      const past = new Date(now - 60_000).toUTCString();
      const pastProvider = new SkillsShMarketProvider({
        fetch: vi.fn(
          async () => new Response(null, { status: 429, headers: { 'Retry-After': past } }),
        ),
        now: () => now,
      });
      const second = await pastProvider
        .search({ q: 'grill' })
        .catch((error: SkillMarketError) => error);
      expect(second.retryAfterSeconds).toBe(1);
    });
  });

  describe('response payload validation', () => {
    const item = (overrides: Record<string, unknown>) => ({
      id: 'owner/repo/skill',
      name: 'skill',
      source: 'owner/repo',
      installs: 0,
      ...overrides,
    });

    it('slices the returned skills to the requested limit', async () => {
      const provider = new SkillsShMarketProvider({
        fetch: vi.fn(async () =>
          response({
            skills: [
              item({ id: 'owner/repo/a' }),
              item({ id: 'owner/repo/b' }),
              item({ id: 'owner/repo/c' }),
            ],
          }),
        ),
      });
      const result = await provider.search({ q: 'grill', limit: 2 });
      expect(result.items.map((entry) => entry.id)).toEqual(['owner/repo/a', 'owner/repo/b']);
    });

    it('deduplicates items sharing the same id', async () => {
      const provider = new SkillsShMarketProvider({
        fetch: vi.fn(async () => response({ skills: [item({}), item({ name: 'duplicate' })] })),
      });
      expect((await provider.search({ q: 'grill' })).items).toHaveLength(1);
    });

    it.each([
      ['an explicit "." slug', item({ slug: '.' })],
      ['an explicit ".." slug', item({ slug: '..' })],
      ['a slug containing a slash', item({ slug: 'sub/skill' })],
      ['a slug that does not match the id', item({ slug: 'other' })],
      ['an empty derived slug', { ...item({}), id: 'owner/repo/', slug: undefined }],
      ['an oversized slug', item({ slug: 'x'.repeat(201) })],
      ['an oversized name', item({ name: 'x'.repeat(501) })],
      ['an empty name', item({ name: '' })],
      ['a negative install count', item({ installs: -1 })],
      ['a fractional install count', item({ installs: 1.5 })],
    ])('rejects %s', async (_label, raw) => {
      const provider = new SkillsShMarketProvider({
        fetch: vi.fn(async () => response({ skills: [raw] })),
      });
      await expect(provider.search({ q: 'grill' })).rejects.toMatchObject({
        code: 'INVALID_MARKET_RESPONSE',
        status: 502,
      });
    });

    it('rejects payloads without a skills array and over-long arrays', async () => {
      const oversized = Array.from({ length: 201 }, (_, index) =>
        item({ id: `owner/repo/s${index}` }),
      );
      for (const body of [{}, { skills: oversized }]) {
        const provider = new SkillsShMarketProvider({ fetch: vi.fn(async () => response(body)) });
        await expect(provider.search({ q: 'grill' })).rejects.toMatchObject({
          code: 'INVALID_MARKET_RESPONSE',
        });
      }
    });

    it('keeps explicit slugs from the payload', async () => {
      const provider = new SkillsShMarketProvider({
        fetch: vi.fn(async () =>
          response({ skills: [item({ id: 'owner/repo/friendly', slug: 'friendly' })] }),
        ),
      });
      expect((await provider.search({ q: 'grill' })).items[0].slug).toBe('friendly');
    });
  });

  describe('source typing and import URLs', () => {
    const search = async (raw: Record<string, unknown>) => {
      const provider = new SkillsShMarketProvider({
        fetch: vi.fn(async () => response({ skills: [raw] })),
      });
      return (await provider.search({ q: 'grill' })).items[0];
    };

    it.each([
      [
        'a bare GitHub-style source',
        { id: 'owner/repo/skill', name: 's', source: 'owner/repo', installs: 0 },
        { sourceType: 'github', importable: true, installUrl: 'https://github.com/owner/repo' },
      ],
      [
        'an explicit github sourceType',
        { id: 'o/r/s', name: 's', source: 'o/r', installs: 0, sourceType: 'github' },
        { sourceType: 'github', importable: true, installUrl: 'https://github.com/o/r' },
      ],
      [
        'a github sourceType on a non-repo source',
        {
          id: 'example.com/s',
          name: 's',
          source: 'example.com',
          installs: 0,
          sourceType: 'github',
        },
        { sourceType: 'github', importable: false, installUrl: null },
      ],
      [
        'a well-known sourceType on a repo-shaped source',
        {
          id: 'owner/repo/s',
          name: 's',
          source: 'owner/repo',
          installs: 0,
          sourceType: 'well-known',
        },
        { sourceType: 'well-known', importable: false, installUrl: null },
      ],
      [
        'an unrecognized sourceType',
        {
          id: 'example.com/s',
          name: 's',
          source: 'example.com',
          installs: 0,
          sourceType: 'mirror',
        },
        { sourceType: 'unknown', importable: false, installUrl: null },
      ],
      [
        'a source with too many path segments',
        { id: 'owner/repo/extra/s', name: 's', source: 'owner/repo/extra', installs: 0 },
        { sourceType: 'unknown', importable: false, installUrl: null },
      ],
      [
        'a source with a leading space',
        { id: ' owner/repo/s', name: 's', source: ' owner/repo', installs: 0 },
        { sourceType: 'unknown', importable: false, installUrl: null },
      ],
      [
        'a slug starting with a hyphen',
        { id: 'owner/repo/-lead', name: 's', source: 'owner/repo', installs: 0 },
        { sourceType: 'github', importable: false, installUrl: null },
      ],
      [
        'a slug containing a backslash',
        { id: 'owner/repo/a\\b', name: 's', source: 'owner/repo', installs: 0 },
        { sourceType: 'github', importable: false, installUrl: null },
      ],
    ])('types %s without offering a Git import', async (_label, raw, expected) => {
      await expect(search(raw)).resolves.toMatchObject(expected);
    });

    it('keeps the GitHub install URL for importable skills that also advertise one', async () => {
      const entry = await search({
        id: 'owner/repo/s',
        name: 's',
        source: 'owner/repo',
        installs: 0,
        installUrl: 'https://installer.example/s',
      });
      expect(entry).toMatchObject({
        importable: true,
        installUrl: 'https://github.com/owner/repo',
      });
    });

    it.each([
      [
        'a plain https install URL',
        'https://installer.example/skill',
        'https://installer.example/skill',
      ],
      [
        'an install URL with trailing slash',
        'https://installer.example/',
        'https://installer.example/',
      ],
    ])('accepts %s for non-importable skills', async (_label, installUrl, expected) => {
      const entry = await search({
        id: 'example.com/s',
        name: 's',
        source: 'example.com',
        sourceType: 'well-known',
        installs: 0,
        installUrl,
      });
      expect(entry.installUrl).toBe(expected);
    });

    it.each([
      ['a plain http install URL', 'http://installer.example/skill'],
      ['an install URL with credentials', 'https://user:pass@installer.example/skill'],
      ['an install URL with a username only', 'https://user@installer.example/skill'],
    ])('drops %s', async (_label, installUrl) => {
      const entry = await search({
        id: 'example.com/s',
        name: 's',
        source: 'example.com',
        sourceType: 'well-known',
        installs: 0,
        installUrl,
      });
      expect(entry.installUrl).toBeNull();
    });

    it('omits searchType when the payload does not advertise one', async () => {
      const bare = {
        id: 'owner/repo/s',
        name: 's',
        source: 'owner/repo',
        installs: 0,
      };
      const provider = new SkillsShMarketProvider({
        fetch: vi.fn(async () => response({ skills: [bare] })),
      });
      const result = await provider.search({ q: 'grill' });
      expect('searchType' in result).toBe(false);
      const withType = new SkillsShMarketProvider({ fetch: vi.fn(async () => response()) });
      expect((await withType.search({ q: 'grill' })).searchType).toBe('fuzzy');
    });
  });

  describe('cache-control TTL handling', () => {
    const withTtl = (header: string, now: { value: number }) => {
      const fetcher = vi.fn(async () => response(undefined, { 'Cache-Control': header }));
      const provider = new SkillsShMarketProvider({ fetch: fetcher, now: () => now.value });
      return { fetcher, provider };
    };

    it.each(['s-maxage=10', 'public,s-maxage=10', 'max-age=10', 'public, max-age=10'])(
      'honors %s exactly',
      async (header) => {
        const now = { value: 1000 };
        const { fetcher, provider } = withTtl(header, now);
        await provider.search({ q: 'grill' });
        now.value += 5000;
        expect((await provider.search({ q: 'grill' })).cached).toBe(true);
        expect(fetcher).toHaveBeenCalledTimes(1);
        now.value += 5100;
        expect((await provider.search({ q: 'grill' })).cached).toBe(false);
        expect(fetcher).toHaveBeenCalledTimes(2);
      },
    );

    it('prefers s-maxage over max-age', async () => {
      const now = { value: 1000 };
      const { fetcher, provider } = withTtl('max-age=60, s-maxage=1', now);
      await provider.search({ q: 'grill' });
      now.value += 1500;
      expect((await provider.search({ q: 'grill' })).cached).toBe(false);
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

    it('ignores vendor cache directives like x-max-age', async () => {
      const now = { value: 1000 };
      const { fetcher, provider } = withTtl('x-max-age=10', now);
      await provider.search({ q: 'grill' });
      now.value += 11_000;
      expect((await provider.search({ q: 'grill' })).cached).toBe(true);
      expect(fetcher).toHaveBeenCalledTimes(1);
    });

    it('treats an entry as expired exactly at its expiry timestamp', async () => {
      let now = 1000;
      const fetcher = vi.fn(async () => response(undefined, { 'Cache-Control': 'max-age=5' }));
      const provider = new SkillsShMarketProvider({
        fetch: fetcher,
        now: () => now,
        cacheTtlMs: 100_000,
      });
      await provider.search({ q: 'grill' });
      now += 5000;
      expect((await provider.search({ q: 'grill' })).cached).toBe(false);
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

    it('refreshes entries on cache hits and evicts the least recently used', async () => {
      const fetcher = vi.fn(async () => response());
      const provider = new SkillsShMarketProvider({ fetch: fetcher, maxCacheEntries: 2 });
      await provider.search({ q: 'aa' });
      await provider.search({ q: 'bb' });
      // 命中 aa 会把它移到最近使用位置：此时 bb 成为最旧条目
      expect((await provider.search({ q: 'aa' })).cached).toBe(true);
      expect(fetcher).toHaveBeenCalledTimes(2);
      await provider.search({ q: 'cc' });
      // 新条目只淘汰最久未用的 bb，aa 与 cc 仍被缓存
      expect((await provider.search({ q: 'aa' })).cached).toBe(true);
      expect((await provider.search({ q: 'cc' })).cached).toBe(true);
      expect(fetcher).toHaveBeenCalledTimes(3);
      expect((await provider.search({ q: 'bb' })).cached).toBe(false);
      expect(fetcher).toHaveBeenCalledTimes(4);
    });
  });

  describe('response body handling', () => {
    it('rejects bodies larger than 2 MiB', async () => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          const chunk = new Uint8Array(1024 * 1024);
          controller.enqueue(chunk);
          controller.enqueue(chunk);
          controller.enqueue(chunk);
          controller.close();
        },
      });
      const provider = new SkillsShMarketProvider({
        fetch: vi.fn(
          async () => new Response(body, { headers: { 'Content-Type': 'application/json' } }),
        ),
      });
      const error = (await provider
        .search({ q: 'grill' })
        .catch((caught: SkillMarketError) => caught)) as SkillMarketError;
      expect(error).toMatchObject({ code: 'INVALID_MARKET_RESPONSE', status: 502 });
      expect((error.cause as Error).message).toBe('Market response exceeds 2 MiB');
    });

    it('accepts a body of exactly 2 MiB', async () => {
      const mebibyte = 1024 * 1024;
      const prefix = new Uint8Array(mebibyte).fill(32);
      const suffix = new Uint8Array(mebibyte).fill(32);
      suffix.set(Buffer.from('{"skills":[]}'), 0);
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(prefix);
          controller.enqueue(suffix);
          controller.close();
        },
      });
      const provider = new SkillsShMarketProvider({
        fetch: vi.fn(
          async () => new Response(body, { headers: { 'Content-Type': 'application/json' } }),
        ),
      });
      const result: SkillMarketResult = await provider.search({ q: 'grill' });
      expect(result.items).toEqual([]);
    });

    it('rejects successful responses without a body', async () => {
      const provider = new SkillsShMarketProvider({
        fetch: vi.fn(async () => new Response(null, { status: 200 })),
      });
      const error = (await provider
        .search({ q: 'grill' })
        .catch((caught: SkillMarketError) => caught)) as SkillMarketError;
      expect(error).toMatchObject({ code: 'INVALID_MARKET_RESPONSE', status: 502 });
      expect((error.cause as Error).message).toBe('Missing market response');
    });
  });
});
