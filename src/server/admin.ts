import * as cheerio from 'cheerio';
import { IncomingMessage, ServerResponse } from 'node:http';
import { clearForUser } from '../cache';
import { fetchPage, LetterboxdError } from '../letterboxd/http';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, x-admin-token',
};

const USERNAME_RE = /^[a-z0-9_]{1,32}$/i;

function isAuthorized(req: IncomingMessage): boolean {
  const expected = process.env.ADMIN_TOKEN;
  if (!expected) return false;
  const provided = req.headers['x-admin-token'];
  if (typeof provided !== 'string') return false;
  return provided === expected;
}

function sendNotFound(res: ServerResponse) {
  res.writeHead(404, { 'Content-Type': 'text/plain', ...CORS_HEADERS });
  res.end('Not found');
}

function isCloudflareChallenge(html: string): boolean {
  return (
    html.includes('Just a moment...') ||
    html.includes('challenges.cloudflare.com') ||
    html.includes('challenge-platform')
  );
}

function countPosters(html: string): number {
  const matches = html.match(/data-component-class="LazyPoster"/g);
  return matches ? matches.length : 0;
}

function countFilmSlugs(html: string): number {
  const matches = html.match(/data-item-slug="[^"]+"/g);
  return matches ? matches.length : 0;
}

function sampleFilmSlugs(html: string, n = 5): string[] {
  const matches = html.match(/data-item-slug="([^"]+)"/g) ?? [];
  return matches.slice(0, n).map((m) => m.replace(/data-item-slug="([^"]+)"/, '$1'));
}

function extractLists(html: string, owner: string): Array<{ slug: string; title: string }> {
  const $ = cheerio.load(html);
  const seen = new Set<string>();
  const lists: Array<{ slug: string; title: string }> = [];
  $(`a[href^="/${owner}/list/"]`).each((_, el) => {
    const href = $(el).attr('href') ?? '';
    const match = href.match(new RegExp(`^/${owner}/list/([^/]+)/?$`));
    if (!match) return;
    const slug = match[1];
    if (seen.has(slug)) return;
    seen.add(slug);
    const title = $(el).text().trim() || $(el).attr('title') || slug;
    if (title.length > 0) lists.push({ slug, title });
  });
  return lists;
}

export async function handleProbe(req: IncomingMessage, res: ServerResponse, query: URLSearchParams) {
  if (!isAuthorized(req)) {
    sendNotFound(res);
    return;
  }

  const path = query.get('path');
  if (!path || !path.startsWith('/')) {
    res.writeHead(400, { 'Content-Type': 'application/json', ...CORS_HEADERS });
    res.end(JSON.stringify({ error: 'missing or invalid `path` query parameter (must start with /)' }));
    return;
  }

  let status = 0;
  let html = '';
  let errorMessage: string | undefined;

  try {
    html = await fetchPage(path);
    status = 200;
  } catch (err) {
    if (err instanceof LetterboxdError) {
      status = err.status;
    } else {
      status = -1;
      errorMessage = err instanceof Error ? err.message : String(err);
    }
  }

  const parseMode = query.get('parse');
  const body: Record<string, unknown> = {
    path,
    status,
    bytes: html.length,
    posterCount: countPosters(html),
    filmSlugCount: countFilmSlugs(html),
    sampleSlugs: sampleFilmSlugs(html),
    isCloudflareChallenge: isCloudflareChallenge(html),
    sample: html.slice(0, 400),
    error: errorMessage,
  };

  if (parseMode === 'lists' && status === 200) {
    const ownerMatch = path.match(/^\/([^/]+)\//);
    const owner = ownerMatch ? ownerMatch[1] : '';
    body.lists = owner ? extractLists(html, owner) : [];
  }

  res.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...CORS_HEADERS,
  });
  res.end(JSON.stringify(body, null, 2));
}

export async function handleRefresh(req: IncomingMessage, res: ServerResponse, query: URLSearchParams) {
  if (!isAuthorized(req)) {
    sendNotFound(res);
    return;
  }

  const user = query.get('user');
  if (!user || !USERNAME_RE.test(user)) {
    res.writeHead(400, { 'Content-Type': 'application/json', ...CORS_HEADERS });
    res.end(JSON.stringify({ error: 'missing or invalid `user` query parameter' }));
    return;
  }

  const deleted = await clearForUser(user);
  res.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...CORS_HEADERS,
  });
  res.end(JSON.stringify({ user, deletedKeys: deleted }, null, 2));
}
