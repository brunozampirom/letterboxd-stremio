import { getOrFetch } from '../cache';
import { buildExclusionSet } from '../letterboxd/exclusion';
import { fetchSeedFilms, RssEntry } from '../letterboxd/rss';
import {
  fetchMovieDetails,
  fetchRecommendations,
  fetchSimilar,
  isConfigured,
} from '../tmdb/client';
import { mapPool } from '../util/pool';

const SIMILAR_FETCH_CONCURRENCY = 4;
const DETAILS_FETCH_CONCURRENCY = 8;
const ENGINE_CACHE_TTL_MS = 6 * 60 * 60 * 1000;

const DEFAULT_MIN_RATING = 4.0;
const DEFAULT_MAX_RESULTS = 50;

// Quality threshold for TMDB candidates. TMDB's similar/recommendations
// endpoints regularly return obscure or low-rated titles; filtering by
// vote_average and vote_count drops the worst noise without throwing
// out cult/indie picks.
const MIN_VOTE_AVERAGE = 6.5;
const MIN_VOTE_COUNT = 100;

// Genre overlap boost. Each candidate that shares a "preferred" genre
// (one common across the user's seed films) gets +GENRE_BONUS_PER_MATCH
// added to its aggregate score, up to MAX_GENRE_MATCH genres.
const GENRE_BONUS_PER_MATCH = 0.4;
const MAX_GENRE_MATCH = 3;
// A genre is considered "preferred" if it shows up in at least this
// fraction of the user's seed films. With ~20 seeds and threshold 0.3,
// a genre needs to appear in 6+ films to count.
const PREFERRED_GENRE_THRESHOLD = 0.3;

export type Recommendation = {
  imdbId: string;
  score: number;
};

export function isEnabled(): boolean {
  return isConfigured();
}

// Non-linear weighting: a 5-star film should drive recommendations
// significantly harder than a 4-star one. Below 4 stars contributes
// nothing (the seed filter excludes those anyway). A "liked" film
// without a rating is treated like a soft 4.5.
function seedWeight(entry: RssEntry): number {
  const ratingScore = entry.rating ? Math.max(0, (entry.rating - 3) * 1.5) : 0;
  const likedBoost = entry.liked === true ? 1.5 : 0;
  return Math.max(ratingScore + likedBoost, 1);
}

async function buildPreferredGenres(base: RssEntry[]): Promise<Set<number>> {
  if (base.length === 0) return new Set();
  const freq = new Map<number, number>();
  await mapPool(base, DETAILS_FETCH_CONCURRENCY, async (entry) => {
    const details = await fetchMovieDetails(entry.tmdbId);
    if (!details) return;
    for (const gid of details.genreIds) {
      freq.set(gid, (freq.get(gid) ?? 0) + 1);
    }
  });
  const minCount = Math.max(2, base.length * PREFERRED_GENRE_THRESHOLD);
  return new Set(
    [...freq.entries()]
      .filter(([, count]) => count >= minCount)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([gid]) => gid),
  );
}

async function expandSimilars(
  base: RssEntry[],
  preferredGenres: Set<number>,
): Promise<Map<string, number>> {
  const candidates = new Map<string, number>();

  await mapPool(base, SIMILAR_FETCH_CONCURRENCY, async (entry) => {
    const [similar, recs] = await Promise.all([
      fetchSimilar(entry.tmdbId),
      fetchRecommendations(entry.tmdbId),
    ]);

    const seenForEntry = new Set<string>();
    const weight = seedWeight(entry);

    for (const r of [...similar, ...recs]) {
      if (r.tmdbId === entry.tmdbId) continue;
      if (seenForEntry.has(r.tmdbId)) continue;
      seenForEntry.add(r.tmdbId);

      // Quality filter — drop low-rated or obscure candidates.
      if ((r.voteAverage ?? 0) < MIN_VOTE_AVERAGE) continue;
      if ((r.voteCount ?? 0) < MIN_VOTE_COUNT) continue;

      // Base contribution from the seed.
      let contribution = weight;

      // Genre overlap boost.
      if (preferredGenres.size > 0 && r.genreIds.length > 0) {
        let matches = 0;
        for (const gid of r.genreIds) {
          if (preferredGenres.has(gid) && ++matches >= MAX_GENRE_MATCH) break;
        }
        contribution += matches * GENRE_BONUS_PER_MATCH;
      }

      candidates.set(r.tmdbId, (candidates.get(r.tmdbId) ?? 0) + contribution);
    }
  });

  return candidates;
}

async function resolveImdbIds(tmdbIds: string[]): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  await mapPool(tmdbIds, DETAILS_FETCH_CONCURRENCY, async (tmdbId) => {
    const details = await fetchMovieDetails(tmdbId);
    if (details?.imdbId) map.set(tmdbId, details.imdbId);
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
    const [excludedImdb, preferredGenres] = await Promise.all([
      buildExclusionSet(username),
      buildPreferredGenres(baseEntries),
    ]);

    const candidateScores = await expandSimilars(baseEntries, preferredGenres);
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
