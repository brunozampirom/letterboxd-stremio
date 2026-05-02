import { describe, expect, it } from 'vitest';
import { parseRss, RssEntry } from '../src/letterboxd/rss';

const SAMPLE = `<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0" xmlns:letterboxd="https://letterboxd.com" xmlns:tmdb="https://themoviedb.org">
<channel>
  <item>
    <title>Parasite, 2019 - ★★★★★</title>
    <link>https://letterboxd.com/dave/film/parasite-2019/</link>
    <pubDate>Sun, 01 Jan 2024 12:00:00 +0000</pubDate>
    <letterboxd:filmTitle>Parasite</letterboxd:filmTitle>
    <letterboxd:filmYear>2019</letterboxd:filmYear>
    <letterboxd:memberRating>5.0</letterboxd:memberRating>
    <letterboxd:watchedDate>2024-01-01</letterboxd:watchedDate>
    <tmdb:movieId>496243</tmdb:movieId>
  </item>
  <item>
    <title>Some List Update</title>
    <link>https://letterboxd.com/dave/list/something/</link>
    <pubDate>Sun, 02 Jan 2024 12:00:00 +0000</pubDate>
  </item>
  <item>
    <title>Persona, 1966 - ★★★★</title>
    <letterboxd:filmTitle>Persona</letterboxd:filmTitle>
    <letterboxd:filmYear>1966</letterboxd:filmYear>
    <letterboxd:memberRating>4.0</letterboxd:memberRating>
    <letterboxd:liked>true</letterboxd:liked>
    <tmdb:movieId>815</tmdb:movieId>
  </item>
  <item>
    <title>Bad Movie, 2023 - ★★</title>
    <letterboxd:filmTitle>Bad Movie</letterboxd:filmTitle>
    <letterboxd:filmYear>2023</letterboxd:filmYear>
    <letterboxd:memberRating>2.0</letterboxd:memberRating>
    <letterboxd:liked>false</letterboxd:liked>
    <tmdb:movieId>999999</tmdb:movieId>
  </item>
  <item>
    <title>Loved Without Rating, 2020</title>
    <letterboxd:filmTitle>Loved Without Rating</letterboxd:filmTitle>
    <letterboxd:filmYear>2020</letterboxd:filmYear>
    <letterboxd:liked>true</letterboxd:liked>
    <tmdb:movieId>111111</tmdb:movieId>
  </item>
</channel>
</rss>`;

describe('parseRss', () => {
  it('extracts only entries with tmdb:movieId', () => {
    const entries = parseRss(SAMPLE);
    expect(entries).toHaveLength(4);
    expect(entries[0]).toMatchObject({ tmdbId: '496243', title: 'Parasite', year: 2019, rating: 5.0 });
    expect(entries[1]).toMatchObject({ tmdbId: '815', title: 'Persona', rating: 4.0, liked: true });
    expect(entries[2]).toMatchObject({ tmdbId: '999999', rating: 2.0, liked: false });
    expect(entries[3]).toMatchObject({ tmdbId: '111111', liked: true, rating: undefined });
  });

  it('treats liked-only entries as valid seeds', () => {
    const entries = parseRss(SAMPLE);
    const seeds = entries.filter(
      (e: RssEntry) => e.liked === true || (typeof e.rating === 'number' && e.rating >= 4),
    );
    // Parasite (rating 5), Persona (rating 4 + liked), Loved Without Rating (liked only)
    expect(seeds.map((e: RssEntry) => e.tmdbId).sort()).toEqual(['111111', '496243', '815']);
  });

  it('handles entries without ratings', () => {
    const xml = SAMPLE.replace(/<letterboxd:memberRating>5\.0<\/letterboxd:memberRating>/, '');
    const entries = parseRss(xml);
    expect(entries[0].rating).toBeUndefined();
  });

  it('returns empty array for malformed input', () => {
    expect(parseRss('')).toEqual([]);
    expect(parseRss('<rss></rss>')).toEqual([]);
  });
});
