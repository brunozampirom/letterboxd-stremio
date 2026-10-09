import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { handleRequest } from '../src/server/router';

// Drives the router over real HTTP, the same way src/server.ts does.
// That file is the deployed entrypoint: Vercel detects the Node server
// from package.json "main" and serves the whole app as one function,
// so these paths are what production actually receives.
let server: Server;
let base: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    void handleRequest(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  base = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
});

describe('addon over http', () => {
  it('serves the manifest for a flagged install URL', async () => {
    const res = await fetch(`${base}/brunozampirom/rtw/manifest.json`);
    expect(res.status).toBe(200);

    const body = (await res.json()) as { id: string; name: string };
    expect(body.id).toBe('community.letterboxd-stremio.brunozampirom');
    expect(body.name).toContain('brunozampirom');
  });

  it('lets the CDN cache the manifest', async () => {
    const res = await fetch(`${base}/brunozampirom/manifest.json`);
    // Vercel's CDN ignores a bare max-age on a function response.
    expect(res.headers.get('cache-control')).toContain('s-maxage=');
  });

  it('serves health', async () => {
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(200);
    expect((await res.json()) as { ok: boolean }).toMatchObject({ ok: true });
  });

  it('rejects a path with no valid username', async () => {
    expect((await fetch(`${base}/manifest.json`)).status).toBe(404);
  });

  it('does not treat a leading api segment as a username', async () => {
    // The old vercel.json rewrote every path to /api/$1 and the router
    // read that segment as the username, so every route 404'd.
    const res = await fetch(`${base}/api/brunozampirom/rtw/manifest.json`);
    expect(res.status).toBe(404);
  });
});
