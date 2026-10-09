import { IncomingMessage, ServerResponse } from 'node:http';
import { handleRequest } from '../src/server/router';
import { stripApiPrefix } from '../src/server/vercel';

export default async function vercelHandler(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (req.url) req.url = stripApiPrefix(req.url);
  await handleRequest(req, res);
}
