import { getOrFetch } from '../cache';

const TMDB_BASE = 'https://api.themoviedb.org/3';
const SIMILAR_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const IMDB_LOOKUP_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export type TmdbSimilarResult = {
  tmdbId: string;
  title?: string;
  voteAverage?: number;
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
  }>;
};

export async function fetchSimilar(tmdbId: string): Promise<TmdbSimilarResult[]> {
  return getOrFetch(`tmdb:similar:${tmdbId}`, SIMILAR_TTL_MS, async () => {
    const data = await tmdbGet<TmdbListResponse>(`/movie/${tmdbId}/similar?language=en-US&page=1`);
    if (!data?.results) return [];
    return data.results.map((r) => ({
      tmdbId: String(r.id),
      title: r.title,
      voteAverage: r.vote_average,
    }));
  });
}

export async function fetchRecommendations(tmdbId: string): Promise<TmdbSimilarResult[]> {
  return getOrFetch(`tmdb:recs:${tmdbId}`, SIMILAR_TTL_MS, async () => {
    const data = await tmdbGet<TmdbListResponse>(
      `/movie/${tmdbId}/recommendations?language=en-US&page=1`,
    );
    if (!data?.results) return [];
    return data.results.map((r) => ({
      tmdbId: String(r.id),
      title: r.title,
      voteAverage: r.vote_average,
    }));
  });
}

type TmdbExternalIds = {
  imdb_id?: string;
};

export async function resolveImdbId(tmdbId: string): Promise<string | null> {
  return getOrFetch(`tmdb:imdb:${tmdbId}`, IMDB_LOOKUP_TTL_MS, async () => {
    const data = await tmdbGet<TmdbExternalIds>(`/movie/${tmdbId}/external_ids`);
    return data?.imdb_id ?? null;
  });
}
