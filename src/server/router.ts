import * as fs from 'node:fs';
import { IncomingMessage, ServerResponse } from 'node:http';
import * as path from 'node:path';
import { info as cacheInfo, flushWrites } from '../cache';
import { isEnabled as recommendationsEnabled } from '../recommend/engine';
import { handleCatalog } from '../stremio/handlers';
import { buildManifest, FLAG_RE, parseFlags } from '../stremio/manifest';
import { handleProbe, handleRefresh } from './admin';
import { Bucket, check, info as ratelimitInfo, LimitResult } from './ratelimit';

const VERSION = '0.1.0';
const USERNAME_RE = /^[a-z0-9_]{1,32}$/i;
const PUBLIC_DIR = path.join(__dirname, '..', '..', 'public');

// Vercel's CDN only caches a Function response when Cache-Control
// carries s-maxage; a bare max-age goes to the browser and the CDN
// passes every request through to the origin. Without these the addon
// re-renders (and re-reads the cache backend) on every Stremio poll.
// stale-while-revalidate keeps responses instant past the window while
// the refresh happens in the background.
//
// The manifest is a pure function of the URL, so it can sit at the
// edge for an hour. Catalogs are held just under the Letterboxd scrape
// TTL (20 min by default) so the CDN never serves content older than
// the data layer behind it.
const CACHE_MANIFEST = 'public, max-age=300, s-maxage=3600, stale-while-revalidate=86400';
const CACHE_CATALOG = 'public, max-age=300, s-maxage=900, stale-while-revalidate=86400';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function rateLimitHeaders(result: LimitResult | null): Record<string, string> {
  if (!result) return {};
  return {
    'X-RateLimit-Limit': String(result.limit),
    'X-RateLimit-Remaining': String(result.remaining),
    'X-RateLimit-Reset': String(Math.ceil(result.reset / 1000)),
  };
}

function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  cacheControl: string,
  extra: Record<string, string> = {},
) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': cacheControl,
    ...CORS_HEADERS,
    ...extra,
  });
  res.end(JSON.stringify(body));
}

function sendHealth(res: ServerResponse) {
  res.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...CORS_HEADERS,
  });
  res.end(
    JSON.stringify({
      ok: true,
      version: VERSION,
      cache: cacheInfo(),
      rateLimit: ratelimitInfo(),
      recommendations: { enabled: recommendationsEnabled(), source: 'tmdb' as const },
      adminConfigured: Boolean(process.env.ADMIN_TOKEN),
      uptime: Math.round(process.uptime()),
      timestamp: new Date().toISOString(),
    }),
  );
}

function sendNotFound(res: ServerResponse) {
  res.writeHead(404, { 'Content-Type': 'text/plain', ...CORS_HEADERS });
  res.end('Not found');
}

function sendError(res: ServerResponse, message: string, status = 500) {
  res.writeHead(status, { 'Content-Type': 'text/plain', ...CORS_HEADERS });
  res.end(message);
}

function sendRateLimited(res: ServerResponse, result: LimitResult) {
  const retryAfter = Math.max(1, Math.ceil((result.reset - Date.now()) / 1000));
  res.writeHead(429, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Retry-After': String(retryAfter),
    ...CORS_HEADERS,
    ...rateLimitHeaders(result),
  });
  res.end(JSON.stringify({ error: 'rate_limited', retryAfter }));
}

function sendConfigurePage(res: ServerResponse) {
  const file = path.join(PUBLIC_DIR, 'configure.html');
  fs.readFile(file, (err, data) => {
    if (err) {
      // On Vercel public/ is served by the CDN and isn't bundled into
      // the function, so the file genuinely isn't on disk here. Hand
      // the browser the static asset instead of reporting a 500.
      res.writeHead(302, { Location: '/configure.html', ...CORS_HEADERS });
      res.end();
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', ...CORS_HEADERS });
    res.end(data);
  });
}

// `limited` is what the caller must branch on. Returning a bare
// LimitResult can't express it: a null also means "limiter disabled",
// so a rejected request used to fall through to the handler and then
// write to an already-closed response.
type Gate = { limited: true } | { limited: false; result: LimitResult | null };

async function gate(req: IncomingMessage, res: ServerResponse, bucket: Bucket): Promise<Gate> {
  const result = await check(req, bucket);
  if (result && !result.success) {
    sendRateLimited(res, result);
    return { limited: true };
  }
  return { limited: false, result };
}

export async function handleRequest(req: IncomingMessage, res: ServerResponse) {
  try {
    await dispatch(req, res);
  } finally {
    await flushWrites();
  }
}

async function dispatch(req: IncomingMessage, res: ServerResponse) {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS_HEADERS);
    res.end();
    return;
  }
  if (req.method !== 'GET') {
    sendError(res, 'Method not allowed', 405);
    return;
  }

  const url = req.url ?? '/';
  const [pathname, search = ''] = url.split('?');
  const segments = pathname.split('/').filter(Boolean);

  if (segments.length === 0) {
    sendConfigurePage(res);
    return;
  }

  if (segments[0] === 'health' && segments.length === 1) {
    sendHealth(res);
    return;
  }

  if (segments[0] === 'admin' && segments[1] === 'probe' && segments.length === 2) {
    await handleProbe(req, res, new URLSearchParams(search));
    return;
  }

  if (segments[0] === 'admin' && segments[1] === 'refresh' && segments.length === 2) {
    await handleRefresh(req, res, new URLSearchParams(search));
    return;
  }

  if (segments[0] === 'configure' && segments.length === 1) {
    sendConfigurePage(res);
    return;
  }

  const username = segments[0];
  if (!USERNAME_RE.test(username)) {
    sendNotFound(res);
    return;
  }

  let flagSegment: string | undefined;
  let rest = segments.slice(1);
  if (rest.length > 0 && FLAG_RE.test(rest[0])) {
    flagSegment = rest[0];
    rest = rest.slice(1);
  }

  try {
    if (rest.length === 1 && rest[0] === 'manifest.json') {
      // No rate limit gate: buildManifest is pure computation over the
      // URL and touches no backend, so gating it only spent a cache
      // command per poll.
      sendJson(res, 200, buildManifest(username, parseFlags(flagSegment)), CACHE_MANIFEST);
      return;
    }

    if (rest.length === 1 && rest[0] === 'configure') {
      sendConfigurePage(res);
      return;
    }

    if (rest[0] === 'catalog' && rest.length >= 3) {
      const type = rest[1];
      const last = rest[rest.length - 1];
      if (!last.endsWith('.json')) {
        sendNotFound(res);
        return;
      }
      const rl = await gate(req, res, 'catalog');
      if (rl.limited) return;
      const idSegments = rest.slice(2, -1).concat(last.replace(/\.json$/, ''));
      const catalogId = idSegments[0];
      const result = await handleCatalog(username, type, catalogId);
      sendJson(res, 200, result, CACHE_CATALOG, rateLimitHeaders(rl.result));
      return;
    }

    sendNotFound(res);
  } catch (err) {
    // Never echo the backend's error text back to Stremio. An Upstash
    // quota message used to come back verbatim as the response body.
    console.error('[router] request failed', err);
    sendError(res, 'Internal error', 500);
  }
}
