import * as memory from './memory';
import { getRedis, redisDeleteByPattern, redisGet, redisSet } from './redis';

const useRedis = getRedis() !== null;
console.log(`[cache] backend: ${useRedis ? 'redis (upstash)' : 'memory'}`);

export type CacheInfo = {
  backend: 'redis' | 'memory';
  vendor?: 'upstash';
};

export function info(): CacheInfo {
  return useRedis ? { backend: 'redis', vendor: 'upstash' } : { backend: 'memory' };
}

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

const PER_USER_PATTERNS = (username: string) => [
  `watchlist:${username}`,
  `diary:${username}`,
  `lists:${username}`,
  `list:${username}:*`,
  `rss:${username}`,
  `recommend:${username}:*`,
  `exclusion:${username}`,
];

export async function clearForUser(username: string): Promise<number> {
  if (!useRedis) {
    memory.clear();
    return -1;
  }
  let total = 0;
  for (const pattern of PER_USER_PATTERNS(username)) {
    total += await redisDeleteByPattern(pattern);
  }
  return total;
}
