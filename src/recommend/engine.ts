import { getOrFetch } from '../cache';
import { buildExclusionSet } from '../letterboxd/exclusion';
import { resolveFilmIds } from '../letterboxd/film';
import { fetchSeedFilms, RssEntry } from '../letterboxd/rss';
import { fetchWatchlist } from '../letterboxd/scraper';
import { LetterboxdFilm } from '../letterboxd/types';
import {
  fetchDiscoverByGenre,
  fetchMovieDetails,
  fetchRecommendations,
  fetchSimilar,
  isConfigured,
  TmdbSimilarResult,
} from '../tmdb/client';
import { mapPool } from '../util/pool';

const SIMILAR_FETCH_CONCURRENCY = 4;
const DETAILS_FETCH_CONCURRENCY = 8;
const ENGINE_CACHE_TTL_MS = 6 * 60 * 60 * 1000;

const DEFAULT_MIN_RATING = 4.0;
const DEFAULT_MAX_RESULTS = 100;

// Quality threshold for TMDB candidates.
const MIN_VOTE_AVERAGE = 6.5;
const MIN_VOTE_COUNT = 100;

// Per-source weights. Recommendations is collaborative-filtered
// ("users who watched this also watched") and tends to be a stronger
// signal than similar (metadata-based).
const SIMILAR_WEIGHT = 0.8;
const RECOMMENDATIONS_WEIGHT = 1.2;
// Discover is the broadest source (TMDB's top of a genre); kept low
// so it diversifies the pool without dominating it.
const DISCOVER_WEIGHT_PER_MATCH = 0.3;

// Genre overlap boost on candidates.
const GENRE_BONUS_PER_MATCH = 0.4;
const MAX_GENRE_MATCH = 3;
// A genre is considered "preferred" if it shows up frequently across
// the user's seed films and watchlist (combined, weighted).
const PREFERRED_GENRE_THRESHOLD = 0.3;
const PREFERRED_GENRE_LIMIT = 6;
// Watchlist counts at half a seed when computing preferred genres
// (intent vs. positive endorsement).
const WATCHLIST_GENRE_WEIGHT = 0.5;
// Cap how many watchlist entries influence the preferred genre set.
// More than this rarely changes the ranking but adds linear cost
// (one Letterboxd page fetch + one TMDB details call per entry).
const WATCHLIST_GENRE_SAMPLE = 25;

export type Recommendation = {
  imdbId: string;
  score: number;
};

export function isEnabled(): boolean {
  return isConfigured();
}

function seedWeight(entry: RssEntry): number {
  const ratingScore = entry.rating ? Math.max(0, (entry.rating - 3) * 1.5) : 0;
  const likedBoost = entry.liked === true ? 1.5 : 0;
  return Math.max(ratingScore + likedBoost, 1);
}

function passesQuality(r: TmdbSimilarResult): boolean {
  if ((r.voteAverage ?? 0) < MIN_VOTE_AVERAGE) return false;
  if ((r.voteCount ?? 0) < MIN_VOTE_COUNT) return false;
  return true;
}

function genreOverlap(candidate: TmdbSimilarResult, preferred: Set<number>): number {
  if (preferred.size === 0 || candidate.genreIds.length === 0) return 0;
  let matches = 0;
  for (const gid of candidate.genreIds) {
    if (preferred.has(gid) && ++matches >= MAX_GENRE_MATCH) break;
  }
  return matches;
}

async function buildPreferredGenres(
  seeds: RssEntry[],
  watchlist: LetterboxdFilm[],
): Promise<Set<number>> {
  const freq = new Map<number, number>();

  await mapPool(seeds, DETAILS_FETCH_CONCURRENCY, async (entry) => {
    try {
      const details = await fetchMovieDetails(entry.tmdbId);
      if (!details) return;
      for (const gid of details.genreIds) {
        freq.set(gid, (freq.get(gid) ?? 0) + 1);
      }
    } catch (err) {
      console.warn(`[engine] preferred genres seed ${entry.tmdbId} failed:`, err);
    }
  });

  const watchlistSample = watchlist.slice(0, WATCHLIST_GENRE_SAMPLE);
  await mapPool(watchlistSample, DETAILS_FETCH_CONCURRENCY, async (film) => {
    try {
      const ids = await resolveFilmIds(film.slug);
      if (!ids.tmdbId) return;
      const details = await fetchMovieDetails(ids.tmdbId);
      if (!details) return;
      for (const gid of details.genreIds) {
        freq.set(gid, (freq.get(gid) ?? 0) + WATCHLIST_GENRE_WEIGHT);
      }
    } catch {
      /* ignore */
    }
  });

  const totalWeight = seeds.length + watchlistSample.length * WATCHLIST_GENRE_WEIGHT;
  if (totalWeight === 0) return new Set();
  const minCount = Math.max(2, totalWeight * PREFERRED_GENRE_THRESHOLD);
  return new Set(
    [...freq.entries()]
      .filter(([, count]) => count >= minCount)
      .sort((a, b) => b[1] - a[1])
      .slice(0, PREFERRED_GENRE_LIMIT)
      .map(([gid]) => gid),
  );
}

function addCandidate(
  candidates: Map<string, number>,
  r: TmdbSimilarResult,
  baseContribution: number,
  preferredGenres: Set<number>,
) {
  if (!passesQuality(r)) return;
  const matches = genreOverlap(r, preferredGenres);
  const contribution = baseContribution + matches * GENRE_BONUS_PER_MATCH;
  candidates.set(r.tmdbId, (candidates.get(r.tmdbId) ?? 0) + contribution);
}

async function expandSimilars(
  base: RssEntry[],
  preferredGenres: Set<number>,
): Promise<Map<string, number>> {
  const candidates = new Map<string, number>();

  await mapPool(base, SIMILAR_FETCH_CONCURRENCY, async (entry) => {
    try {
      const [similar, recs] = await Promise.all([
        fetchSimilar(entry.tmdbId).catch(() => []),
        fetchRecommendations(entry.tmdbId).catch(() => []),
      ]);
      const weight = seedWeight(entry);

      // Per-seed dedupe: take the higher of similar vs recs weighting
      // so the same film isn't counted twice from one seed but its
      // strongest signal (recs > similar) wins.
      const bestForEntry = new Map<string, { contribution: number; result: TmdbSimilarResult }>();

      for (const r of similar) {
        if (r.tmdbId === entry.tmdbId) continue;
        if (!passesQuality(r)) continue;
        const c = weight * SIMILAR_WEIGHT;
        const prev = bestForEntry.get(r.tmdbId);
        if (!prev || c > prev.contribution) bestForEntry.set(r.tmdbId, { contribution: c, result: r });
      }
      for (const r of recs) {
        if (r.tmdbId === entry.tmdbId) continue;
        if (!passesQuality(r)) continue;
        const c = weight * RECOMMENDATIONS_WEIGHT;
        const prev = bestForEntry.get(r.tmdbId);
        if (!prev || c > prev.contribution) bestForEntry.set(r.tmdbId, { contribution: c, result: r });
      }

      for (const { contribution, result } of bestForEntry.values()) {
        addCandidate(candidates, result, contribution, preferredGenres);
      }
    } catch (err) {
      console.warn(`[engine] expand seed ${entry.tmdbId} failed:`, err);
    }
  });

  return candidates;
}

async function expandDiscover(
  preferredGenres: Set<number>,
  candidates: Map<string, number>,
): Promise<void> {
  if (preferredGenres.size === 0) return;
  const seenForDiscover = new Set<string>();
  await mapPool([...preferredGenres], 3, async (gid) => {
    try {
      const results = await fetchDiscoverByGenre(gid);
      for (const r of results) {
        if (seenForDiscover.has(r.tmdbId)) continue;
        seenForDiscover.add(r.tmdbId);
        // Discover already filters by genre, so we don't add the
        // genre-overlap bonus on top of the discover weight (would
        // double-count). Use a flat per-match contribution.
        addCandidate(candidates, r, DISCOVER_WEIGHT_PER_MATCH, new Set());
      }
    } catch (err) {
      console.warn(`[engine] discover genre ${gid} failed:`, err);
    }
  });
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
    try {
      const [baseEntries, watchlist, excludedImdb] = await Promise.all([
        fetchSeedFilms(username, minRating).catch(() => []),
        fetchWatchlist(username).catch(() => []),
        buildExclusionSet(username).catch(() => new Set<string>()),
      ]);
      if (baseEntries.length === 0) return [];

      const baseTmdbIds = new Set(baseEntries.map((e) => e.tmdbId));
      const preferredGenres = await buildPreferredGenres(baseEntries, watchlist).catch(() => new Set<number>());

      const candidateScores = await expandSimilars(baseEntries, preferredGenres);
      await expandDiscover(preferredGenres, candidateScores);

      for (const baseId of baseTmdbIds) candidateScores.delete(baseId);

      const sorted = [...candidateScores.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, Math.ceil(maxResults * 1.5));

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
    } catch (err) {
      console.error('[recommend] engine failed:', err);
      return [];
    }
  });
}
