import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAihotFeed } from './aihot-feed.mjs';

const TTL = 10 * 60 * 1000;
const start = Date.parse('2026-10-11T08:00:00Z');
const data = { schemaVersion: 1, checkedAt: '2026-10-11T06:10:22.166+08:00', events: [], monitor: { status: 'attention' } };
const response = (status = 200, headers = {}, value = data) => ({
  status, ok: status >= 200 && status < 300,
  headers: new Headers(headers), json: async () => value,
});

test('fixed source, User-Agent, cache and concurrent request sharing', async () => {
  let time = start;
  let calls = 0;
  let release;
  const get = createAihotFeed({ clock: () => time, fetch: async (url, options) => {
    calls++;
    assert.equal(url, 'https://aihot.news/api/v1/codex-resets');
    assert.equal(options.method, 'GET');
    assert.equal(options.headers['User-Agent'], 'aihot-api/2.0.0');
    assert.equal(options.headers['If-None-Match'], undefined);
    await new Promise(resolve => { release = resolve; });
    return response(200, { ETag: '"v1"' });
  } });
  const first = get();
  const second = get();
  assert.equal(first, second);
  release();
  const result = await first;
  assert.deepEqual(result, { data, stale: false, fetchedAt: new Date(start).toISOString() });
  time += TTL - 1;
  assert.deepEqual(await get(), result);
  assert.equal(calls, 1);
  assert.equal(result.data.checkedAt, data.checkedAt);
});

test('ETag revalidation accepts 304 without rewriting upstream checkedAt', async () => {
  let time = start;
  let calls = 0;
  const get = createAihotFeed({ clock: () => time, fetch: async (_, options) => {
    calls++;
    if (calls === 1) return response(200, { ETag: '"v1"' });
    assert.equal(options.headers['If-None-Match'], '"v1"');
    return response(304);
  } });
  await get();
  time += TTL;
  const result = await get();
  assert.equal(result.stale, false);
  assert.equal(result.data, data);
  assert.equal(result.data.checkedAt, '2026-10-11T06:10:22.166+08:00');
  assert.equal(result.fetchedAt, new Date(time).toISOString());
  time += TTL - 1;
  await get();
  assert.equal(calls, 2);
});

test('expired cache survives upstream failure and failed requests are throttled', async () => {
  let time = start;
  let calls = 0;
  const get = createAihotFeed({ clock: () => time, fetch: async () => {
    if (++calls === 1) return response();
    throw new Error('upstream unavailable');
  } });
  const fresh = await get();
  time += TTL;
  const stale = await get();
  assert.deepEqual(stale, { ...fresh, stale: true, error: 'upstream unavailable' });
  time += TTL - 1;
  assert.deepEqual(await get(), stale);
  assert.equal(calls, 2);
});

for (const [status, header] of [[429, '1200'], [503, new Date(start + 2 * TTL).toUTCString()]]) {
  test(`HTTP ${status} respects Retry-After before retrying`, async () => {
    let time = start;
    let calls = 0;
    const get = createAihotFeed({ clock: () => time, fetch: async () => {
      return ++calls === 1 ? response(status, { 'Retry-After': header }) : response();
    } });
    await assert.rejects(get(), new RegExp(`HTTP ${status}`));
    time += 2 * TTL - 1;
    await assert.rejects(get(), new RegExp(`HTTP ${status}`));
    assert.equal(calls, 1);
    time++;
    assert.equal((await get()).stale, false);
    assert.equal(calls, 2);
  });
}

test('Retry-After serves stale cache while delaying the next fetch', async () => {
  let time = start;
  let calls = 0;
  const get = createAihotFeed({ clock: () => time, fetch: async () => {
    if (++calls === 1) return response();
    if (calls === 2) return response(429, { 'Retry-After': '1200' });
    return response();
  } });
  await get();
  time += TTL;
  assert.equal((await get()).stale, true);
  time += 2 * TTL - 1;
  assert.equal((await get()).stale, true);
  assert.equal(calls, 2);
  time++;
  assert.equal((await get()).stale, false);
  assert.equal(calls, 3);
});

test('timeout without a cache throws an explicit error', async () => {
  const get = createAihotFeed({ timeoutMs: 5, fetch: async (_, { signal }) => {
    await new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  } });
  await assert.rejects(get(), /超时/);
});

test('invalid JSON without a cache is an explicit failure', async () => {
  const get = createAihotFeed({ fetch: async () => ({ ...response(), json: async () => { throw new SyntaxError('invalid JSON'); } }) });
  await assert.rejects(get(), /invalid JSON/);
});

test('malformed events never replace the last usable snapshot', async () => {
  for (const events of [null, [null], [{ posts: null }]]) {
    let time = start;
    let calls = 0;
    const get = createAihotFeed({ clock: () => time, fetch: async () => ++calls === 1 ? response() : response(200, {}, { ...data, events }) });
    await get(); time += TTL;
    const result = await get();
    assert.equal(result.stale, true);
    assert.equal(result.data, data);
  }
});

test('restart reuses fresh disk cache and preserves fetchedAt, checkedAt and ETag', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'aihot-feed-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const cacheFile = join(dir, 'cache.json');
  let time = start;
  const first = createAihotFeed({ cacheFile, clock: () => time, fetch: async () => response(200, { ETag: '"v1"' }) });
  const fresh = await first();
  let calls = 0;
  time += TTL - 1;
  const restarted = createAihotFeed({ cacheFile, clock: () => time, fetch: async (_, options) => {
    calls++;
    assert.equal(options.headers['If-None-Match'], '"v1"');
    return response(304);
  } });
  assert.deepEqual(await restarted(), fresh);
  assert.equal(calls, 0);
  time++;
  assert.equal((await restarted()).data.checkedAt, data.checkedAt);
  assert.equal(calls, 1);
});

test('restart preserves last good cache and Retry-After backoff after failure', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'aihot-feed-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const cacheFile = join(dir, 'cache.json');
  let time = start;
  let calls = 0;
  const first = createAihotFeed({ cacheFile, clock: () => time, fetch: async () => ++calls === 1 ? response() : response(429, { 'Retry-After': '1200' }) });
  const fresh = await first();
  time += TTL;
  const stale = await first();
  assert.equal(stale.fetchedAt, fresh.fetchedAt);
  const restarted = createAihotFeed({ cacheFile, clock: () => time, fetch: async () => { calls++; return response(); } });
  time += 2 * TTL - 1;
  assert.deepEqual(await restarted(), stale);
  assert.equal(calls, 2);
  time++;
  assert.equal((await restarted()).stale, false);
  assert.equal(calls, 3);
});

test('cold HTTP 429 remains throttled after restart with status and retryAt', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'aihot-feed-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const cacheFile = join(dir, 'cache.json');
  let time = start;
  let calls = 0;
  const first = createAihotFeed({ cacheFile, clock: () => time, fetch: async () => { calls++; return response(429, { 'Retry-After': '1200' }); } });
  const expected = { status: 429, retryAt: new Date(start + 2 * TTL).toISOString() };
  await assert.rejects(first(), expected);
  const restarted = createAihotFeed({ cacheFile, clock: () => time, fetch: async () => { calls++; return response(); } });
  time += 2 * TTL - 1;
  await assert.rejects(restarted(), expected);
  assert.equal(calls, 1);
  time++;
  assert.equal((await restarted()).stale, false);
  assert.equal(calls, 2);
});

test('restart during an unfinished cold request rejects with a waiting Error', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'aihot-feed-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const cacheFile = join(dir, 'cache.json');
  writeFileSync(cacheFile, JSON.stringify({ cachedAt: 0, nextRequestAt: start + TTL }));
  const get = createAihotFeed({ cacheFile, clock: () => start, fetch: async () => { assert.fail('must wait'); } });
  await assert.rejects(get(), error => error instanceof Error && error.retryAt === new Date(start + TTL).toISOString());
});
