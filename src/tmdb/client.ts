import { getOrFetch } from '../cache';

const TMDB_BASE = 'https://api.themoviedb.org/3';
const SIMILAR_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const DETAILS_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export type TmdbSimilarResult = {
  tmdbId: string;
  title?: string;
  voteAverage?: number;
  voteCount?: number;
  genreIds: number[];
};

export type TmdbMovieDetails = {
  tmdbId: string;
  imdbId?: string;
  voteAverage?: number;
  voteCount?: number;
  genreIds: number[];
};

export function isConfigured(): boolean {
  return Boolean(process.env.TMDB_READ_TOKEN);
}

async function tmdbGet<T>(path: string): Promise<T | null> {
  const token = process.env.TMDB_READ_TOKEN;
  if (!token) return null;
  try {
    const res = await fetch(`${TMDB_BASE}${path}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
      },
    });
    if (!res.ok) {
      console.warn(`[tmdb] ${res.status} on ${path}`);
      return null;
    }
    return (await res.json()) as T;
  } catch (err) {
    console.warn('[tmdb] fetch failed:', err);
    return null;
  }
}

type TmdbListResponse = {
  results?: Array<{
    id: number;
    title?: string;
    vote_average?: number;
    vote_count?: number;
    genre_ids?: number[];
  }>;
};

function mapList(data: TmdbListResponse | null): TmdbSimilarResult[] {
  if (!data?.results) return [];
  return data.results.map((r) => ({
    tmdbId: String(r.id),
    title: r.title,
    voteAverage: r.vote_average,
    voteCount: r.vote_count,
    genreIds: r.genre_ids ?? [],
  }));
}

export async function fetchSimilar(tmdbId: string): Promise<TmdbSimilarResult[]> {
  return getOrFetch(`tmdb:similar:${tmdbId}`, SIMILAR_TTL_MS, async () => {
    const data = await tmdbGet<TmdbListResponse>(`/movie/${tmdbId}/similar?language=en-US&page=1`);
    return mapList(data);
  });
}

export async function fetchRecommendations(tmdbId: string): Promise<TmdbSimilarResult[]> {
  return getOrFetch(`tmdb:recs:${tmdbId}`, SIMILAR_TTL_MS, async () => {
    const data = await tmdbGet<TmdbListResponse>(
      `/movie/${tmdbId}/recommendations?language=en-US&page=1`,
    );
    return mapList(data);
  });
}

export async function fetchDiscoverByGenre(genreId: number): Promise<TmdbSimilarResult[]> {
  return getOrFetch(`tmdb:discover:${genreId}`, SIMILAR_TTL_MS, async () => {
    const data = await tmdbGet<TmdbListResponse>(
      `/discover/movie?language=en-US&with_genres=${genreId}&sort_by=vote_average.desc&vote_count.gte=500&page=1`,
    );
    return mapList(data);
  });
}

type TmdbDetailsResponse = {
  id?: number;
  vote_average?: number;
  vote_count?: number;
  genres?: Array<{ id: number; name?: string }>;
  external_ids?: { imdb_id?: string };
};

export async function fetchMovieDetails(tmdbId: string): Promise<TmdbMovieDetails | null> {
  return getOrFetch(`tmdb:details:${tmdbId}`, DETAILS_TTL_MS, async () => {
    const data = await tmdbGet<TmdbDetailsResponse>(
      `/movie/${tmdbId}?append_to_response=external_ids&language=en-US`,
    );
    if (!data) return null;
    return {
      tmdbId,
      imdbId: data.external_ids?.imdb_id ?? undefined,
      voteAverage: data.vote_average,
      voteCount: data.vote_count,
      genreIds: (data.genres ?? []).map((g) => g.id),
    };
  });
}

export async function resolveImdbId(tmdbId: string): Promise<string | null> {
  const details = await fetchMovieDetails(tmdbId);
  return details?.imdbId ?? null;
}
