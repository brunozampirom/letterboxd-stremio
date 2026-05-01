import { getOrFetch } from '../cache/memory';
import { StremioType } from './types';

const CINEMETA_BASE = 'https://v3-cinemeta.strem.io';
const CINEMETA_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export type CinemetaMeta = {
  name?: string;
  poster?: string;
  background?: string;
  description?: string;
  imdbRating?: string;
  releaseInfo?: string;
  genres?: string[];
};

export type ClassifiedMeta = {
  type: StremioType;
  meta: CinemetaMeta;
};

async function fetchOne(imdbId: string, type: StremioType): Promise<CinemetaMeta | null> {
  try {
    const res = await fetch(`${CINEMETA_BASE}/meta/${type}/${imdbId}.json`);
    if (!res.ok) return null;
    const data = (await res.json()) as { meta?: CinemetaMeta };
    return data.meta ?? null;
  } catch {
    return null;
  }
}

export async function classifyAndEnrich(imdbId: string): Promise<ClassifiedMeta | null> {
  return getOrFetch(`cinemeta:${imdbId}`, CINEMETA_TTL_MS, async () => {
    const [movie, series] = await Promise.all([
      fetchOne(imdbId, 'movie'),
      fetchOne(imdbId, 'series'),
    ]);
    if (movie?.poster) return { type: 'movie', meta: movie };
    if (series?.poster) return { type: 'series', meta: series };
    if (movie) return { type: 'movie', meta: movie };
    if (series) return { type: 'series', meta: series };
    return null;
  });
}
