import * as memory from './memory';
import { getRedis, redisGet, redisSet } from './redis';

const useRedis = getRedis() !== null;
console.log(`[cache] backend: ${useRedis ? 'redis (upstash)' : 'memory'}`);

export async function get<T>(key: string): Promise<T | undefined> {
  if (useRedis) return redisGet<T>(key);
  return memory.get<T>(key);
}

export async function set<T>(key: string, value: T, ttlMs: number): Promise<void> {
  if (useRedis) {
    await redisSet(key, value, ttlMs);
    return;
  }
  memory.set(key, value, ttlMs);
}

export async function getOrFetch<T>(
  key: string,
  ttlMs: number,
  fetcher: () => Promise<T>,
): Promise<T> {
  const hit = await get<T>(key);
  if (hit !== undefined) return hit;
  const value = await fetcher();
  await set(key, value, ttlMs);
  return value;
}

export function clear(): void {
  memory.clear();
}
