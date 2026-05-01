export type Config = {
  port: number;
  cacheTtlMs: number;
  userAgent: string;
};

const DEFAULT_USER_AGENT =
  'letterboxd-stremio/0.1 (+https://github.com/brunozampirom/letterboxd-stremio)';

export function loadConfig(): Config {
  const port = Number.parseInt(process.env.PORT ?? '7777', 10);
  const ttlMinutes = Number.parseInt(process.env.CACHE_TTL_MINUTES ?? '60', 10);
  const userAgent = process.env.USER_AGENT ?? DEFAULT_USER_AGENT;
  return {
    port,
    cacheTtlMs: ttlMinutes * 60 * 1000,
    userAgent,
  };
}
