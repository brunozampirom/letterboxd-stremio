import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as cheerio from 'cheerio';
import { parseFilmIds } from '../src/letterboxd/film';
import { decodeEntities, hasNextPage, parseFilmsFromPage } from '../src/letterboxd/scraper';
import { LetterboxdFilm } from '../src/letterboxd/types';

const FIXTURES = path.join(__dirname, 'fixtures');

function loadFixture(name: string) {
  return fs.readFileSync(path.join(FIXTURES, name), 'utf8');
}

describe('film page IMDB / TMDB extraction', () => {
  it('parses both IMDB and TMDB IDs from a real film page', () => {
    const html = loadFixture('film.html');
    const ids = parseFilmIds(html);
    expect(ids.imdbId).toBe('tt6751668');
    expect(ids.tmdbId).toBe('496243');
  });

  it('returns undefined when ids are absent', () => {
    const ids = parseFilmIds('<html><body>nothing here</body></html>');
    expect(ids.imdbId).toBeUndefined();
    expect(ids.tmdbId).toBeUndefined();
  });
});

// The scraper reads list pages with regexes for CPU reasons. cheerio
// stays here as the reference: whatever a real DOM parser reads out of
// the same markup is what the regex parser has to return.
function parseWithCheerio(html: string): LetterboxdFilm[] {
  const $ = cheerio.load(html);
  const films: LetterboxdFilm[] = [];
  $('div[data-component-class="LazyPoster"][data-item-slug]').each((_, el) => {
    const $el = $(el);
    const slug = $el.attr('data-item-slug');
    if (!slug) return;
    const rawName = $el.attr('data-item-name') ?? slug;
    const fullName = $el.attr('data-item-full-display-name') ?? rawName;
    const yearMatch = fullName.match(/\((\d{4})\)\s*$/);
    films.push({
      slug,
      title: rawName.replace(/\s*\(\d{4}\)\s*$/, '').trim() || rawName,
      year: yearMatch ? Number.parseInt(yearMatch[1], 10) : undefined,
    });
  });
  return films;
}

describe('list page parsing', () => {
  it.each(['watchlist.html', 'list-first-page.html', 'list-last-page.html'])(
    'matches a DOM parser on %s',
    (fixture) => {
      const html = loadFixture(fixture);
      const films = parseFilmsFromPage(html);
      expect(films.length).toBeGreaterThan(0);
      expect(films).toEqual(parseWithCheerio(html));
    },
  );

  it('decodes entities and splits the year off the title', () => {
    const films = parseFilmsFromPage(loadFixture('list-last-page.html'));
    expect(films).toContainEqual({ slug: 'pride-prejudice', title: 'Pride & Prejudice', year: 2005 });
    expect(films.map((f) => f.title)).toContain("A Dog's Will");
  });

  it('sees a next page only while the Next control is a link', () => {
    expect(hasNextPage(loadFixture('list-first-page.html'))).toBe(true);
    // The last page still renders <span class="next">, disabled.
    expect(hasNextPage(loadFixture('list-last-page.html'))).toBe(false);
  });

  it('decodes the entities Letterboxd emits and leaves unknown names alone', () => {
    expect(decodeEntities('Am&eacute;lie &amp; &#039;x&#x27; &lt;3')).toBe("Am&eacute;lie & 'x' <3");
  });
});
