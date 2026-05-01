import { createServer } from 'node:http';
import { loadConfig } from './config';
import { handleRequest } from './server/router';

const { port } = loadConfig();

const server = createServer((req, res) => {
  handleRequest(req, res).catch((err) => {
    console.error('unhandled error:', err);
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Internal Server Error');
    }
  });
});

server.listen(port, () => {
  console.log(`letterboxd-stremio listening on http://127.0.0.1:${port}`);
  console.log(`Open http://127.0.0.1:${port}/configure to install in Stremio.`);
});
