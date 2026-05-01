import { Ratelimit } from '@upstash/ratelimit';
import { IncomingMessage } from 'node:http';
import { getRedis } from '../cache/redis';

export type Bucket = 'catalog' | 'default';

export type LimitResult = {
  success: boolean;
  limit: number;
  remaining: number;
  reset: number;
};

const CATALOG_LIMIT = Number.parseInt(process.env.RATELIMIT_CATALOG_PER_MIN ?? '20', 10);
const DEFAULT_LIMIT = Number.parseInt(process.env.RATELIMIT_DEFAULT_PER_MIN ?? '60', 10);

let limiters: Record<Bucket, Ratelimit> | null | undefined;

function buildLimiters(): Record<Bucket, Ratelimit> | null {
  const redis = getRedis();
  if (!redis) return null;
  return {
    catalog: new Ratelimit({
      redis,
      limiter: Ratelimit.slidingWindow(CATALOG_LIMIT, '60 s'),
      analytics: false,
      prefix: 'rl:catalog',
    }),
    default: new Ratelimit({
      redis,
      limiter: Ratelimit.slidingWindow(DEFAULT_LIMIT, '60 s'),
      analytics: false,
      prefix: 'rl:default',
    }),
  };
}

export function isEnabled(): boolean {
  if (limiters === undefined) limiters = buildLimiters();
  return limiters !== null;
}

export function clientIp(req: IncomingMessage): string {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.length) return fwd.split(',')[0].trim();
  if (Array.isArray(fwd) && fwd.length) return fwd[0].trim();
  const real = req.headers['x-real-ip'];
  if (typeof real === 'string' && real.length) return real.trim();
  return req.socket.remoteAddress ?? 'unknown';
}

export async function check(req: IncomingMessage, bucket: Bucket): Promise<LimitResult | null> {
  if (limiters === undefined) limiters = buildLimiters();
  if (!limiters) return null;
  const ip = clientIp(req);
  const result = await limiters[bucket].limit(ip);
  return {
    success: result.success,
    limit: result.limit,
    remaining: result.remaining,
    reset: result.reset,
  };
}

export function info(): { enabled: boolean; vendor?: 'upstash'; perMinute?: { catalog: number; default: number } } {
  return isEnabled()
    ? {
        enabled: true,
        vendor: 'upstash',
        perMinute: { catalog: CATALOG_LIMIT, default: DEFAULT_LIMIT },
      }
    : { enabled: false };
}
