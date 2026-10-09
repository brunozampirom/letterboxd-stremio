import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, Server } from 'node:http';
import { AddressInfo } from 'node:net';
import vercelHandler from '../api/[...path]';

// Exercises the real Vercel entrypoint, not just the helper: production
// 404'd every addon route because the function receives the rewritten
// path, doubled, and the router read "api" as the Letterboxd username.
// The paths below are what production actually delivers.
let server: Server;
let base: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    void vercelHandler(req, res);
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

describe('vercel entrypoint', () => {
  it('serves the manifest for the path the rewrite produces', async () => {
    const res = await fetch(`${base}/api/api/brunozampirom/rtw/manifest.json`);
    expect(res.status).toBe(200);

    const body = (await res.json()) as { id: string; name: string };
    expect(body.id).toBe('community.letterboxd-stremio.brunozampirom');
    expect(body.name).toContain('brunozampirom');
  });

  it('lets the CDN cache the manifest', async () => {
    const res = await fetch(`${base}/api/api/brunozampirom/manifest.json`);
    // Vercel's CDN ignores a bare max-age on a function response.
    expect(res.headers.get('cache-control')).toContain('s-maxage=');
  });

  it('serves health on the rewritten path', async () => {
    const res = await fetch(`${base}/api/api/health`);
    expect(res.status).toBe(200);
    expect((await res.json()) as { ok: boolean }).toMatchObject({ ok: true });
  });

  it('serves the configure page on the rewritten path', async () => {
    // public/ is on disk here, so this is the read path. On Vercel the
    // directory isn't bundled into the function and the handler falls
    // back to a 302 at /configure.html, which the CDN serves.
    const res = await fetch(`${base}/api/api/brunozampirom/configure`, { redirect: 'manual' });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
  });

  it('still rejects a path with no valid username', async () => {
    const res = await fetch(`${base}/api/api/manifest.json`);
    expect(res.status).toBe(404);
  });
});
