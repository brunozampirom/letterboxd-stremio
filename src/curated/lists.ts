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
    description: 'Highest-rated narrative features on Letterboxd.',
  },
  {
    id: 'fans250',
    flag: 'f',
    owner: 'official',
    slug: 'top-250-films-with-the-most-fans',
    name: 'Top 250 with Most Fans',
    description: 'Films with the most Letterboxd members marking them as a favorite.',
  },
  {
    id: 'animated250',
    flag: 'a',
    owner: 'official',
    slug: 'top-250-animated-films',
    name: 'Top 250 Animated',
    description: 'Highest-rated animated feature films.',
  },
  {
    id: 'horror250',
    flag: 'h',
    owner: 'official',
    slug: 'top-250-horror-films',
    name: 'Top 250 Horror',
    description: 'Highest-rated narrative features in the horror genre.',
  },
  {
    id: 'docs250',
    flag: 'o',
    owner: 'official',
    slug: 'top-250-documentary-films',
    name: 'Top 250 Documentaries',
    description: 'Highest-rated documentary feature films.',
  },
  {
    id: 'women250',
    flag: 'n',
    owner: 'official',
    slug: 'top-250-films-by-women-directors',
    name: 'Top 250 by Women Directors',
    description: 'Highest-rated narrative features directed or co-directed by women.',
  },
  {
    id: 'underseen100',
    flag: 'u',
    owner: 'official',
    slug: 'top-100-underseen-films',
    name: 'Top 100 Underseen',
    description: 'Hidden gems below the standard ratings threshold.',
  },
  {
    id: 'shorts250',
    flag: 's',
    owner: 'official',
    slug: 'top-250-short-films',
    name: 'Top 250 Shorts',
    description: 'Highest-rated short films.',
  },
  {
    id: 'black250',
    flag: 'b',
    owner: 'official',
    slug: 'top-250-films-by-black-directors',
    name: 'Top 250 by Black Directors',
    description: 'Highest-rated narrative features directed or co-directed by Black filmmakers.',
  },
  {
    id: 'decade2010s',
    flag: 'e',
    owner: 'official',
    slug: 'the-2010s-top-250-narrative-features',
    name: 'The 2010s Top 250',
    description: 'Highest-rated narrative features released between 2010 and 2019.',
  },
];

export const CURATED_FLAGS = CURATED_LISTS.map((l) => l.flag).join('');
