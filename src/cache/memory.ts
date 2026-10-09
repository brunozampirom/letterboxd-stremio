type Entry<T> = {
  value: T;
  expiresAt: number;
};

// Bounded so a long-lived Fluid Compute instance doesn't grow without
// limit now that this doubles as the L1 in front of Redis. Cinemeta
// entries are the fat ones (poster + background + description), so the
// cap is set on entry count rather than bytes.
const MAX_ENTRIES = 5000;

const store = new Map<string, Entry<unknown>>();

export function get<T>(key: string): T | undefined {
  const entry = store.get(key) as Entry<T> | undefined;
  if (!entry) return undefined;
  if (entry.expiresAt < Date.now()) {
    store.delete(key);
    return undefined;
  }
  return entry.value;
}

export function set<T>(key: string, value: T, ttlMs: number): void {
  // Delete first so a re-write moves the key to the end of the Map's
  // iteration order and eviction below drops the least recently written.
  store.delete(key);
  store.set(key, { value, expiresAt: Date.now() + ttlMs });
  while (store.size > MAX_ENTRIES) {
    const oldest = store.keys().next();
    if (oldest.done) break;
    store.delete(oldest.value);
  }
}

export function has(key: string): boolean {
  return get(key) !== undefined;
}

export async function getOrFetch<T>(
  key: string,
  ttlMs: number,
  fetcher: () => Promise<T>,
): Promise<T> {
  const hit = get<T>(key);
  if (hit !== undefined) return hit;
  const value = await fetcher();
  set(key, value, ttlMs);
  return value;
}

export function clear(): void {
  store.clear();
}

export function size(): number {
  return store.size;
}
