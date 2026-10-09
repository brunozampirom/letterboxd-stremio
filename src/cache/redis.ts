import { Redis } from '@upstash/redis';

let client: Redis | null | undefined;

// Upstash bills per *command*, not per round-trip: MGET over 150 keys
// is one command, a pipeline of 150 GETs is 150. Every call site that
// needs a set of keys must go through redisMGet for that reason.
const MGET_CHUNK = 128;
// Writes can't collapse the same way (SET carries a per-key TTL), so
// they're only pipelined to save round-trips. They happen on genuine
// cache misses, which are rare once the L1 in cache/index.ts is warm.
const PIPELINE_CHUNK = 64;

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function envCreds(): { url: string; token: string } | null {
  const url = process.env.UPSTASH_REDIS_REST_URL ?? process.env.KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN ?? process.env.KV_REST_API_TOKEN;
  if (!url || !token) return null;
  return { url, token };
}

export function getRedis(): Redis | null {
  if (client !== undefined) return client;
  const creds = envCreds();
  if (!creds) {
    client = null;
    return null;
  }
  client = new Redis(creds);
  return client;
}

export async function redisGet<T>(key: string): Promise<T | undefined> {
  const r = getRedis();
  if (!r) return undefined;
  try {
    const v = await r.get<T>(key);
    return v ?? undefined;
  } catch (err) {
    console.warn('[cache:redis] get failed', err);
    return undefined;
  }
}

export async function redisMGet<T>(keys: readonly string[]): Promise<Map<string, T>> {
  const found = new Map<string, T>();
  const r = getRedis();
  if (!r || keys.length === 0) return found;
  try {
    for (const batch of chunk(keys, MGET_CHUNK)) {
      const values = await r.mget<(T | null)[]>(batch as string[]);
      batch.forEach((key, i) => {
        const v = values?.[i];
        if (v !== null && v !== undefined) found.set(key, v);
      });
    }
  } catch (err) {
    console.warn('[cache:redis] mget failed', err);
  }
  return found;
}

export async function redisSet<T>(key: string, value: T, ttlMs: number): Promise<void> {
  const r = getRedis();
  if (!r) return;
  try {
    await r.set(key, value, { px: ttlMs });
  } catch (err) {
    console.warn('[cache:redis] set failed', err);
  }
}

export type RedisWrite = { key: string; value: unknown; ttlMs: number };

export async function redisSetMany(entries: readonly RedisWrite[]): Promise<void> {
  const r = getRedis();
  if (!r || entries.length === 0) return;
  try {
    for (const batch of chunk(entries, PIPELINE_CHUNK)) {
      const p = r.pipeline();
      for (const e of batch) p.set(e.key, e.value, { px: e.ttlMs });
      await p.exec();
    }
  } catch (err) {
    console.warn('[cache:redis] pipelined set failed', err);
  }
}

export async function redisDeleteByPattern(pattern: string): Promise<number> {
  const r = getRedis();
  if (!r) return 0;
  let cursor = 0;
  let deleted = 0;
  try {
    do {
      const [next, keys] = await r.scan(cursor, { match: pattern, count: 100 });
      if (keys.length > 0) {
        await r.del(...keys);
        deleted += keys.length;
      }
      cursor = Number(next);
    } while (cursor !== 0);
  } catch (err) {
    console.warn('[cache:redis] delete by pattern failed', err);
  }
  return deleted;
}
