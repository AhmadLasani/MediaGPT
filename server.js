#!/usr/bin/env node
// MediaGPT: zero-dependency Node.js server (REST API + web console).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MediaGPT } from './src/service.js';
import { createApiHandler } from './src/api.js';
import { llmStatus } from './src/llm.js';

const root = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);
const DATA_FILE = process.env.MEDIAGPT_DATA || path.join(root, 'data', 'db.json');

const app = new MediaGPT({ file: DATA_FILE });
const api = createApiHandler(app);

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json', '.txt': 'text/plain', '.png': 'image/png' };
const PUBLIC = path.join(root, 'public');

function serveStatic(url, res) {
  let p;
  try { p = decodeURIComponent(url.pathname); } catch { p = '/'; }
  let file = path.resolve(PUBLIC, '.' + path.posix.normalize(p));
  // Only files inside public/ are served; anything else falls back to the SPA shell.
  if (!file.startsWith(PUBLIC + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(PUBLIC, 'index.html');
  res.writeHead(200, { 'content-type': `${TYPES[path.extname(file)] || 'application/octet-stream'}; charset=utf-8`, 'x-content-type-options': 'nosniff' });
  fs.createReadStream(file).pipe(res);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (url.pathname.startsWith('/api/')) return api(req, res, url);
  serveStatic(url, res);
});

// Keep "always-on listening" honest: re-run detection every minute.
setInterval(() => { try { app.refreshAlerts(); } catch (e) { console.error(e); } }, 60_000).unref();

server.listen(PORT, async () => {
  const ai = await llmStatus();
  console.log(`\n  MediaGPT running   → http://localhost:${PORT}`);
  console.log(`  REST API               → http://localhost:${PORT}/api/v1/health`);
  console.log(`  Data file              → ${DATA_FILE}`);
  console.log(`  Copilot engine         → ${ai.enabled ? `Claude (${ai.model}) grounded on local evidence` : 'local explainable engine (set ANTHROPIC_API_KEY to enable Claude)'}\n`);
});
