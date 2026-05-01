import * as cheerio from 'cheerio';
import { getOrFetch } from '../cache';
import { loadConfig } from '../config';
import { fetchPage, LetterboxdError } from './http';
import { LetterboxdFilm, LetterboxdList } from './types';

const POSTER_SELECTOR = 'div[data-component-class="LazyPoster"][data-item-slug]';
const LIST_PAGE_SIZE_HINT = 28;

function parseFilmsFromPage(html: string): LetterboxdFilm[] {
  const $ = cheerio.load(html);
  const films: LetterboxdFilm[] = [];
  $(POSTER_SELECTOR).each((_, el) => {
    const $el = $(el);
    const slug = $el.attr('data-item-slug');
    if (!slug) return;
    const rawName = $el.attr('data-item-name') ?? slug;
    const fullName = $el.attr('data-item-full-display-name') ?? rawName;
    const yearMatch = fullName.match(/\((\d{4})\)\s*$/);
    const title = rawName.replace(/\s*\(\d{4}\)\s*$/, '').trim() || rawName;
    films.push({
      slug,
      title,
      year: yearMatch ? Number.parseInt(yearMatch[1], 10) : undefined,
    });
  });
  return films;
}

function hasNextPage(html: string): boolean {
  const $ = cheerio.load(html);
  return $('.paginate-nextprev .next').length > 0;
}

async function fetchPaginated(basePath: string, maxPages = 20): Promise<LetterboxdFilm[]> {
  const all: LetterboxdFilm[] = [];
  for (let page = 1; page <= maxPages; page++) {
    const path = page === 1 ? basePath : `${basePath}page/${page}/`;
    let html: string;
    try {
      html = await fetchPage(path);
    } catch (err) {
      if (
        err instanceof LetterboxdError &&
        (err.status === 404 || err.status === 403 || err.status === 451)
      ) {
        if (page === 1) {
          console.warn(`letterboxd ${err.status} for ${path} — returning empty list`);
        }
        break;
      }
      throw err;
    }
    const films = parseFilmsFromPage(html);
    all.push(...films);
    if (films.length < LIST_PAGE_SIZE_HINT && !hasNextPage(html)) break;
    if (!hasNextPage(html)) break;
  }
  return all;
}

export async function fetchWatchlist(username: string): Promise<LetterboxdFilm[]> {
  const { cacheTtlMs } = loadConfig();
  return getOrFetch(`watchlist:${username}`, cacheTtlMs, () =>
    fetchPaginated(`/${username}/watchlist/`),
  );
}

export async function fetchDiary(username: string): Promise<LetterboxdFilm[]> {
  const { cacheTtlMs } = loadConfig();
  return getOrFetch(`diary:${username}`, cacheTtlMs, () =>
    fetchPaginated(`/${username}/films/diary/`),
  );
}

export async function fetchListFilms(
  username: string,
  listSlug: string,
): Promise<LetterboxdFilm[]> {
  const { cacheTtlMs } = loadConfig();
  return getOrFetch(`list:${username}:${listSlug}`, cacheTtlMs, () =>
    fetchPaginated(`/${username}/list/${listSlug}/`),
  );
}

export async function fetchUserLists(username: string): Promise<LetterboxdList[]> {
  const { cacheTtlMs } = loadConfig();
  return getOrFetch(`lists:${username}`, cacheTtlMs, async () => {
    const lists: LetterboxdList[] = [];
    for (let page = 1; page <= 10; page++) {
      const path = page === 1 ? `/${username}/lists/` : `/${username}/lists/page/${page}/`;
      let html: string;
      try {
        html = await fetchPage(path);
      } catch (err) {
        if (err instanceof LetterboxdError && err.status === 404) break;
        throw err;
      }
      const $ = cheerio.load(html);
      const before = lists.length;
      $('section.list-set article.list-summary, section.list a.list-link, h2.title-2 a[href*="/list/"]').each(
        (_, el) => {
          const href = $(el).attr('href') ?? '';
          const match = href.match(new RegExp(`/${username}/list/([^/]+)/?$`));
          if (!match) return;
          const slug = match[1];
          const name = $(el).text().trim() || slug;
          if (!lists.some((l) => l.slug === slug)) {
            lists.push({ slug, name, url: `https://letterboxd.com${href}` });
          }
        },
      );
      if (lists.length === before) break;
      if (!hasNextPage(html)) break;
    }
    return lists;
  });
}
