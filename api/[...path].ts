import { IncomingMessage, ServerResponse } from 'node:http';
import { handleRequest } from '../src/server/router';

export default async function vercelHandler(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  await handleRequest(req, res);
}
