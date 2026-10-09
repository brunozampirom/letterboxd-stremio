import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Upstash bills per command, so what this file actually asserts is the
// command count of a catalog-shaped workload, not just its results.
const mock = vi.hoisted(() => {
  const store = new Map<string, unknown>();
  const commands: string[] = [];
  return { store, commands };
});

vi.mock('@upstash/redis', () => {
  class Redis {
    constructor(_creds: unknown) {}

    async get(key: string) {
      mock.commands.push('get');
      return mock.store.get(key) ?? null;
    }

    async mget(keys: string[]) {
      mock.commands.push('mget');
      return keys.map((k) => mock.store.get(k) ?? null);
    }

    async set(key: string, value: unknown) {
      mock.commands.push('set');
      mock.store.set(key, value);
      return 'OK';
    }

    pipeline() {
      const queued: Array<[string, unknown]> = [];
      const p = {
        set(key: string, value: unknown) {
          queued.push([key, value]);
          return p;
        },
        async exec() {
          for (const [key, value] of queued) {
            mock.commands.push('set');
            mock.store.set(key, value);
          }
          return queued.map(() => 'OK');
        },
      };
      return p;
    }
  }
  return { Redis };
});

process.env.UPSTASH_REDIS_REST_URL = 'https://mock.upstash.io';
process.env.UPSTASH_REDIS_REST_TOKEN = 'mock-token';

// Imported lazily so the mock above is installed, and the env vars
// below are set, before the module memoizes its client.
let cache: typeof import('../src/cache');

beforeAll(async () => {
  cache = await import('../src/cache');
});

const TTL = 60_000;
const keys = Array.from({ length: 50 }, (_, i) => `film:${i}`);

beforeEach(() => {
  mock.store.clear();
  mock.commands.length = 0;
  cache.clear();
});

describe('cache command budget', () => {
  it('reads a whole key set with one command instead of one per key', async () => {
    for (const key of keys) mock.store.set(key, { id: key });

    await cache.warm(keys, TTL);
    const values = await Promise.all(
      keys.map((key) => cache.getOrFetch(key, TTL, async () => ({ id: 'fetched' }))),
    );

    expect(values[0]).toEqual({ id: 'film:0' });
    expect(values[49]).toEqual({ id: 'film:49' });
    expect(mock.commands.filter((c) => c === 'mget')).toHaveLength(1);
    expect(mock.commands.filter((c) => c === 'get')).toHaveLength(0);
  });

  it('serves a warmed key set from the L1 on a second pass', async () => {
    for (const key of keys) mock.store.set(key, { id: key });
    await cache.warm(keys, TTL);
    mock.commands.length = 0;

    await cache.warm(keys, TTL);
    await Promise.all(keys.map((key) => cache.get(key)));

    expect(mock.commands).toHaveLength(0);
  });

  it('issues one mget on a cold backend and writes the misses in bulk', async () => {
    await cache.warm(keys, TTL);
    await Promise.all(
      keys.map((key) => cache.getOrFetch(key, TTL, async () => ({ id: key }))),
    );
    await cache.flushWrites();

    expect(mock.commands.filter((c) => c === 'mget')).toHaveLength(1);
    expect(mock.commands.filter((c) => c === 'get')).toHaveLength(0);
    expect(mock.store.get('film:7')).toEqual({ id: 'film:7' });
  });

  it('does not write values the shouldCache guard rejects', async () => {
    const value = await cache.getOrFetch('empty', TTL, async () => [], cache.cacheIfNonEmpty);
    await cache.flushWrites();

    expect(value).toEqual([]);
    expect(mock.store.has('empty')).toBe(false);
  });
});
