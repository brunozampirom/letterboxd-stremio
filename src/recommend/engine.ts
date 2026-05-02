import { getOrFetch } from '../cache';
import { buildExclusionSet } from '../letterboxd/exclusion';
import { fetchSeedFilms, RssEntry } from '../letterboxd/rss';
import { fetchRecommendations, fetchSimilar, isConfigured, resolveImdbId } from '../tmdb/client';
import { mapPool } from '../util/pool';

const SIMILAR_FETCH_CONCURRENCY = 4;
const IMDB_RESOLVE_CONCURRENCY = 8;
const ENGINE_CACHE_TTL_MS = 6 * 60 * 60 * 1000;

const DEFAULT_MIN_RATING = 4.0;
const DEFAULT_MAX_RESULTS = 50;

export type Recommendation = {
  imdbId: string;
  score: number;
};

export function isEnabled(): boolean {
  return isConfigured();
}

async function expandSimilars(base: RssEntry[]): Promise<Map<string, number>> {
  const candidates = new Map<string, number>();

  await mapPool(base, SIMILAR_FETCH_CONCURRENCY, async (entry) => {
    const [similar, recs] = await Promise.all([
      fetchSimilar(entry.tmdbId),
      fetchRecommendations(entry.tmdbId),
    ]);

    const seen = new Set<string>();
    const baseWeight = entry.rating ?? DEFAULT_MIN_RATING;
    const likedBoost = entry.liked === true ? 0.5 : 0;
    const weight = baseWeight + likedBoost;
    for (const r of [...similar, ...recs]) {
      if (r.tmdbId === entry.tmdbId) continue;
      if (seen.has(r.tmdbId)) continue;
      seen.add(r.tmdbId);
      candidates.set(r.tmdbId, (candidates.get(r.tmdbId) ?? 0) + weight);
    }
  });

  return candidates;
}

async function resolveImdbIds(tmdbIds: string[]): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  await mapPool(tmdbIds, IMDB_RESOLVE_CONCURRENCY, async (tmdbId) => {
    const imdb = await resolveImdbId(tmdbId);
    if (imdb) map.set(tmdbId, imdb);
  });
  return map;
}

export async function recommend(
  username: string,
  opts: { minRating?: number; maxResults?: number } = {},
): Promise<Recommendation[]> {
  const minRating = opts.minRating ?? DEFAULT_MIN_RATING;
  const maxResults = opts.maxResults ?? DEFAULT_MAX_RESULTS;
  if (!isConfigured()) return [];

  return getOrFetch(`recommend:${username}:${minRating}:${maxResults}`, ENGINE_CACHE_TTL_MS, async () => {
    const baseEntries = await fetchSeedFilms(username, minRating);
    if (baseEntries.length === 0) return [];

    const baseTmdbIds = new Set(baseEntries.map((e) => e.tmdbId));
    const [excludedImdb, candidateScores] = await Promise.all([
      buildExclusionSet(username),
      expandSimilars(baseEntries),
    ]);

    for (const baseId of baseTmdbIds) candidateScores.delete(baseId);

    const sorted = [...candidateScores.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, maxResults * 2);

    const tmdbIds = sorted.map(([id]) => id);
    const imdbMap = await resolveImdbIds(tmdbIds);

    const results: Recommendation[] = [];
    for (const [tmdbId, score] of sorted) {
      const imdbId = imdbMap.get(tmdbId);
      if (!imdbId) continue;
      if (excludedImdb.has(imdbId)) continue;
      results.push({ imdbId, score });
      if (results.length >= maxResults) break;
    }

    return results;
  });
}
