import * as cheerio from 'cheerio';
import { cacheIfNonEmpty, getOrFetch } from '../cache';
import { loadConfig } from '../config';
import { fetchPage, LetterboxdError } from './http';
import { LetterboxdFilm, LetterboxdList } from './types';

// List and watchlist pages are scanned with regexes rather than a DOM.
// cheerio.load on a ~270 KB list page was a third of the CPU of a cold
// catalog render, and the parser only ever reads attributes of one tag
// shape plus the pagination link.
//
// An opening <div> tag, attribute by attribute, so a quoted value that
// contains '>' (the JSON blobs Letterboxd puts in data-* attributes)
// doesn't end the match early.
const DIV_TAG_RE = /<div((?:\s+[^\s=>\/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'>]+))?)*)\s*\/?>/g;
const ATTR_RE = /([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g;
// The enabled "Next" control is a link. On the last page it becomes a
// <span class="next">, which the old '.paginate-nextprev .next'
// selector also matched, so every list fetched one page past its end.
const NEXT_LINK_RE = /<a\b[^>]*\bclass="next"/;

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: '\u00a0',
};

export function decodeEntities(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, body: string) => {
    if (body[0] === '#') {
      const code =
        body[1] === 'x' || body[1] === 'X'
          ? Number.parseInt(body.slice(2), 16)
          : Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? match;
  });
}

function parseAttributes(source: string): Map<string, string> {
  const attrs = new Map<string, string>();
  for (const m of source.matchAll(ATTR_RE)) {
    const name = m[1].toLowerCase();
    if (attrs.has(name)) continue;
    attrs.set(name, decodeEntities(m[2] ?? m[3] ?? m[4] ?? ''));
  }
  return attrs;
}

export function parseFilmsFromPage(html: string): LetterboxdFilm[] {
  const films: LetterboxdFilm[] = [];
  for (const tag of html.matchAll(DIV_TAG_RE)) {
    if (!tag[1].includes('LazyPoster')) continue;
    const attrs = parseAttributes(tag[1]);
    if (attrs.get('data-component-class') !== 'LazyPoster') continue;
    const slug = attrs.get('data-item-slug');
    if (!slug) continue;
    const rawName = attrs.get('data-item-name') ?? slug;
    const fullName = attrs.get('data-item-full-display-name') ?? rawName;
    const yearMatch = fullName.match(/\((\d{4})\)\s*$/);
    const title = rawName.replace(/\s*\(\d{4}\)\s*$/, '').trim() || rawName;
    films.push({
      slug,
      title,
      year: yearMatch ? Number.parseInt(yearMatch[1], 10) : undefined,
    });
  }
  return films;
}

export function hasNextPage(html: string): boolean {
  return NEXT_LINK_RE.test(html);
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
    all.push(...parseFilmsFromPage(html));
    if (!hasNextPage(html)) break;
  }
  return all;
}

export async function fetchWatchlist(username: string): Promise<LetterboxdFilm[]> {
  const { cacheTtlMs } = loadConfig();
  return getOrFetch(
    `watchlist:${username}`,
    cacheTtlMs,
    () => fetchPaginated(`/${username}/watchlist/`),
    cacheIfNonEmpty,
  );
}

export async function fetchDiary(username: string): Promise<LetterboxdFilm[]> {
  const { cacheTtlMs } = loadConfig();
  return getOrFetch(
    `diary:${username}`,
    cacheTtlMs,
    () => fetchPaginated(`/${username}/films/diary/`),
    cacheIfNonEmpty,
  );
}

export async function fetchListFilms(
  username: string,
  listSlug: string,
  ttlMs: number = loadConfig().cacheTtlMs,
): Promise<LetterboxdFilm[]> {
  return getOrFetch(
    `list:${username}:${listSlug}`,
    ttlMs,
    () => fetchPaginated(`/${username}/list/${listSlug}/`),
    cacheIfNonEmpty,
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
