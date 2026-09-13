#!/usr/bin/env node
/**
 * Zero-dependency static server for Song Guess (Node alternative to server.py).
 *
 * Binds to 127.0.0.1 on purpose: Spotify rejects `localhost` as a redirect URI,
 * and 127.0.0.1 is still a "potentially trustworthy" origin, so the Web Playback
 * SDK (which needs a secure context for EME/Widevine) works over plain HTTP.
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HOST = '127.0.0.1';
const PORT = Number(process.env.PORT) || 8080;
const ROOT = path.dirname(fileURLToPath(import.meta.url));

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
};

const server = http.createServer((req, res) => {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, `http://${HOST}:${PORT}`).pathname);
  } catch {
    res.writeHead(400).end('Bad request');
    return;
  }

  // The OAuth redirect lands on /callback; the SPA reads ?code= from the URL.
  if (pathname === '/' || pathname === '/callback') pathname = '/index.html';

  const filePath = path.resolve(ROOT, '.' + pathname);
  if (filePath !== ROOT && !filePath.startsWith(ROOT + path.sep)) {
    res.writeHead(403).end('Forbidden');
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    }).end(data);
  });
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n  Port ${PORT} is already in use.`);
    console.error(`  Try:  PORT=8888 node server.js`);
    console.error(`  (then register http://${HOST}:8888/callback instead)\n`);
    process.exit(1);
  }
  throw err;
});

server.listen(PORT, HOST, () => {
  console.log(`\n  Song Guess running at  http://${HOST}:${PORT}\n`);
  console.log('  Redirect URI to register in your Spotify app:');
  console.log(`    http://${HOST}:${PORT}/callback\n`);
});
