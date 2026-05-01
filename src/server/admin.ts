import { IncomingMessage, ServerResponse } from 'node:http';
import { fetchPage, LetterboxdError } from '../letterboxd/http';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, x-admin-token',
};

function isAuthorized(req: IncomingMessage): boolean {
  const expected = process.env.ADMIN_TOKEN;
  if (!expected) return false;
  const provided = req.headers['x-admin-token'];
  if (typeof provided !== 'string') return false;
  return provided === expected;
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

export async function handleProbe(req: IncomingMessage, res: ServerResponse, query: URLSearchParams) {
  if (!isAuthorized(req)) {
    res.writeHead(404, { 'Content-Type': 'text/plain', ...CORS_HEADERS });
    res.end('Not found');
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

  const body = {
    path,
    status,
    bytes: html.length,
    posterCount: countPosters(html),
    isCloudflareChallenge: isCloudflareChallenge(html),
    sample: html.slice(0, 400),
    error: errorMessage,
  };

  res.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...CORS_HEADERS,
  });
  res.end(JSON.stringify(body, null, 2));
}
