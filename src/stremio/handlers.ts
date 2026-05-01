import { resolveFilmIds } from '../letterboxd/film';
import {
  fetchDiary,
  fetchListFilms,
  fetchWatchlist,
} from '../letterboxd/scraper';
import { LetterboxdFilm } from '../letterboxd/types';
import { mapPool } from '../util/pool';
import { classifyAndEnrich } from './cinemeta';
import {
  CATALOG_DIARY,
  CATALOG_LIST_PREFIX,
  CATALOG_WATCHLIST,
} from './manifest';
import { CatalogResponse, StremioMetaPreview, StremioType } from './types';

const RESOLVE_CONCURRENCY = 6;
const ENRICH_CONCURRENCY = 8;

async function filmsToMetas(
  films: LetterboxdFilm[],
  wantedType: StremioType,
): Promise<StremioMetaPreview[]> {
  const withImdb = await mapPool(films, RESOLVE_CONCURRENCY, async (film) => {
    try {
      const ids = await resolveFilmIds(film.slug);
      if (!ids.imdbId) return null;
      return { film, imdbId: ids.imdbId };
    } catch {
      return null;
    }
  });

  const enriched = await mapPool(
    withImdb.filter((x): x is { film: LetterboxdFilm; imdbId: string } => x !== null),
    ENRICH_CONCURRENCY,
    async ({ film, imdbId }): Promise<StremioMetaPreview | null> => {
      const classified = await classifyAndEnrich(imdbId);
      if (!classified || classified.type !== wantedType) return null;
      const m = classified.meta;
      return {
        id: imdbId,
        type: wantedType,
        name: film.title || m.name || imdbId,
        releaseInfo: film.year ? String(film.year) : m.releaseInfo,
        poster: m.poster,
        background: m.background,
        description: m.description,
        imdbRating: m.imdbRating,
      };
    },
  );

  return enriched.filter((m): m is StremioMetaPreview => m !== null);
}

export async function handleCatalog(
  username: string,
  type: string,
  id: string,
): Promise<CatalogResponse> {
  if (type !== 'movie' && type !== 'series') return { metas: [] };
  const wantedType = type;

  if (id === CATALOG_WATCHLIST) {
    const films = await fetchWatchlist(username);
    return { metas: await filmsToMetas(films, wantedType) };
  }

  if (id === CATALOG_DIARY) {
    const films = await fetchDiary(username);
    return { metas: await filmsToMetas(films, wantedType) };
  }

  if (id.startsWith(CATALOG_LIST_PREFIX)) {
    const listSlug = id.slice(CATALOG_LIST_PREFIX.length);
    const films = await fetchListFilms(username, listSlug);
    return { metas: await filmsToMetas(films, wantedType) };
  }

  return { metas: [] };
}
