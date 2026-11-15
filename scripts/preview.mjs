import { createReadStream, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const port = Number(process.env.PORT || 4173);
const mimeTypes = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.html', 'text/html; charset=utf-8'],
  ['.ico', 'image/x-icon'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'],
  ['.png', 'image/png'],
  ['.svg', 'image/svg+xml'],
  ['.webp', 'image/webp'],
]);

const server = createServer((request, response) => {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.writeHead(405, { Allow: 'GET, HEAD' }).end('Method not allowed');
    return;
  }

  let pathname;
  try {
    pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
  } catch {
    response.writeHead(400).end('Bad request');
    return;
  }

  const filePath = resolve(root, `.${pathname}`);
  const relativePath = relative(root, filePath);
  if (relativePath === '..' || relativePath.startsWith(`..${sep}`)) {
    response.writeHead(403).end('Forbidden');
    return;
  }

  let target = filePath;
  try {
    if (statSync(target).isDirectory()) target = resolve(target, 'index.html');
    if (!statSync(target).isFile()) throw new Error('Not a file');
  } catch {
    response.writeHead(404).end('Not found');
    return;
  }

  response.writeHead(200, {
    'Cache-Control': 'no-store',
    'Content-Type': mimeTypes.get(extname(target).toLowerCase()) || 'application/octet-stream',
  });
  if (request.method === 'HEAD') {
    response.end();
    return;
  }
  createReadStream(target).pipe(response);
});

server.listen(port, '127.0.0.1', () => {
  console.log(`Podgląd CarOffers: http://127.0.0.1:${port}`);
  console.log('Zatrzymaj serwer przez Ctrl+C.');
});

server.on('error', (error) => {
  console.error(`Nie udało się uruchomić podglądu: ${error.message}`);
  process.exitCode = 1;
});
