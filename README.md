# Letterboxd → Stremio

A [Stremio](https://www.stremio.com/) addon that exposes any public Letterboxd profile's **watchlist**, **personalized recommendations**, and **curated picks** as Stremio catalogs.

The addon scrapes public pages on `letterboxd.com` (no API key required), resolves each film to its IMDB ID, and serves Stremio-compatible catalogs. Stremio's built-in Cinemeta then handles posters, descriptions, and metadata.

> **Status:** early/MVP. Watchlist + recommendations + curated picks. No login required — only public data.

---

## Hosted instance

The maintainer runs a public instance you can use without setting anything up:

> **https://letterboxd-stremio.vercel.app/configure**

Enter your Letterboxd username and click **Install in Stremio**. That's it. The instance is free, has rate limiting, and uses Upstash Redis for caching. If you'd rather run your own (recommended for heavy use, full control, or distrust of third parties), see [Self-host](#self-host) below.

---

## Features

- **Watchlist** as a Stremio catalog (Movies and Series, separated automatically)
- **Recommendations** — films similar to the ones you liked or rated 4★ or higher; powered by TMDB and your Letterboxd RSS feed (requires a free TMDB token)
- **Curated picks** — opt-in catalogs from Letterboxd's official lists (Top 500, Top 250 Horror, Animated, Documentaries, etc.), each filtered to films you haven't watched yet
- **Caching** — CDN, process memory, and Upstash Redis when configured (memory alone otherwise)
- **Per-IP rate limiting** when Upstash Redis is available
- **Multi-tenant** — one deployment serves any number of users via URL-based config
- **Self-hostable** — Docker, plain Node, or Vercel

### Recommendations setup (optional)

The Recommendations catalog reads your Letterboxd RSS feed (last ~50 logs) for entries you liked or rated **4 stars or higher**, then fetches similar and recommended titles from **TMDB**. Aggregated scores are filtered against your watchlist and recently-watched films so you never see something you've already saved or watched.

To enable it, set `TMDB_READ_TOKEN` (free token from https://www.themoviedb.org/settings/api). Without it, the catalog is simply omitted from the manifest and the addon continues to work for the watchlist and curated picks.

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
├── cache/
│   ├── index.ts         # cache facade: memory L1 over Redis, batching
│   ├── memory.ts        # bounded in-memory TTL cache
│   └── redis.ts         # Upstash client, MGET reads, pipelined writes
├── letterboxd/
│   ├── http.ts          # fetch wrapper with User-Agent
│   ├── scraper.ts       # watchlist / list parsing (cheerio)
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

### Caching layers

Three tiers, in order:

1. **Vercel's CDN.** Catalog and manifest responses carry `s-maxage`, so a
   repeated Stremio poll never reaches the function. `stale-while-revalidate`
   serves the previous response instantly while the refresh runs behind it.
2. **Process-local memory (L1).** Bounded, and capped at a 1 hour TTL when
   Redis is configured, so a warm instance answers without touching Upstash.
3. **Upstash Redis.** Shared across instances and deploys.

Upstash bills per *command*, and the catalogs are built from per-film keys
(`filmIds:<slug>`, `cinemeta:<imdbId>`, `tmdb:details:<id>`). Resolving them
one at a time is what burns a monthly quota: a single curated catalog render
is a few hundred keys. So every fan-out is preceded by `warm()`, which pulls
the whole key set into the L1 with **one** `MGET`, and writes are buffered and
flushed as a single pipeline. If you add a new per-item cache namespace, give
it a `warm*` helper and call it before the loop, otherwise you reintroduce the
per-key cost.

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
