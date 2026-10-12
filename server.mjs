import http from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createAihotFeed } from './aihot-feed.mjs';

const root = dirname(fileURLToPath(import.meta.url));

export async function createApp(dataDir = process.env.DATA_DIR || join(root, 'data'), { resetFeed } = {}) {
  await mkdir(dataDir, { recursive: true });
  const getReset = resetFeed || createAihotFeed({ cacheFile: join(dataDir, 'reset-feed.json') });
  const files = { '/': 'index.html', '/monitor': 'monitor.html', '/style.css': 'style.css', '/app.js': 'app.js', '/monitor.css': 'monitor.css', '/monitor.js': 'monitor.js', '/monitor-data.js': 'monitor-data.js', '/smartkey-cat-loop.gif': 'smartkey-cat-loop.gif' };
  const send = (res, code, value) => {
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(value));
  };
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      if (req.method !== 'GET') return send(res, 405, { error: '请求方式不支持' });
      if (url.pathname === '/api/aihot-reset') {
        try { return send(res, 200, await getReset()); }
        catch (error) { return send(res, 503, { error: error.status === 429 ? '数据源请求频率受限，页面会自动重试。' : '数据源暂时无法连接，请稍后再试。', retryAt: error.retryAt }); }
      }
      if (url.pathname === '/' && !['auto', 'aihot'].includes(url.searchParams.get('source'))) {
        res.writeHead(302, { Location: '/monitor', 'Cache-Control': 'no-store' });
        return res.end();
      }
      const file = files[url.pathname];
      if (!file) return send(res, 404, { error: '页面不存在' });
      const types = { html: 'text/html', css: 'text/css', js: 'text/javascript', gif: 'image/gif' };
      const ext = file.split('.').pop();
      const body = await readFile(join(root, 'public', file));
      res.writeHead(200, { 'Content-Type': `${types[ext]}${ext === 'gif' ? '' : '; charset=utf-8'}`, 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
      res.end(body);
    } catch {
      if (!res.headersSent) send(res, 500, { error: '页面暂时无法读取，请稍后重试。' });
      else res.end();
    }
  });
}

export function startFeedCollection(server, { fetch: fetchImpl = globalThis.fetch } = {}) {
  const collect = async () => {
    try {
      const response = await fetchImpl(`http://127.0.0.1:${server.address().port}/api/aihot-reset`, { signal: AbortSignal.timeout(25_000), redirect: 'error' });
      await response.arrayBuffer();
      if (!response.ok) console.warn(`监控定时采集暂未完成（HTTP ${response.status}）。`);
    } catch { console.warn('监控定时采集暂未完成，稍后自动重试。'); }
  };
  const interval = setInterval(collect, 600_000);
  interval.unref();
  server.once('close', () => clearInterval(interval));
  void collect();
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const server = await createApp();
  const port = Number(process.env.PORT || 4318);
  server.listen(port, process.env.HOST || '127.0.0.1', () => {
    startFeedCollection(server);
    console.log(`Codex 重置监控已启动：http://127.0.0.1:${port}/monitor`);
  });
}
