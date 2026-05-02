export type CuratedList = {
  id: string;
  flag: string;
  owner: string;
  slug: string;
  name: string;
  description: string;
};

// Each curated list ships with a single-character flag used in the URL
// configuration segment (e.g. /<user>/wdrt/manifest.json -> include flag "t").
// Flags must be unique across this array AND must not collide with the
// reserved core flags w (watchlist), d (diary), or r (recommended).
export const CURATED_LISTS: ReadonlyArray<CuratedList> = [
  {
    id: 'top500',
    flag: 't',
    owner: 'official',
    slug: 'letterboxds-top-500-films',
    name: "Letterboxd's Top 500",
    description: 'Highest-rated narrative features on Letterboxd, filtered by what you haven\'t seen.',
  },
];

export const CURATED_FLAGS = CURATED_LISTS.map((l) => l.flag).join('');
