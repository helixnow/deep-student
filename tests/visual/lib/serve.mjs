/** Minimal static server for a built demo directory (no dev-server dependency discovery, no HMR). */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf', '.wasm': 'application/wasm',
  '.pdf': 'application/pdf', '.txt': 'text/plain; charset=utf-8', '.bcmap': 'application/octet-stream', '.pfb': 'application/octet-stream',
  '.mp3': 'audio/mpeg', '.mp4': 'video/mp4', '.webm': 'video/webm',
};

export async function serveDirectory(dir) {
  const rootDir = path.resolve(dir);
  if (!fs.existsSync(path.join(rootDir, 'demo.html'))) {
    throw new Error(`${rootDir}/demo.html missing: build it with \`bin/heavy node tests/visual/lib/build.mjs demo\``);
  }
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html';
    const file = path.resolve(rootDir, rel);
    if (!file.startsWith(rootDir) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.statusCode = 404;
      res.end('not found');
      return;
    }
    res.setHeader('Content-Type', TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream');
    res.setHeader('Cache-Control', 'no-store');
    fs.createReadStream(file).pipe(res);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return { url: `http://127.0.0.1:${port}`, close: () => new Promise((resolve) => server.close(resolve)) };
}
