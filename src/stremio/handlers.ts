import { CURATED_LISTS } from '../curated/lists';
import { buildExclusionSet } from '../letterboxd/exclusion';
import { resolveFilmIds } from '../letterboxd/film';
import {
  fetchDiary,
  fetchListFilms,
  fetchWatchlist,
} from '../letterboxd/scraper';
import { LetterboxdFilm } from '../letterboxd/types';
import { recommend } from '../recommend/engine';
import { mapPool } from '../util/pool';
import { classifyAndEnrich } from './cinemeta';
import {
  CATALOG_CURATED_PREFIX,
  CATALOG_DIARY,
  CATALOG_LIST_PREFIX,
  CATALOG_RECOMMENDED,
  CATALOG_WATCHLIST,
} from './manifest';
import { CatalogResponse, StremioMetaPreview, StremioType } from './types';

const RESOLVE_CONCURRENCY = 6;
const ENRICH_CONCURRENCY = 8;
const CURATED_DISPLAY_LIMIT = 100;

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

  if (id === CATALOG_RECOMMENDED) {
    const recs = await recommend(username);
    const enriched = await mapPool(
      recs,
      ENRICH_CONCURRENCY,
      async ({ imdbId }): Promise<StremioMetaPreview | null> => {
        const classified = await classifyAndEnrich(imdbId);
        if (!classified || classified.type !== wantedType) return null;
        const m = classified.meta;
        return {
          id: imdbId,
          type: wantedType,
          name: m.name ?? imdbId,
          releaseInfo: m.releaseInfo,
          poster: m.poster,
          background: m.background,
          description: m.description,
          imdbRating: m.imdbRating,
        };
      },
    );
    return { metas: enriched.filter((m): m is StremioMetaPreview => m !== null) };
  }

  if (id.startsWith(CATALOG_CURATED_PREFIX)) {
    const listId = id.slice(CATALOG_CURATED_PREFIX.length);
    const list = CURATED_LISTS.find((l) => l.id === listId);
    if (!list) return { metas: [] };

    const [films, excluded] = await Promise.all([
      fetchListFilms(list.owner, list.slug),
      buildExclusionSet(username),
    ]);

    const withImdb = await mapPool(films, RESOLVE_CONCURRENCY, async (film) => {
      try {
        const ids = await resolveFilmIds(film.slug);
        if (!ids.imdbId) return null;
        if (excluded.has(ids.imdbId)) return null;
        return { film, imdbId: ids.imdbId };
      } catch {
        return null;
      }
    });

    const filtered = withImdb
      .filter((x): x is { film: LetterboxdFilm; imdbId: string } => x !== null)
      .slice(0, CURATED_DISPLAY_LIMIT);

    const enriched = await mapPool(
      filtered,
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
    return { metas: enriched.filter((m): m is StremioMetaPreview => m !== null) };
  }

  if (id.startsWith(CATALOG_LIST_PREFIX)) {
    const listSlug = id.slice(CATALOG_LIST_PREFIX.length);
    const films = await fetchListFilms(username, listSlug);
    return { metas: await filmsToMetas(films, wantedType) };
  }

  return { metas: [] };
}
