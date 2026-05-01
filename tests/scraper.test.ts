import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as cheerio from 'cheerio';
import { parseFilmIds } from '../src/letterboxd/film';

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

describe('watchlist parsing', () => {
  it('extracts film slugs and titles from a real watchlist page', () => {
    const html = loadFixture('watchlist.html');
    const $ = cheerio.load(html);
    const items: { slug: string; title: string; year?: number }[] = [];
    $('div[data-component-class="LazyPoster"][data-item-slug]').each((_, el) => {
      const $el = $(el);
      const slug = $el.attr('data-item-slug');
      if (!slug) return;
      const fullName = $el.attr('data-item-full-display-name') ?? '';
      const yearMatch = fullName.match(/\((\d{4})\)\s*$/);
      items.push({
        slug,
        title: $el.attr('data-item-name') ?? slug,
        year: yearMatch ? Number.parseInt(yearMatch[1], 10) : undefined,
      });
    });
    expect(items.length).toBeGreaterThan(0);
    expect(items[0].slug).toMatch(/^[a-z0-9-]+$/);
    expect(items[0].title.length).toBeGreaterThan(0);
  });
});
