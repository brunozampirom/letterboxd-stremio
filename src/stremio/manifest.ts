import { CURATED_FLAGS, CURATED_LISTS } from '../curated/lists';
import { isEnabled as recommendationsEnabled } from '../recommend/engine';
import { StremioCatalog, StremioManifest, StremioType } from './types';

const VERSION = '0.1.0';

export const CATALOG_WATCHLIST = 'letterboxd-watchlist';
export const CATALOG_DIARY = 'letterboxd-diary';
export const CATALOG_RECOMMENDED = 'letterboxd-recommended';
export const CATALOG_LIST_PREFIX = 'letterboxd-list-';
export const CATALOG_CURATED_PREFIX = 'letterboxd-curated-';

const TYPES: StremioType[] = ['movie', 'series'];

export type ManifestOpts = {
  watchlist?: boolean;
  diary?: boolean;
  recommended?: boolean;
  curated?: Set<string>; // set of CuratedList.id values to include
};

export const FLAG_RE = new RegExp(`^[wdr${CURATED_FLAGS}]{1,${3 + CURATED_FLAGS.length}}$`);

const FLAG_TO_CURATED_ID = new Map(CURATED_LISTS.map((l) => [l.flag, l.id]));

export function parseFlags(flags?: string): Required<ManifestOpts> {
  if (!flags) {
    return {
      watchlist: true,
      diary: true,
      recommended: true,
      curated: new Set(CURATED_LISTS.map((l) => l.id)),
    };
  }
  const curated = new Set<string>();
  for (const ch of flags) {
    const id = FLAG_TO_CURATED_ID.get(ch);
    if (id) curated.add(id);
  }
  return {
    watchlist: flags.includes('w'),
    diary: flags.includes('d'),
    recommended: flags.includes('r'),
    curated,
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
    curated: opts.curated ?? new Set(CURATED_LISTS.map((l) => l.id)),
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
  for (const list of CURATED_LISTS) {
    if (want.curated.has(list.id)) {
      catalogs.push(...pair(`${CATALOG_CURATED_PREFIX}${list.id}`, `${list.name} – Unwatched`));
    }
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
