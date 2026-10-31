import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, Server } from 'node:http';
import { AddressInfo } from 'node:net';

// Catalog routes against a mocked Upstash. The store is seeded with
// everything a curated catalog needs, so a healthy render never leaves
// the process; a failing store answers like Upstash over its quota.
const mock = vi.hoisted(() => {
  const store = new Map<string, unknown>();
  const commands: string[] = [];
  const state = { failing: false };
  const send = (command: string) => {
    commands.push(command);
    if (state.failing) throw new Error('ERR max requests limit exceeded');
  };
  return { store, commands, state, send };
});

vi.mock('@upstash/redis', () => {
  class Redis {
    constructor(_creds: unknown) {}

    async get(key: string) {
      mock.send('get');
      return mock.store.get(key) ?? null;
    }

    async mget(keys: string[]) {
      mock.send('mget');
      return keys.map((k) => mock.store.get(k) ?? null);
    }

    async set(key: string, value: unknown) {
      mock.send('set');
      mock.store.set(key, value);
      return 'OK';
    }

    pipeline() {
      const p = {
        set() {
          return p;
        },
        async exec() {
          mock.send('pipeline');
          return [];
        },
      };
      return p;
    }
  }
  return { Redis };
});

process.env.UPSTASH_REDIS_REST_URL = 'https://mock.upstash.io';
process.env.UPSTASH_REDIS_REST_TOKEN = 'mock-token';

const CURATED_URL = '/alice/catalog/movie/letterboxd-curated-top500.json';

function seedCuratedCatalog() {
  mock.store.set('list:official:letterboxds-top-500-films', [
    { slug: 'harakiri', title: 'Harakiri', year: 1962 },
  ]);
  mock.store.set('exclusion:alice', ['tt0000001']);
  mock.store.set('filmIds:harakiri', { imdbId: 'tt0056058', tmdbId: '14537' });
  mock.store.set('cinemeta:tt0056058', {
    type: 'movie',
    meta: { name: 'Harakiri', poster: 'https://example.com/p.jpg' },
  });
}

let server: Server;
let base: string;
let cache: typeof import('../src/cache');

beforeAll(async () => {
  cache = await import('../src/cache');
  const { handleRequest } = await import('../src/server/router');
  server = createServer((req, res) => {
    void handleRequest(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  base = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
});

beforeEach(() => {
  mock.store.clear();
  mock.commands.length = 0;
  mock.state.failing = false;
  cache.clear();
});

describe('catalog over http', () => {
  it('lets the CDN hold curated catalogs for an hour', async () => {
    seedCuratedCatalog();
    const res = await fetch(`${base}${CURATED_URL}`);

    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toContain('s-maxage=3600');
    const body = (await res.json()) as { metas: { id: string }[] };
    expect(body.metas.map((m) => m.id)).toEqual(['tt0056058']);
  });

  it('answers 503 instead of rendering cold when the cache backend is down', async () => {
    mock.state.failing = true;
    const res = await fetch(`${base}${CURATED_URL}`);

    expect(res.status).toBe(503);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('retry-after')).toBe('60');
  });

  it('spends nothing on the backend while it is parked', async () => {
    mock.state.failing = true;
    await fetch(`${base}${CURATED_URL}`);
    mock.commands.length = 0;

    const res = await fetch(`${base}/alice/catalog/movie/letterboxd-watchlist.json`);

    expect(res.status).toBe(503);
    expect(mock.commands).toHaveLength(0);
  });

  it('still serves the manifest during an outage', async () => {
    mock.state.failing = true;
    await fetch(`${base}${CURATED_URL}`);

    const res = await fetch(`${base}/alice/manifest.json`);
    expect(res.status).toBe(200);
  });
});
