import { loadConfig } from '../config';

const BASE_URL = 'https://letterboxd.com';

export class LetterboxdError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'LetterboxdError';
    this.status = status;
  }
}

export async function fetchPage(path: string): Promise<string> {
  const { userAgent } = loadConfig();
  const url = path.startsWith('http') ? path : `${BASE_URL}${path}`;
  const res = await fetch(url, {
    headers: {
      'User-Agent': userAgent,
      Accept: 'text/html,application/xhtml+xml',
    },
    redirect: 'follow',
  });
  if (!res.ok) {
    throw new LetterboxdError(`GET ${url} failed: ${res.status}`, res.status);
  }
  return res.text();
}
