import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createApp, startFeedCollection } from './server.mjs';

async function fixture(t, resetFeed) {
  const dir = await mkdtemp(join(tmpdir(), 'monitor-test-'));
  const server = await createApp(dir, { resetFeed });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(dir, { recursive: true, force: true }); });
  return { server, url: `http://127.0.0.1:${server.address().port}` };
}

test('standalone monitor and nested automatic broadcast both resolve without iframe recursion', async t => {
  const { url } = await fixture(t, async () => ({ data: { events: [] }, stale: false }));
  const root = await fetch(url, { redirect: 'manual' });
  assert.equal(root.status, 302); assert.equal(root.headers.get('location'), '/monitor');
  const monitor = await (await fetch(`${url}/monitor`)).text();
  assert.match(monitor, /src="\/\?embed=1&amp;source=auto"/);
  const broadcast = await (await fetch(`${url}/?embed=1&source=auto`)).text();
  assert.match(broadcast, /id="broadcast"/);
  assert.doesNotMatch(broadcast, /title="Codex 额度重置动画播报"/);
  for (const path of ['/app.js', '/monitor.js', '/monitor-data.js', '/monitor.css', '/style.css', '/smartkey-cat-loop.gif']) assert.equal((await fetch(`${url}${path}`)).status, 200);
});

test('source failure remains an unavailable response and public service has no write or admin endpoints', async t => {
  const { url } = await fixture(t, async () => { throw Object.assign(new Error('offline'), { retryAt: '2026-10-12T01:00:00Z' }); });
  const failure = await fetch(`${url}/api/aihot-reset`);
  assert.equal(failure.status, 503); const payload = await failure.json();
  assert.equal(payload.reset, undefined); assert.equal(payload.retryAt, '2026-10-12T01:00:00Z');
  assert.equal((await fetch(`${url}/api/aihot-reset`, { method: 'POST' })).status, 405);
  for (const path of ['/admin', '/api/status', '/daily', '/../server.mjs']) assert.equal((await fetch(`${url}${path}`)).status, 404);
});

test('background collection starts without visitor traffic and consumes its response body', async t => {
  const { server, url } = await fixture(t, async () => ({}));
  let requested, consumed = false;
  startFeedCollection(server, { fetch: async (address, options) => {
    requested = address; assert.equal(options.redirect, 'error');
    return { ok: true, arrayBuffer: async () => { consumed = true; } };
  } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(requested, `${url}/api/aihot-reset`); assert.equal(consumed, true);
});
