import { StremioCatalog, StremioManifest, StremioType } from './types';

const VERSION = '0.1.0';

export const CATALOG_WATCHLIST = 'letterboxd-watchlist';
export const CATALOG_DIARY = 'letterboxd-diary';
export const CATALOG_LIST_PREFIX = 'letterboxd-list-';

const TYPES: StremioType[] = ['movie', 'series'];

function pair(id: string, baseName: string): StremioCatalog[] {
  return TYPES.map((type) => ({ type, id, name: baseName }));
}

export function buildManifest(username: string): StremioManifest {
  const catalogs: StremioCatalog[] = [
    ...pair(CATALOG_WATCHLIST, `Letterboxd Watchlist – ${username}`),
    ...pair(CATALOG_DIARY, `Letterboxd Diary – ${username}`),
  ];

  return {
    id: `community.letterboxd-stremio.${username}`,
    version: VERSION,
    name: `Letterboxd – ${username}`,
    description: `Watchlist, diary, and lists from letterboxd.com/${username}`,
    resources: ['catalog'],
    types: ['movie', 'series'],
    idPrefixes: ['tt'],
    catalogs,
    behaviorHints: { configurable: true, configurationRequired: false },
  };
}
