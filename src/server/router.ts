import * as fs from 'node:fs';
import { IncomingMessage, ServerResponse } from 'node:http';
import * as path from 'node:path';
import { info as cacheInfo } from '../cache';
import { isEnabled as recommendationsEnabled } from '../recommend/engine';
import { handleCatalog } from '../stremio/handlers';
import { buildManifest, FLAG_RE, parseFlags } from '../stremio/manifest';
import { handleProbe, handleRefresh } from './admin';
import { Bucket, check, info as ratelimitInfo, LimitResult } from './ratelimit';

const VERSION = '0.1.0';
const USERNAME_RE = /^[a-z0-9_]{1,32}$/i;
const PUBLIC_DIR = path.join(__dirname, '..', '..', 'public');

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

function sendJson(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'public, max-age=300',
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
      sendError(res, 'configure.html missing');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', ...CORS_HEADERS });
    res.end(data);
  });
}

async function gate(req: IncomingMessage, res: ServerResponse, bucket: Bucket): Promise<LimitResult | null> {
  const result = await check(req, bucket);
  if (result && !result.success) {
    sendRateLimited(res, result);
    return null;
  }
  return result;
}

export async function handleRequest(req: IncomingMessage, res: ServerResponse) {
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
      const rl = await gate(req, res, 'default');
      if (rl && !rl.success) return;
      sendJson(res, 200, buildManifest(username, parseFlags(flagSegment)), rateLimitHeaders(rl));
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
      if (rl && !rl.success) return;
      const idSegments = rest.slice(2, -1).concat(last.replace(/\.json$/, ''));
      const catalogId = idSegments[0];
      const result = await handleCatalog(username, type, catalogId);
      sendJson(res, 200, result, rateLimitHeaders(rl));
      return;
    }

    sendNotFound(res);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Internal error';
    sendError(res, message, 500);
  }
}
