type Entry<T> = {
  value: T;
  expiresAt: number;
};

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
  store.set(key, { value, expiresAt: Date.now() + ttlMs });
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
