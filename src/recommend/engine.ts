import { cacheIfNonEmpty, getOrFetch } from '../cache';
import { buildExclusionSet } from '../letterboxd/exclusion';
import { resolveFilmIds } from '../letterboxd/film';
import { fetchSeedFilms, RssEntry } from '../letterboxd/rss';
import { fetchWatchlist } from '../letterboxd/scraper';
import { LetterboxdFilm } from '../letterboxd/types';
import {
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

// Quality threshold for TMDB candidates. Loosened compared to the
// initial cut so the catalog has more breathing room — the mainstream
// penalty below already trims the obvious classics, so we don't need
// to throw out indie/cult picks at the candidate stage too.
const MIN_VOTE_AVERAGE = 6.0;
const MIN_VOTE_COUNT = 50;

// Per-source weights. Recommendations is collaborative-filtered
// ("users who watched this also watched") and tends to be a stronger
// signal than similar (metadata-based).
const SIMILAR_WEIGHT = 0.8;
const RECOMMENDATIONS_WEIGHT = 1.2;

// Mainstream penalty. The same handful of all-time-classic films
// (Shawshank, Godfather, etc.) appear as similar/recommended for
// almost every drama and drown out genuinely surprising picks. Films
// with a lot of TMDB votes get their score attenuated so films most
// people have seen don't camp the top of the catalog. Capped at a
// 50% reduction so a strong signal still wins.
const MAINSTREAM_PENALTY_FLOOR = 5000;
const MAINSTREAM_PENALTY_FACTOR = 0.25;
const MAINSTREAM_PENALTY_MIN = 0.5;

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

function mainstreamMultiplier(voteCount?: number): number {
  if (!voteCount || voteCount <= MAINSTREAM_PENALTY_FLOOR) return 1;
  const ratio = voteCount / MAINSTREAM_PENALTY_FLOOR;
  const reduction = MAINSTREAM_PENALTY_FACTOR * Math.log10(ratio);
  return Math.max(MAINSTREAM_PENALTY_MIN, 1 - reduction);
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
  const raw = baseContribution + matches * GENRE_BONUS_PER_MATCH;
  const contribution = raw * mainstreamMultiplier(r.voteCount);
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
    return await computeRecommendations(username, minRating, maxResults);
  }, cacheIfNonEmpty);
}

async function computeRecommendations(
  username: string,
  minRating: number,
  maxResults: number,
): Promise<Recommendation[]> {
  try {
    const [baseEntries, watchlist, excludedImdb] = await Promise.all([
      fetchSeedFilms(username, minRating).catch(() => []),
      fetchWatchlist(username).catch(() => []),
      buildExclusionSet(username).catch(() => new Set<string>()),
    ]);
    if (baseEntries.length === 0) return [];

    const baseTmdbIds = new Set(baseEntries.map((e) => e.tmdbId));
    const preferredGenres = await buildPreferredGenres(baseEntries, watchlist).catch(
      () => new Set<number>(),
    );

    const candidateScores = await expandSimilars(baseEntries, preferredGenres);

    for (const baseId of baseTmdbIds) candidateScores.delete(baseId);

    const sorted = [...candidateScores.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, Math.ceil(maxResults * 2.5));

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
}
