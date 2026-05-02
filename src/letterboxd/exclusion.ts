import { cacheIfNonEmpty, getOrFetch } from '../cache';
import { mapPool } from '../util/pool';
import { resolveImdbId as tmdbResolveImdbId } from '../tmdb/client';
import { resolveFilmIds } from './film';
import { fetchRssEntries } from './rss';
import { fetchDiary, fetchWatchlist } from './scraper';

const EXCLUSION_TTL_MS = 30 * 60 * 1000;
const RESOLVE_CONCURRENCY = 8;

// We cache an array (not a Set) because Redis JSON serialization
// loses Set semantics — it round-trips as `{}` and the consumer ends
// up calling .has on a plain object. Callers that need a Set wrap the
// array on read.
async function buildExclusionList(username: string): Promise<string[]> {
  return getOrFetch(
    `exclusion:${username}`,
    EXCLUSION_TTL_MS,
    async () => {
      const [watchlist, diary, rss] = await Promise.all([
        fetchWatchlist(username).catch(() => []),
        fetchDiary(username).catch(() => []),
        fetchRssEntries(username).catch(() => []),
      ]);

      const seen = new Set<string>();

      await mapPool([...watchlist, ...diary], RESOLVE_CONCURRENCY, async (film) => {
        try {
          const ids = await resolveFilmIds(film.slug);
          if (ids.imdbId) seen.add(ids.imdbId);
        } catch {
          /* ignore */
        }
      });

      await mapPool(rss, RESOLVE_CONCURRENCY, async (entry) => {
        try {
          const imdbId = await tmdbResolveImdbId(entry.tmdbId);
          if (imdbId) seen.add(imdbId);
        } catch {
          /* ignore */
        }
      });

      return [...seen];
    },
    cacheIfNonEmpty,
  );
}

export async function buildExclusionSet(username: string): Promise<Set<string>> {
  return new Set(await buildExclusionList(username));
}
