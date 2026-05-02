import { isEnabled as recommendationsEnabled } from '../recommend/engine';
import { StremioCatalog, StremioManifest, StremioType } from './types';

const VERSION = '0.1.0';

export const CATALOG_WATCHLIST = 'letterboxd-watchlist';
export const CATALOG_DIARY = 'letterboxd-diary';
export const CATALOG_RECOMMENDED = 'letterboxd-recommended';
export const CATALOG_LIST_PREFIX = 'letterboxd-list-';

const TYPES: StremioType[] = ['movie', 'series'];

export type ManifestOpts = {
  watchlist?: boolean;
  diary?: boolean;
  recommended?: boolean;
};

export const FLAG_RE = /^[wdr]{1,3}$/;

export function parseFlags(flags?: string): Required<ManifestOpts> {
  if (!flags) return { watchlist: true, diary: true, recommended: true };
  return {
    watchlist: flags.includes('w'),
    diary: flags.includes('d'),
    recommended: flags.includes('r'),
  };
}

function pair(id: string, baseName: string): StremioCatalog[] {
  return TYPES.map((type) => ({ type, id, name: baseName }));
}

export function buildManifest(username: string, opts: ManifestOpts = {}): StremioManifest {
  const want: Required<ManifestOpts> = {
    watchlist: opts.watchlist ?? true,
    diary: opts.diary ?? true,
    recommended: opts.recommended ?? true,
  };

  const catalogs: StremioCatalog[] = [];
  if (want.watchlist) {
    catalogs.push(...pair(CATALOG_WATCHLIST, `Letterboxd Watchlist – ${username}`));
  }
  if (want.diary) {
    catalogs.push(...pair(CATALOG_DIARY, `Letterboxd Diary – ${username}`));
  }
  if (want.recommended && recommendationsEnabled()) {
    catalogs.push(...pair(CATALOG_RECOMMENDED, `Letterboxd Recommended – ${username}`));
  }

  return {
    id: `community.letterboxd-stremio.${username}`,
    version: VERSION,
    name: `Letterboxd – ${username}`,
    description: `Catalogs from letterboxd.com/${username}`,
    resources: ['catalog'],
    types: ['movie', 'series'],
    idPrefixes: ['tt'],
    catalogs,
    behaviorHints: { configurable: true, configurationRequired: false },
  };
}
