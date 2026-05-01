# Letterboxd → Stremio

A [Stremio](https://www.stremio.com/) addon that exposes any public Letterboxd profile's **watchlist**, **diary**, and **custom lists** as Stremio catalogs.

The addon scrapes public pages on `letterboxd.com` (no API key required), resolves each film to its IMDB ID, and serves Stremio-compatible catalogs. Stremio's built-in Cinemeta then handles posters, descriptions, and metadata.

> **Status:** early/MVP. Watchlist + diary + custom lists. No login required — only public data.

---

## Hosted instance

The maintainer runs a public instance you can use without setting anything up:

> **https://letterboxd-stremio.vercel.app/configure**

Enter your Letterboxd username and click **Install in Stremio**. That's it. The instance is free, has rate limiting, and uses Upstash Redis for caching. If you'd rather run your own (recommended for heavy use, full control, or distrust of third parties), see [Self-host](#self-host) below.

---

## Features

- **Watchlist** as a Stremio catalog (Movies and Series, separated automatically)
- **Diary** (films you've logged) as a Stremio catalog
- **Custom lists** — every public list on your profile becomes a catalog
- **Caching** — Upstash Redis when configured, in-memory fallback otherwise
- **Per-IP rate limiting** when Upstash Redis is available
- **Multi-tenant** — one deployment serves any number of users via URL-based config
- **Self-hostable** — Docker, plain Node, or Vercel

---

## Self-host

### Option 1: Docker

```bash
git clone https://github.com/brunozampirom/letterboxd-stremio.git
cd letterboxd-stremio
docker compose up -d
```

The addon listens on `http://localhost:7777`. In Stremio, click **Add-ons → Community Add-ons → Add Add-on** and paste:

```
http://127.0.0.1:7777/<your-letterboxd-username>/manifest.json
```

### Option 2: Node

```bash
git clone https://github.com/brunozampirom/letterboxd-stremio.git
cd letterboxd-stremio
yarn install
cp .env.example .env  # adjust values if you wish
yarn dev
```

### Option 3: Vercel

1. Fork this repo on GitHub.
2. On Vercel, **New Project → Import Git Repository → select your fork**.
3. Deploy. No environment variables required.
4. Open `https://<your-project>.vercel.app/configure` and enter your Letterboxd username.

---

## Configuration

All configuration is via environment variables — see [`.env.example`](./.env.example):

| Variable             | Default | Purpose                                                       |
| -------------------- | ------- | ------------------------------------------------------------- |
| `PORT`               | `7777`  | HTTP port for the local server.                               |
| `CACHE_TTL_MINUTES`  | `60`    | How long scraped data is cached before re-fetching.           |
| `USER_AGENT`         | _(see file)_ | User-Agent sent to Letterboxd. Identify your fork.       |

The addon **never stores credentials** — it only reads public profile data. There is no login flow.

---

## Architecture

```
src/
├── cache/memory.ts      # in-memory TTL cache
├── letterboxd/
│   ├── http.ts          # fetch wrapper with User-Agent
│   ├── scraper.ts       # watchlist / diary / lists parsing (cheerio)
│   ├── film.ts          # film slug → IMDB / TMDB ID
│   └── types.ts
├── stremio/
│   ├── manifest.ts      # manifest builder per username
│   ├── handlers.ts      # catalog handler
│   ├── transform.ts     # Letterboxd film → Stremio meta
│   └── types.ts
├── server/router.ts     # HTTP routing (manifest, catalog, configure)
└── server.ts            # local server entry
api/
└── [...path].ts         # Vercel serverless adapter
public/
└── configure.html       # username form
```

The HTTP protocol implemented matches the [Stremio addon spec](https://github.com/Stremio/stremio-addon-sdk/blob/master/docs/protocol.md): `GET /<username>/manifest.json` and `GET /<username>/catalog/movie/<catalogId>.json`.

---

## Development

```bash
yarn dev         # ts-node-dev with reload
yarn typecheck   # tsc --noEmit
yarn build       # compile to dist/
yarn test        # run vitest
```

### How film IDs are resolved

Letterboxd film pages link to IMDB and TMDB. We fetch each film page once, extract `tt…` and the TMDB ID via regex, and cache the mapping for 7 days. Stremio is then asked to display the film by IMDB ID, and Cinemeta provides poster/synopsis/etc.

### Scraping etiquette

- Identifiable User-Agent pointing at the project.
- Aggressive caching (in-memory, 1h default, configurable).
- No parallel hammering — film resolution is bounded to a small concurrency pool.
- We only read public pages; no login, no scraping of private data.

---

## Contributing

Pull requests are welcome. Please:

- Keep all code, comments, commits, and docs **in English**.
- Don't commit secrets — `.env` is git-ignored; use `.env.example` for documentation only.
- Run `yarn typecheck && yarn test` before opening a PR.

---

## License

MIT — see [LICENSE](./LICENSE).

This project is **not affiliated with Letterboxd or Stremio**.
