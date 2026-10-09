import { getOrFetch, warm } from '../cache';
import { fetchPage } from './http';

export type FilmIds = {
  imdbId?: string;
  tmdbId?: string;
};

const FILM_ID_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const key = (slug: string) => `filmIds:${slug}`;

const IMDB_RE = /imdb\.com\/title\/(tt\d+)/i;
const TMDB_RE = /themoviedb\.org\/(?:movie|tv)\/(\d+)/i;
const TMDB_DATA_ATTR_RE = /data-tmdb-id="(\d+)"/i;

export function parseFilmIds(html: string): FilmIds {
  const imdb = html.match(IMDB_RE);
  const tmdbAttr = html.match(TMDB_DATA_ATTR_RE);
  const tmdbLink = html.match(TMDB_RE);
  return {
    imdbId: imdb?.[1],
    tmdbId: tmdbAttr?.[1] ?? tmdbLink?.[1],
  };
}

// Pulls every slug into the process-local cache with one Upstash
// command. Callers that resolve a whole list must call this first,
// otherwise the fan-out below costs one command per film.
export async function warmFilmIds(slugs: readonly string[]): Promise<void> {
  await warm(slugs.map(key), FILM_ID_TTL_MS);
}

export async function resolveFilmIds(slug: string): Promise<FilmIds> {
  return getOrFetch(key(slug), FILM_ID_TTL_MS, async () => {
    const html = await fetchPage(`/film/${slug}/`);
    return parseFilmIds(html);
  });
}
