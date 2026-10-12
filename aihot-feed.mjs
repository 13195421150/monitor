import { readFileSync, writeFileSync, renameSync } from 'node:fs';

const SOURCE = 'https://aihot.news/api/v1/codex-resets';
const CACHE_MS = 10 * 60 * 1000;
const validData = data => data?.schemaVersion === 1 && Array.isArray(data.events) && data.events.every(event => event && typeof event === 'object' && Array.isArray(event.posts));

export function createAihotFeed({ fetch: fetchImpl = globalThis.fetch, clock = Date.now, timeoutMs = 20_000, cacheFile } = {}) {
  let cache;
  let cachedAt = 0;
  let etag;
  let inFlight;
  let nextRequestAt = 0;
  let lastError;
  if (cacheFile) {
    try {
      const saved = JSON.parse(readFileSync(cacheFile, 'utf8'));
      if (!saved || !Number.isFinite(saved.cachedAt) || !Number.isFinite(saved.nextRequestAt) ||
          (saved.cache !== undefined && (!validData(saved.cache?.data) || !Number.isFinite(Date.parse(saved.cache.fetchedAt)))) ||
          (saved.etag != null && typeof saved.etag !== 'string') ||
          (saved.error != null && typeof saved.error !== 'string') ||
          (saved.errorStatus != null && !Number.isInteger(saved.errorStatus))) throw new Error('AIHOT 缓存格式无效');
      cache = saved.cache;
      cachedAt = saved.cachedAt;
      etag = saved.etag;
      nextRequestAt = saved.nextRequestAt;
      if (saved.error) {
        lastError = new Error(saved.error);
        lastError.retryAt = new Date(nextRequestAt).toISOString();
        if (saved.errorStatus != null) lastError.status = saved.errorStatus;
      }
    } catch (error) {
      if (error.code !== 'ENOENT') console.warn('AIHOT 缓存读取失败:', error.message);
    }
  }
  const persist = () => {
    if (!cacheFile) return;
    try {
      writeFileSync(`${cacheFile}.tmp`, JSON.stringify({ cache, cachedAt, etag, nextRequestAt, error: lastError?.message, errorStatus: lastError?.status }));
      renameSync(`${cacheFile}.tmp`, cacheFile);
    } catch (error) {
      console.warn('AIHOT 缓存保存失败:', error.message);
    }
  };
  const result = (stale, error) => ({
    data: cache.data, stale, fetchedAt: cache.fetchedAt,
    ...(error ? { error } : {}),
  });

  const refresh = async () => {
    nextRequestAt = clock() + CACHE_MS;
    persist();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('AIHOT 请求超时')), timeoutMs);
    try {
      const headers = { 'User-Agent': 'aihot-api/2.0.0', Accept: 'application/json' };
      if (etag) headers['If-None-Match'] = etag;
      const response = await fetchImpl(SOURCE, { method: 'GET', headers, signal: controller.signal });
      if ([429, 503].includes(response.status)) {
        const retryAfter = response.headers.get('retry-after');
        if (retryAfter !== null && retryAfter.trim()) {
          const seconds = Number(retryAfter);
          const until = Number.isFinite(seconds) && seconds >= 0
            ? clock() + seconds * 1000 : Date.parse(retryAfter);
          if (Number.isFinite(until)) nextRequestAt = Math.max(nextRequestAt, until);
        }
      }
      if (response.status === 304) {
        if (!cache) throw new Error('AIHOT 返回 304，但没有可用缓存');
      } else {
        if (!response.ok) throw Object.assign(new Error(`AIHOT 请求失败（HTTP ${response.status}）`), { status: response.status });
        const data = await response.json();
        if (!validData(data)) throw new Error('AIHOT 数据格式无效');
        cache = { data };
        etag = response.headers.get('etag');
      }
      cachedAt = clock();
      cache.fetchedAt = new Date(cachedAt).toISOString();
      lastError = undefined;
      persist();
      return result(false);
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      lastError.retryAt = new Date(nextRequestAt).toISOString();
      persist();
      if (cache) return result(true, lastError.message);
      throw lastError;
    } finally {
      clearTimeout(timer);
    }
  };

  return function getAihotReset() {
    if (inFlight) return inFlight;
    const now = clock();
    if (cache && now - cachedAt < CACHE_MS) return Promise.resolve(result(false));
    if (now < nextRequestAt) {
      if (!lastError) lastError = Object.assign(new Error('AIHOT 请求冷却中，请稍后重试'), { retryAt: new Date(nextRequestAt).toISOString() });
      return cache ? Promise.resolve(result(true, lastError?.message)) : Promise.reject(lastError);
    }
    inFlight = refresh().finally(() => { inFlight = undefined; });
    return inFlight;
  };
}
