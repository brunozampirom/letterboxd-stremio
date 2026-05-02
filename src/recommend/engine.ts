import { cacheIfNonEmpty, getOrFetch } from '../cache';
import { buildExclusionSet } from '../letterboxd/exclusion';
import { resolveFilmIds } from '../letterboxd/film';
import { fetchSeedFilms, RssEntry } from '../letterboxd/rss';
import { fetchWatchlist } from '../letterboxd/scraper';
import { LetterboxdFilm } from '../letterboxd/types';
import {
  fetchMovieDetails,
  fetchRecentByGenre,
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
// 60% reduction so a strong signal still wins.
const MAINSTREAM_PENALTY_FLOOR = 2000;
const MAINSTREAM_PENALTY_FACTOR = 0.4;
const MAINSTREAM_PENALTY_MIN = 0.4;

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

// Watchlist films also act as recommendation seeds — finding films
// "in the same vibe" as what the user has marked as wanting to watch.
// They get a flat weight below a minimum-rated RSS seed (which is 1.5)
// because the user hasn't actually watched them yet, just expressed
// interest. Capped at WATCHLIST_SEED_SAMPLE entries to keep the cold
// path within the function timeout.
const WATCHLIST_SEED_WEIGHT = 0.6;
const WATCHLIST_SEED_SAMPLE = 30;

// Recent-films pool. For each preferred genre we pull TMDB's top
// recent (last 4 years) entries and feed them into the candidate pool.
// They get a meaningful contribution + the genre overlap bonus, but
// the engine also reserves a fixed cadence of "recent" slots in the
// final ranking so a few new films are guaranteed presence regardless
// of how their raw score stacks up against the seeded similars.
const RECENT_DISCOVER_WEIGHT = 1.5;
const RECENT_DISCOVER_LIMIT_PER_GENRE = 8;
const RECENT_YEAR_THRESHOLD = new Date().getFullYear() - 4;
// Out of every 6 final slots, reserve one for the highest-scoring
// recent candidate — about ~17% of the catalog.
const RECENT_SLOT_RATIO = 6;

export type Recommendation = {
  imdbId: string;
  score: number;
};

type Seed = { tmdbId: string; weight: number };

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

type CandidateScore = { score: number; releaseYear?: number };

function addCandidate(
  candidates: Map<string, CandidateScore>,
  r: TmdbSimilarResult,
  baseContribution: number,
  preferredGenres: Set<number>,
) {
  if (!passesQuality(r)) return;
  const matches = genreOverlap(r, preferredGenres);
  const raw = baseContribution + matches * GENRE_BONUS_PER_MATCH;
  const contribution = raw * mainstreamMultiplier(r.voteCount);
  const prev = candidates.get(r.tmdbId);
  candidates.set(r.tmdbId, {
    score: (prev?.score ?? 0) + contribution,
    // Keep the first non-undefined year we saw — release dates rarely
    // disagree across sources, and we only need it for slot bucketing.
    releaseYear: prev?.releaseYear ?? r.releaseYear,
  });
}

async function gatherSeeds(
  rssEntries: RssEntry[],
  watchlist: LetterboxdFilm[],
): Promise<Seed[]> {
  // RSS-derived seeds carry their rating-based weight.
  const byTmdbId = new Map<string, number>();
  for (const e of rssEntries) {
    byTmdbId.set(e.tmdbId, Math.max(byTmdbId.get(e.tmdbId) ?? 0, seedWeight(e)));
  }

  // Watchlist seeds. Capped at WATCHLIST_SEED_SAMPLE to bound the cold
  // start: each entry takes one Letterboxd page fetch (slug → tmdb)
  // plus the TMDB similar/recs round-trips later.
  const watchlistSample = watchlist.slice(0, WATCHLIST_SEED_SAMPLE);
  await mapPool(watchlistSample, DETAILS_FETCH_CONCURRENCY, async (film) => {
    try {
      const ids = await resolveFilmIds(film.slug);
      if (!ids.tmdbId) return;
      // If the film already came from RSS, keep the higher (RSS) weight.
      byTmdbId.set(
        ids.tmdbId,
        Math.max(byTmdbId.get(ids.tmdbId) ?? 0, WATCHLIST_SEED_WEIGHT),
      );
    } catch {
      /* ignore */
    }
  });

  return [...byTmdbId.entries()].map(([tmdbId, weight]) => ({ tmdbId, weight }));
}

async function expandSimilars(
  seeds: Seed[],
  preferredGenres: Set<number>,
): Promise<Map<string, CandidateScore>> {
  const candidates = new Map<string, CandidateScore>();

  await mapPool(seeds, SIMILAR_FETCH_CONCURRENCY, async ({ tmdbId, weight }) => {
    try {
      const [similar, recs] = await Promise.all([
        fetchSimilar(tmdbId).catch(() => []),
        fetchRecommendations(tmdbId).catch(() => []),
      ]);

      // Per-seed dedupe: take the higher of similar vs recs weighting
      // so the same film isn't counted twice from one seed but its
      // strongest signal (recs > similar) wins.
      const bestForEntry = new Map<string, { contribution: number; result: TmdbSimilarResult }>();

      for (const r of similar) {
        if (r.tmdbId === tmdbId) continue;
        if (!passesQuality(r)) continue;
        const c = weight * SIMILAR_WEIGHT;
        const prev = bestForEntry.get(r.tmdbId);
        if (!prev || c > prev.contribution) bestForEntry.set(r.tmdbId, { contribution: c, result: r });
      }
      for (const r of recs) {
        if (r.tmdbId === tmdbId) continue;
        if (!passesQuality(r)) continue;
        const c = weight * RECOMMENDATIONS_WEIGHT;
        const prev = bestForEntry.get(r.tmdbId);
        if (!prev || c > prev.contribution) bestForEntry.set(r.tmdbId, { contribution: c, result: r });
      }

      for (const { contribution, result } of bestForEntry.values()) {
        addCandidate(candidates, result, contribution, preferredGenres);
      }
    } catch (err) {
      console.warn(`[engine] expand seed ${tmdbId} failed:`, err);
    }
  });

  return candidates;
}

async function expandRecentByGenre(
  preferredGenres: Set<number>,
  candidates: Map<string, CandidateScore>,
): Promise<void> {
  if (preferredGenres.size === 0) return;
  await mapPool([...preferredGenres], 3, async (gid) => {
    try {
      const results = (await fetchRecentByGenre(gid)).slice(0, RECENT_DISCOVER_LIMIT_PER_GENRE);
      for (const r of results) {
        // Pass preferredGenres so a recent film that hits multiple
        // of the user's vibes (e.g. drama + thriller + crime) gets
        // the same overlap bonus that seed-driven candidates do.
        addCandidate(candidates, r, RECENT_DISCOVER_WEIGHT, preferredGenres);
      }
    } catch (err) {
      console.warn(`[engine] recent-by-genre ${gid} failed:`, err);
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

  // v5: recent films get a higher weight + genre-overlap bonus.
  return getOrFetch(`recommend:v5:${username}:${minRating}:${maxResults}`, ENGINE_CACHE_TTL_MS, async () => {
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
    // RSS-only or watchlist-only is fine; engine only bails when both
    // are empty (the user has no signal to recommend from).
    if (baseEntries.length === 0 && watchlist.length === 0) return [];

    const seeds = await gatherSeeds(baseEntries, watchlist);
    const seedTmdbIds = new Set(seeds.map((s) => s.tmdbId));
    const preferredGenres = await buildPreferredGenres(baseEntries, watchlist).catch(
      () => new Set<number>(),
    );

    const candidateScores = await expandSimilars(seeds, preferredGenres);
    await expandRecentByGenre(preferredGenres, candidateScores);

    for (const seedId of seedTmdbIds) candidateScores.delete(seedId);

    // Split candidates into "recent" and "older" pools, each sorted by
    // score; then interleave so every Nth final slot is reserved for
    // the next-best recent film. This gives recents reliable presence
    // without inflating their raw score (which would also pull
    // mainstream sequels along for the ride).
    const recentPool: { tmdbId: string; score: number }[] = [];
    const olderPool: { tmdbId: string; score: number }[] = [];
    for (const [tmdbId, c] of candidateScores) {
      const target =
        c.releaseYear !== undefined && c.releaseYear >= RECENT_YEAR_THRESHOLD ? recentPool : olderPool;
      target.push({ tmdbId, score: c.score });
    }
    recentPool.sort((a, b) => b.score - a.score);
    olderPool.sort((a, b) => b.score - a.score);

    const interleaved: { tmdbId: string; score: number }[] = [];
    let oi = 0;
    let ri = 0;
    while (interleaved.length < Math.ceil(maxResults * 2.5)) {
      const wantRecent = (interleaved.length + 1) % RECENT_SLOT_RATIO === 0 && ri < recentPool.length;
      if (wantRecent) {
        interleaved.push(recentPool[ri++]);
      } else if (oi < olderPool.length) {
        interleaved.push(olderPool[oi++]);
      } else if (ri < recentPool.length) {
        interleaved.push(recentPool[ri++]);
      } else {
        break;
      }
    }

    const tmdbIds = interleaved.map((c) => c.tmdbId);
    const imdbMap = await resolveImdbIds(tmdbIds);

    const results: Recommendation[] = [];
    for (const { tmdbId, score } of interleaved) {
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
