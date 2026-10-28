const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, 'dist');
const host = '127.0.0.1';
const initialPort = Number(process.env.PORT || 5173);
const types = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.mjs':'text/javascript; charset=utf-8', '.css':'text/css; charset=utf-8', '.json':'application/json; charset=utf-8', '.png':'image/png', '.jpg':'image/jpeg', '.jpeg':'image/jpeg', '.svg':'image/svg+xml', '.webp':'image/webp', '.ico':'image/x-icon', '.wasm':'application/wasm', '.glb':'model/gltf-binary', '.gltf':'model/gltf+json', '.b3dm':'application/octet-stream', '.ktx2':'image/ktx2', '.woff':'font/woff', '.woff2':'font/woff2' };
if (!fs.existsSync(path.join(root, 'index.html')) || !fs.existsSync(path.join(root, 'cesium', 'Cesium.js'))) {
  console.error('Missing dist application. Run npm ci and npm run build to rebuild.');
  process.exit(1);
}
if (!Number.isInteger(initialPort) || initialPort < 1024 || initialPort > 65515) {
  console.error('PORT must be an integer between 1024 and 65515.');
  process.exit(1);
}
const server = http.createServer((req, res) => {
  if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405, { Allow:'GET, HEAD' }); res.end(); return; }
  let pathname;
  try { pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname); }
  catch { res.writeHead(400); res.end('Bad request'); return; }
  if (pathname.includes('\0') || pathname.includes('\\')) { res.writeHead(400); res.end('Bad request'); return; }
  let file = path.resolve(root, '.' + pathname);
  if (file !== root && !file.startsWith(root + path.sep)) { res.writeHead(403); res.end('Forbidden'); return; }
  fs.stat(file, (error, stat) => {
    if (error) { res.writeHead(404); res.end('Not found'); return; }
    if (stat.isDirectory()) file = path.join(file, 'index.html');
    fs.stat(file, (error, stat) => {
      if (error || !stat.isFile()) { res.writeHead(404); res.end('Not found'); return; }
      res.writeHead(200, { 'Content-Type':types[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Content-Length':stat.size, 'Cache-Control':'no-cache', 'X-Content-Type-Options':'nosniff' });
      if (req.method === 'HEAD') { res.end(); return; }
      const stream = fs.createReadStream(file);
      stream.on('error', () => res.destroy());
      res.on('close', () => stream.destroy());
      stream.pipe(res);
    });
  });
});
let port = initialPort;
server.on('error', (error) => {
  if (error.code === 'EADDRINUSE' && port < initialPort + 20) { port += 1; server.listen(port, host); return; }
  console.error('Unable to start:', error.message);
  process.exit(1);
});
server.on('listening', () => {
  console.log(`DJI route planner: http://${host}:${port}/`);
  console.log('Open the URL above in Chrome or Edge. Keep this window open. Press Ctrl+C to stop.');
});
server.listen(port, host);
