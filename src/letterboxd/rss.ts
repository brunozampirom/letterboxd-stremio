import { cacheIfNonEmpty, getOrFetch } from '../cache';
import { loadConfig } from '../config';
import { fetchPage, LetterboxdError } from './http';

export type RssEntry = {
  tmdbId: string;
  title: string;
  year?: number;
  rating?: number;
  liked?: boolean;
  watchedDate?: string;
};

const RATING_RE = /<letterboxd:memberRating>([\d.]+)<\/letterboxd:memberRating>/;
const TITLE_RE = /<letterboxd:filmTitle>(?:<!\[CDATA\[)?([^<\]]+)(?:\]\]>)?<\/letterboxd:filmTitle>/;
const YEAR_RE = /<letterboxd:filmYear>(\d{4})<\/letterboxd:filmYear>/;
const TMDB_ID_RE = /<tmdb:movieId>(\d+)<\/tmdb:movieId>/;
const WATCHED_RE = /<letterboxd:watchedDate>(\d{4}-\d{2}-\d{2})<\/letterboxd:watchedDate>/;
const LIKED_RE = /<letterboxd:liked>(true|false)<\/letterboxd:liked>/;
const ITEM_RE = /<item>([\s\S]*?)<\/item>/g;

export function parseRss(xml: string): RssEntry[] {
  const entries: RssEntry[] = [];
  for (const match of xml.matchAll(ITEM_RE)) {
    const block = match[1];
    const tmdbMatch = block.match(TMDB_ID_RE);
    if (!tmdbMatch) continue;
    const titleMatch = block.match(TITLE_RE);
    if (!titleMatch) continue;
    const likedMatch = block.match(LIKED_RE);
    entries.push({
      tmdbId: tmdbMatch[1],
      title: titleMatch[1].trim(),
      year: block.match(YEAR_RE) ? Number.parseInt(block.match(YEAR_RE)![1], 10) : undefined,
      rating: block.match(RATING_RE) ? Number.parseFloat(block.match(RATING_RE)![1]) : undefined,
      liked: likedMatch ? likedMatch[1] === 'true' : undefined,
      watchedDate: block.match(WATCHED_RE)?.[1],
    });
  }
  return entries;
}

export async function fetchRssEntries(username: string): Promise<RssEntry[]> {
  const { cacheTtlMs } = loadConfig();
  return getOrFetch(
    `rss:${username}`,
    cacheTtlMs,
    async () => {
      try {
        const xml = await fetchPage(`/${username}/rss/`);
        return parseRss(xml);
      } catch (err) {
        if (err instanceof LetterboxdError && (err.status === 404 || err.status === 403)) {
          return [];
        }
        throw err;
      }
    },
    cacheIfNonEmpty,
  );
}

export async function fetchSeedFilms(
  username: string,
  minRating: number,
): Promise<RssEntry[]> {
  const entries = await fetchRssEntries(username);
  return entries.filter((e) => e.liked === true || (typeof e.rating === 'number' && e.rating >= minRating));
}
