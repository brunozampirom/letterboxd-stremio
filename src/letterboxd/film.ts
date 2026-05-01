import { getOrFetch } from '../cache/memory';
import { fetchPage } from './http';

export type FilmIds = {
  imdbId?: string;
  tmdbId?: string;
};

const FILM_ID_TTL_MS = 7 * 24 * 60 * 60 * 1000;

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

export async function resolveFilmIds(slug: string): Promise<FilmIds> {
  return getOrFetch(`filmIds:${slug}`, FILM_ID_TTL_MS, async () => {
    const html = await fetchPage(`/film/${slug}/`);
    return parseFilmIds(html);
  });
}
