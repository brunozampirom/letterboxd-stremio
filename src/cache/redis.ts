import { Redis } from '@upstash/redis';

let client: Redis | null | undefined;

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

export async function redisSet<T>(key: string, value: T, ttlMs: number): Promise<void> {
  const r = getRedis();
  if (!r) return;
  try {
    await r.set(key, value, { px: ttlMs });
  } catch (err) {
    console.warn('[cache:redis] set failed', err);
  }
}
