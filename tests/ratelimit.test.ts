import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IncomingMessage } from 'node:http';

const mock = vi.hoisted(() => ({
  calls: 0,
  shouldThrow: false,
  success: true,
}));

vi.mock('@upstash/redis', () => {
  class Redis {
    constructor(_creds: unknown) {}
  }
  return { Redis };
});

vi.mock('@upstash/ratelimit', () => {
  class Ratelimit {
    static slidingWindow() {
      return {};
    }
    constructor(_opts: unknown) {}
    async limit(_id: string) {
      mock.calls += 1;
      if (mock.shouldThrow) {
        throw new Error('Command failed: ERR max requests limit exceeded. Limit: 500000');
      }
      return { success: mock.success, limit: 20, remaining: 19, reset: Date.now() + 60_000 };
    }
  }
  return { Ratelimit };
});

process.env.UPSTASH_REDIS_REST_URL = 'https://mock.upstash.io';
process.env.UPSTASH_REDIS_REST_TOKEN = 'mock-token';

let ratelimit: typeof import('../src/server/ratelimit');

beforeAll(async () => {
  ratelimit = await import('../src/server/ratelimit');
});

const req = {
  headers: { 'x-forwarded-for': '203.0.113.7' },
  socket: { remoteAddress: '203.0.113.7' },
} as unknown as IncomingMessage;

beforeEach(() => {
  mock.calls = 0;
  mock.shouldThrow = false;
  mock.success = true;
});

describe('rate limiter', () => {
  it('reports the verdict while the backend is healthy', async () => {
    const result = await ratelimit.check(req, 'catalog');
    expect(result).toMatchObject({ success: true, limit: 20 });
  });

  it('allows the request when the backend is over quota', async () => {
    mock.shouldThrow = true;
    // A throw here used to surface as the response body of every route,
    // including /manifest.json, which touches no backend at all.
    expect(await ratelimit.check(req, 'catalog')).toBeNull();
  });

  it('stops hammering a backend that just failed', async () => {
    mock.shouldThrow = true;
    await ratelimit.check(req, 'catalog');
    const afterFirstFailure = mock.calls;

    mock.shouldThrow = false;
    expect(await ratelimit.check(req, 'catalog')).toBeNull();
    expect(await ratelimit.check(req, 'default')).toBeNull();
    expect(mock.calls).toBe(afterFirstFailure);
  });
});
