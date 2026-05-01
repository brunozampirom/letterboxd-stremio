import * as fs from 'node:fs';
import { IncomingMessage, ServerResponse } from 'node:http';
import * as path from 'node:path';
import { handleCatalog } from '../stremio/handlers';
import { buildManifest } from '../stremio/manifest';

const USERNAME_RE = /^[a-z0-9_]{1,32}$/i;
const PUBLIC_DIR = path.join(__dirname, '..', '..', 'public');

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'public, max-age=300',
    ...CORS_HEADERS,
  });
  res.end(JSON.stringify(body));
}

function sendNotFound(res: ServerResponse) {
  res.writeHead(404, { 'Content-Type': 'text/plain', ...CORS_HEADERS });
  res.end('Not found');
}

function sendError(res: ServerResponse, message: string, status = 500) {
  res.writeHead(status, { 'Content-Type': 'text/plain', ...CORS_HEADERS });
  res.end(message);
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
  const [pathname] = url.split('?');
  const segments = pathname.split('/').filter(Boolean);

  if (segments.length === 0) {
    sendConfigurePage(res);
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

  const rest = segments.slice(1);

  try {
    if (rest.length === 1 && rest[0] === 'manifest.json') {
      sendJson(res, 200, buildManifest(username));
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
      const idSegments = rest.slice(2, -1).concat(last.replace(/\.json$/, ''));
      const catalogId = idSegments[0];
      const result = await handleCatalog(username, type, catalogId);
      sendJson(res, 200, result);
      return;
    }

    sendNotFound(res);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Internal error';
    sendError(res, message, 500);
  }
}
