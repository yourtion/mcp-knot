import { z } from 'zod/v4';

export const SkillMarketQuerySchema = z.object({
  q: z.string().trim().min(2).max(200),
  owner: z
    .string()
    .regex(/^[a-z0-9](?:[a-z0-9-]{0,38})$/i)
    .transform((value) => value.toLowerCase())
    .optional(),
  limit: z.coerce.number().int().min(1).max(200).default(20),
});
export type SkillMarketQuery = z.infer<typeof SkillMarketQuerySchema>;
export interface SkillMarketItem {
  id: string;
  slug: string;
  name: string;
  source: string;
  sourceType: 'github' | 'well-known' | 'unknown';
  installs: number;
  url: string;
  installUrl: string | null;
  importable: boolean;
}
export interface SkillMarketResult {
  provider: 'skills.sh';
  query: string;
  searchType?: string;
  items: SkillMarketItem[];
  cached: boolean;
}
export interface SkillMarketProvider {
  search(input: unknown): Promise<SkillMarketResult>;
}
export class SkillMarketError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: 400 | 429 | 502 | 503 | 504,
    readonly retryAfterSeconds?: number,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'SkillMarketError';
  }
}

const RawItemSchema = z.object({
  id: z.string().min(1).max(500),
  name: z.string().min(1).max(500),
  source: z.string().min(1).max(300),
  installs: z.number().int().nonnegative(),
  slug: z.string().min(1).max(200).optional(),
  sourceType: z.string().optional(),
  installUrl: z.string().nullable().optional(),
});
const PublicResponseSchema = z.object({
  skills: z.array(RawItemSchema).max(200),
  searchType: z.string().optional(),
});
const isGithubSource = (source: string) =>
  /^[a-zA-Z0-9][a-zA-Z0-9_.-]*\/[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(source);

interface ProviderOptions {
  baseUrl?: string;
  fetch?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
  cacheTtlMs?: number;
  maxCacheEntries?: number;
}

/** Search metadata only. Source import and Group publication remain explicit operations. */
export class SkillsShMarketProvider implements SkillMarketProvider {
  private readonly cache = new Map<string, { expires: number; result: SkillMarketResult }>();
  private readonly inflight = new Map<string, Promise<SkillMarketResult>>();
  private rateLimitedUntil = 0;
  private readonly fetcher: typeof fetch;
  private readonly now: () => number;
  private readonly baseUrl: string;
  constructor(private readonly options: ProviderOptions = {}) {
    if (
      (options.timeoutMs !== undefined &&
        (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1)) ||
      (options.cacheTtlMs !== undefined &&
        (!Number.isSafeInteger(options.cacheTtlMs) || options.cacheTtlMs < 0)) ||
      (options.maxCacheEntries !== undefined &&
        (!Number.isSafeInteger(options.maxCacheEntries) || options.maxCacheEntries < 1))
    )
      throw new SkillMarketError(
        'MARKET_CONFIGURATION_ERROR',
        'Invalid market timeout or cache configuration',
        503,
      );
    let url: URL;
    try {
      url = new URL(options.baseUrl ?? 'https://skills.sh');
    } catch (cause) {
      throw new SkillMarketError(
        'MARKET_CONFIGURATION_ERROR',
        'Invalid market base URL',
        503,
        undefined,
        { cause },
      );
    }
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== '/'
    )
      throw new SkillMarketError(
        'MARKET_CONFIGURATION_ERROR',
        'Market base URL must be an HTTPS origin',
        503,
      );
    this.baseUrl = url.origin;
    this.fetcher = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
  }

  async search(input: unknown): Promise<SkillMarketResult> {
    const query = SkillMarketQuerySchema.safeParse(input);
    if (!query.success)
      throw new SkillMarketError(
        'INVALID_MARKET_QUERY',
        'Search requires q (2–200 characters), limit (1–200) and an optional GitHub owner',
        400,
      );
    const key = JSON.stringify(query.data);
    const cached = this.cache.get(key);
    if (cached && cached.expires > this.now()) {
      this.cache.delete(key);
      this.cache.set(key, cached);
      return { ...structuredClone(cached.result), cached: true };
    }
    this.cache.delete(key);
    if (this.rateLimitedUntil > this.now())
      throw new SkillMarketError(
        'MARKET_RATE_LIMITED',
        'Skill market rate limit exceeded',
        429,
        Math.ceil((this.rateLimitedUntil - this.now()) / 1000),
      );
    const pending = this.inflight.get(key);
    if (pending) return structuredClone(await pending);
    const request = this.fetchSearch(query.data, key);
    this.inflight.set(key, request);
    try {
      return structuredClone(await request);
    } finally {
      this.inflight.delete(key);
    }
  }

  private retryAfter(response: Response): number | undefined {
    const value = response.headers.get('retry-after');
    if (!value) return undefined;
    const seconds = /^\d+$/.test(value)
      ? Number(value)
      : Math.ceil((Date.parse(value) - this.now()) / 1000);
    return Number.isFinite(seconds) ? Math.max(1, Math.min(seconds, 3600)) : undefined;
  }

  private async readJson(response: Response): Promise<unknown> {
    const reader = response.body?.getReader();
    if (!reader) throw new Error('Missing market response');
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > 2 * 1024 * 1024) {
          await reader.cancel();
          throw new Error('Market response exceeds 2 MiB');
        }
        chunks.push(chunk.value);
      }
    } finally {
      reader.releaseLock();
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  }

  private async fetchSearch(query: SkillMarketQuery, key: string): Promise<SkillMarketResult> {
    const url = new URL('/api/search', this.baseUrl);
    url.search = new URLSearchParams({
      q: query.q,
      limit: String(query.limit),
      ...(query.owner && { owner: query.owner }),
    }).toString();
    const signal = AbortSignal.timeout(this.options.timeoutMs ?? 10_000);
    let response: Response;
    try {
      response = await this.fetcher(url, {
        headers: { Accept: 'application/json' },
        signal,
      });
    } catch (cause) {
      throw new SkillMarketError(
        signal.aborted ? 'MARKET_TIMEOUT' : 'MARKET_UNAVAILABLE',
        signal.aborted ? 'Skill market request timed out' : 'Unable to reach skill market',
        signal.aborted ? 504 : 503,
        undefined,
        { cause },
      );
    }
    if (!response.ok) {
      await response.body?.cancel();
      if (response.status === 429) {
        const seconds = this.retryAfter(response) ?? 60;
        this.rateLimitedUntil = this.now() + seconds * 1000;
        throw new SkillMarketError(
          'MARKET_RATE_LIMITED',
          'Skill market rate limit exceeded',
          429,
          seconds,
        );
      }
      throw new SkillMarketError(
        'MARKET_UNAVAILABLE',
        `Skill market returned HTTP ${response.status}`,
        response.status >= 500 ? 503 : 502,
        this.retryAfter(response),
      );
    }
    let result: SkillMarketResult;
    try {
      const data = await this.readJson(response);
      const parsed = PublicResponseSchema.parse(data);
      const seen = new Set<string>();
      const items: SkillMarketItem[] = [];
      for (const raw of parsed.skills.slice(0, query.limit)) {
        const slug = raw.slug ?? raw.id.slice(raw.source.length + 1);
        if (
          !slug ||
          slug.includes('/') ||
          slug === '.' ||
          slug === '..' ||
          raw.id !== `${raw.source}/${slug}`
        )
          throw new Error('Invalid market skill identity');
        if (seen.has(raw.id)) continue;
        seen.add(raw.id);
        const sourceType =
          raw.sourceType === 'github' || (!raw.sourceType && isGithubSource(raw.source))
            ? 'github'
            : raw.sourceType === 'well-known'
              ? 'well-known'
              : 'unknown';
        const importable =
          sourceType === 'github' &&
          isGithubSource(raw.source) &&
          !slug.startsWith('-') &&
          !['\\', '\0'].some((part) => slug.includes(part));
        let installUrl: string | null = importable ? `https://github.com/${raw.source}` : null;
        if (!importable && raw.installUrl) {
          const install = new URL(raw.installUrl);
          if (install.protocol === 'https:' && !install.username && !install.password)
            installUrl = install.href;
        }
        items.push({
          id: raw.id,
          slug,
          name: raw.name,
          source: raw.source,
          sourceType,
          installs: raw.installs,
          url: `${this.baseUrl}/${raw.id.split('/').map(encodeURIComponent).join('/')}`,
          installUrl,
          importable,
        });
      }
      result = {
        provider: 'skills.sh',
        query: query.q,
        ...(parsed.searchType && { searchType: parsed.searchType }),
        items,
        cached: false,
      };
    } catch (cause) {
      throw new SkillMarketError(
        signal.aborted ? 'MARKET_TIMEOUT' : 'INVALID_MARKET_RESPONSE',
        signal.aborted
          ? 'Skill market response timed out'
          : 'Skill market returned an invalid response',
        signal.aborted ? 504 : 502,
        undefined,
        { cause },
      );
    }
    const control = response.headers.get('cache-control') ?? '';
    const advertised =
      /(?:^|,)\s*s-maxage=(\d+)/i.exec(control) ?? /(?:^|,)\s*max-age=(\d+)/i.exec(control);
    const ttl = /\b(?:no-store|no-cache)\b/i.test(control)
      ? 0
      : Math.min(
          this.options.cacheTtlMs ?? 30_000,
          advertised ? Number(advertised[1]) * 1000 : Infinity,
        );
    for (const [cachedKey, entry] of this.cache)
      if (entry.expires <= this.now()) this.cache.delete(cachedKey);
    if (ttl > 0) {
      this.cache.set(key, { expires: this.now() + ttl, result });
      while (this.cache.size > (this.options.maxCacheEntries ?? 100))
        this.cache.delete(this.cache.keys().next().value!);
    }
    return result;
  }
}
