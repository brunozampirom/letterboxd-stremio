import * as memory from './memory';
import {
  getRedis,
  redisDeleteByPattern,
  redisGet,
  redisMGet,
  redisSetMany,
  RedisWrite,
} from './redis';

const useRedis = getRedis() !== null;
console.log(`[cache] backend: ${useRedis ? 'redis (upstash) + memory L1' : 'memory'}`);

// How long a value read out of Redis may live in the process-local L1.
// Capped well below the long namespace TTLs (filmIds and cinemeta are
// 7 days) so a warm instance re-reads at most once an hour and still
// picks up an /admin/refresh purge reasonably fast.
const L1_MAX_TTL_MS = 60 * 60 * 1000;

// Writes are buffered and flushed as one pipeline. Rendering a cold
// curated catalog produces ~250 cache writes; without this they'd be
// 250 separate HTTP round-trips to Upstash.
const WRITE_FLUSH_THRESHOLD = 64;
const pendingWrites = new Map<string, { value: unknown; ttlMs: number }>();

// warm() also proves which keys are *absent* from Redis. Without
// recording that, every getOrFetch in the fan-out right after would
// re-check the same key one at a time, which is the exact per-item
// cost warm() exists to remove. These only have to outlive the
// fan-out of the request that warmed them.
const MISS_TTL_MS = 60 * 1000;
const MISS_MAX_ENTRIES = 10000;
const knownMissing = new Map<string, number>();

function markMissing(key: string): void {
  knownMissing.delete(key);
  knownMissing.set(key, Date.now() + MISS_TTL_MS);
  while (knownMissing.size > MISS_MAX_ENTRIES) {
    const oldest = knownMissing.keys().next();
    if (oldest.done) break;
    knownMissing.delete(oldest.value);
  }
}

function isKnownMissing(key: string): boolean {
  const until = knownMissing.get(key);
  if (until === undefined) return false;
  if (until < Date.now()) {
    knownMissing.delete(key);
    return false;
  }
  return true;
}

function l1Ttl(ttlMs: number): number {
  // Only cap when Redis sits behind the L1 and can re-serve the value.
  // With no Redis configured this map is the cache, so honour the
  // caller's TTL in full.
  return useRedis ? Math.min(ttlMs, L1_MAX_TTL_MS) : ttlMs;
}

export type CacheInfo = {
  backend: 'redis' | 'memory';
  vendor?: 'upstash';
  l1Entries?: number;
};

export function info(): CacheInfo {
  return useRedis
    ? { backend: 'redis', vendor: 'upstash', l1Entries: memory.size() }
    : { backend: 'memory', l1Entries: memory.size() };
}

export async function get<T>(key: string): Promise<T | undefined> {
  const local = memory.get<T>(key);
  if (local !== undefined) return local;
  if (!useRedis || isKnownMissing(key)) return undefined;
  return redisGet<T>(key);
}

export async function set<T>(key: string, value: T, ttlMs: number): Promise<void> {
  memory.set(key, value, l1Ttl(ttlMs));
  knownMissing.delete(key);
  if (!useRedis) return;
  pendingWrites.set(key, { value, ttlMs });
  if (pendingWrites.size >= WRITE_FLUSH_THRESHOLD) await flushWrites();
}

// Drains the buffer. The request handler calls this before returning so
// nothing is lost when the function instance is frozen.
export async function flushWrites(): Promise<void> {
  if (!useRedis || pendingWrites.size === 0) return;
  const batch: RedisWrite[] = [];
  for (const [key, { value, ttlMs }] of pendingWrites) batch.push({ key, value, ttlMs });
  pendingWrites.clear();
  await redisSetMany(batch);
}

// Pulls a whole key set into the L1 with a single MGET. Call this
// before fanning out over per-item getOrFetch so the fan-out costs one
// Upstash command instead of one per item.
export async function warm(keys: readonly string[], ttlMs: number): Promise<void> {
  if (!useRedis || keys.length === 0) return;
  const missing: string[] = [];
  const seen = new Set<string>();
  for (const key of keys) {
    if (seen.has(key)) continue;
    seen.add(key);
    if (!memory.has(key)) missing.push(key);
  }
  if (missing.length === 0) return;
  const found = await redisMGet<unknown>(missing);
  for (const key of missing) {
    const value = found.get(key);
    if (value === undefined) markMissing(key);
    else memory.set(key, value, l1Ttl(ttlMs));
  }
}

export async function getOrFetch<T>(
  key: string,
  ttlMs: number,
  fetcher: () => Promise<T>,
  shouldCache?: (value: T) => boolean,
): Promise<T> {
  const local = memory.get<T>(key);
  if (local !== undefined) return local;

  if (useRedis && !isKnownMissing(key)) {
    const remote = await redisGet<T>(key);
    if (remote !== undefined) {
      memory.set(key, remote, l1Ttl(ttlMs));
      return remote;
    }
  }

  const value = await fetcher();
  if (!shouldCache || shouldCache(value)) {
    await set(key, value, ttlMs);
  }
  return value;
}

// Helper: refuse to cache empty arrays. Useful for any scrape that
// might return [] because of a transient 403/timeout. Without this
// guard a single bad fetch would poison the cache for the whole TTL.
export const cacheIfNonEmpty = <T>(v: T[]): boolean => Array.isArray(v) && v.length > 0;

export function clear(): void {
  pendingWrites.clear();
  knownMissing.clear();
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
  // The L1 is process-local, so a purge only reaches this instance.
  // Other warm instances fall back to the L1 TTL cap above.
  knownMissing.clear();
  memory.clear();
  let total = 0;
  for (const pattern of PER_USER_PATTERNS(username)) {
    total += await redisDeleteByPattern(pattern);
  }
  return total;
}
