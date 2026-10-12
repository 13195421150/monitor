import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import * as monitorData from './public/monitor-data.js';

const appUrl = new URL('./public/app.js', import.meta.url);
const appSource = readFileSync(appUrl, 'utf8');
const pageSource = readFileSync(new URL('./public/index.html', import.meta.url), 'utf8');
const confirmedTitle = '是，额度已重置';
const noAnnouncementTitle = '暂无已确认的重置公告';
const unavailableTitle = '数据暂时无法加载';
const initialTime = Date.parse('2026-10-11T13:00:00+08:00');
const feed = (reset, values = {}) => ({
  data: { schemaVersion: 1, today: '2026-10-11', events: reset ? [{
    id: 'confirmed-today', status: 'confirmed', title: '重置已完成', occurredOn: '2026-10-11',
    confirmedAt: '2026-10-11T11:00:00+08:00', updatedAt: '2026-10-11T11:00:00+08:00',
    posts: [{ url: 'https://x.com/thsottiaux/status/123' }],
  }] : [] },
  stale: false, fetchedAt: '2026-10-11T04:00:00Z', ...values,
});
const response = value => ({ ok: true, json: async () => value });

function element() {
  const classes = new Set();
  const added = [];
  return {
    textContent: '', innerHTML: '', dataset: {}, disabled: false, offsetWidth: 300,
    attributes: {}, listeners: new Map(), added,
    classList: {
      add(...names) { names.forEach(name => { classes.add(name); added.push(name); }); },
      remove(...names) { names.forEach(name => classes.delete(name)); },
      contains(name) { return classes.has(name); },
      toggle(name, force = !classes.has(name)) { if (force) classes.add(name); else classes.delete(name); return force; },
    },
    setAttribute(name, value) { this.attributes[name] = value; },
    addEventListener(name, listener) { this.listeners.set(name, listener); },
  };
}

async function page({ search = '?embed=1&source=auto', time = initialTime, replies }) {
  const nodes = new Map([...pageSource.matchAll(/\bid="([^"]+)"/g)].map(match => [match[1], element()]));
  nodes.get('broadcast').dataset.state = 'unknown';
  nodes.get('replay').disabled = true;
  const document = {
    body: element(), hidden: false, listeners: new Map(),
    getElementById: id => nodes.get(id), querySelector: () => element(), getAnimations: () => [],
    addEventListener(name, listener) { this.listeners.set(name, listener); },
  };
  const calls = [];
  const timeouts = new Map();
  const intervals = [];
  let timerId = 0;
  let currentTime = time;
  class FakeDate extends Date {
    constructor(...args) { super(...(args.length ? args : [currentTime])); }
    static now() { return currentTime; }
  }
  const window = {};
  const context = vm.createContext({
    document, window, location: { search }, URLSearchParams, Date: FakeDate, Intl,
    localStorage: { getItem: () => 'off', setItem() {} }, matchMedia: () => ({ matches: false }),
    fetch: async (url, options) => {
      calls.push({ url, options });
      const next = replies.shift();
      if (next instanceof Error) throw next;
      assert.ok(next, 'every UI request needs an explicit fake response');
      return next;
    },
    setTimeout(fn, delay) { timeouts.set(++timerId, { fn, delay }); return timerId; },
    clearTimeout(id) { timeouts.delete(id); },
    setInterval(fn, delay) { intervals.push({ fn, delay }); },
  });
  new vm.Script(appSource, {
    filename: fileURLToPath(appUrl),
    importModuleDynamically(specifier) {
      assert.equal(specifier, './monitor-data.js?v=20261011-broadcast-states2');
      return monitorData;
    },
  }).runInContext(context);
  const settle = () => new Promise(resolve => setImmediate(resolve));
  await settle();
  return {
    nodes, document, window, calls, timeouts, intervals,
    text: id => nodes.get(id).textContent,
    visibleCopy: () => [...nodes.values()].map(node => `${node.textContent} ${node.innerHTML}`).join(' '),
    reveals: () => nodes.get('broadcast').added.filter(name => name === 'revealing').length,
    async poll() { intervals.find(timer => timer.delay === 30_000).fn(); await settle(); },
    tick(now) { currentTime = now; intervals.find(timer => timer.delay === 1000).fn(); },
    async replay() { await nodes.get('replay').listeners.get('click')(); },
    runTimeout(delay) {
      const [id, timer] = [...timeouts].find(([, timer]) => timer.delay === delay);
      timeouts.delete(id); timer.fn();
    },
    finishReveal() {
      for (const [id, timer] of [...timeouts].sort((a, b) => a[1].delay - b[1].delay)) {
        if (!timeouts.has(id)) continue;
        timeouts.delete(id);
        timer.fn();
      }
    },
  };
}

test('automatic broadcast reveals a confirmed result only after the animation and replays neutrally', async () => {
    const ui = await page({ replies: [response(feed(true))] });
    assert.deepEqual(ui.calls.map(call => call.url), ['/api/aihot-reset']);
    assert.equal(ui.calls[0].options.cache, 'no-store');
    assert.equal(ui.document.body.classList.contains('embedded'), true);
    assert.equal(ui.text('result-title'), '接收最新信号');
    assert.equal(ui.nodes.get('broadcast').dataset.state, 'unknown');
    ui.runTimeout(1550);
    assert.equal(ui.text('result-title'), '接收最新信号', 'the wipe stage must not disclose the result');
    ui.finishReveal();
    assert.equal(ui.text('result-title'), confirmedTitle);
    assert.equal(ui.nodes.get('broadcast').dataset.state, 'yes');
    assert.equal(ui.text('date'), '10.11');
    assert.equal(ui.text('result-description'), '');
    assert.doesNotMatch(ui.visibleCopy(), /aihot/i);
    await ui.replay();
    assert.equal(ui.text('result-title'), '接收最新信号');
    assert.equal(ui.nodes.get('broadcast').dataset.state, 'unknown');
    ui.finishReveal();
    assert.equal(ui.text('result-title'), confirmedTitle);
});

test('a successful feed without a confirmed announcement never claims an unreset result', async () => {
  const ui = await page({ replies: [response(feed(false))] });
  assert.equal(ui.text('result-title'), noAnnouncementTitle);
  assert.equal(ui.text('result-description'), '有新的已确认公告后会自动更新。');
  assert.equal(ui.nodes.get('broadcast').dataset.state, 'unknown');
  assert.equal(ui.text('signal-code'), 'STANDBY');
  assert.equal(ui.nodes.get('replay').disabled, true);
  assert.equal(ui.reveals(), 0);
  assert.doesNotMatch(ui.visibleCopy(), /aihot|是，额度已重置|否，额度未重置|RESET \/ (YES|NO)/i);
});

test('a pending automatic request stays neutral and legacy source links remain supported', async () => {
  let resolveRequest;
  const pendingResponse = new Promise(resolve => { resolveRequest = resolve; });
  const ui = await page({ replies: [pendingResponse] });
  assert.equal(ui.text('result-title'), '');
  assert.match(ui.text('result-description'), /正在读取/);
  assert.equal(ui.nodes.get('broadcast').dataset.state, 'unknown');
  assert.equal(ui.reveals(), 0);
  assert.doesNotMatch(ui.visibleCopy(), /aihot|是，额度已重置|否，额度未重置/i);
  resolveRequest(response(feed(true)));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(ui.text('result-title'), '接收最新信号');
  ui.finishReveal();
  assert.equal(ui.text('result-title'), confirmedTitle);
  const legacy = await page({ search: '?source=aihot', replies: [response(feed(false))] });
  assert.deepEqual(legacy.calls.map(call => call.url), ['/api/aihot-reset']);
  assert.equal(legacy.text('result-title'), noAnnouncementTitle);
  legacy.finishReveal();
  assert.equal(legacy.text('result-title'), noAnnouncementTitle);
  assert.doesNotMatch(legacy.visibleCopy(), /aihot/i);
});

test('confirmation and freshness metadata updates refresh the label without replaying the animation', async () => {
  const first = feed(true);
  const second = feed(true, { fetchedAt: '2026-10-11T04:30:00Z' });
  second.data.events[0].confirmedAt = '2026-10-11T12:00:00+08:00';
  second.data.events[0].updatedAt = '2026-10-11T12:00:00+08:00';
  const ui = await page({ replies: [response(first), response(second)] });
  ui.finishReveal();
  const oldLabel = ui.text('record-time');
  const reveals = ui.reveals();
  await ui.poll();
  assert.equal(ui.reveals(), reveals);
  assert.equal(ui.timeouts.size, 0);
  assert.equal(ui.text('result-title'), confirmedTitle);
  assert.notEqual(ui.text('record-time'), oldLabel);
  assert.match(ui.text('record-time'), /12:00/);
});

test('a network failure replaces any previously valid result with unavailable until a successful retry', async () => {
  for (const reset of [true, false]) {
    const ui = await page({ replies: [response(feed(reset)), new Error('offline'), response(feed(reset))] });
    ui.finishReveal();
    const reveals = ui.reveals();
    await ui.poll();
    assert.equal(ui.text('result-title'), unavailableTitle);
    assert.equal(ui.text('result-description'), '正在自动重试，请稍后再查看。');
    assert.equal(ui.nodes.get('broadcast').dataset.state, 'unknown');
    assert.equal(ui.text('signal-code'), 'UNAVAILABLE');
    assert.equal(ui.nodes.get('replay').disabled, true);
    assert.equal(ui.timeouts.size, 0);
    assert.equal(ui.reveals(), reveals);
    assert.match(ui.text('phase-label'), /等待更新/);
    assert.equal(ui.nodes.get('connection-dot').classList.contains('offline'), true);
    assert.doesNotMatch(ui.visibleCopy(), /aihot|是，额度已重置|否，额度未重置|RESET \/ (YES|NO)/i);
    ui.tick(Date.parse('2026-10-11T16:00:00Z'));
    assert.equal(ui.text('result-title'), unavailableTitle, 'the clock must not restore evidence after a failed request');
    ui.tick(initialTime);
    await ui.poll();
    if (reset) assert.equal(ui.text('result-title'), '接收最新信号');
    ui.finishReveal();
    assert.equal(ui.text('result-title'), reset ? confirmedTitle : noAnnouncementTitle);
    assert.equal(ui.nodes.get('connection-dot').classList.contains('offline'), false);
  }
});

test('the Beijing midnight clock changes yesterday evidence to no announcement with the new visible date', async () => {
  const ui = await page({ time: Date.parse('2026-10-11T15:59:59Z'), replies: [response(feed(true))] });
  ui.finishReveal();
  assert.equal(ui.text('result-title'), confirmedTitle);
  ui.tick(Date.parse('2026-10-11T16:00:00Z'));
  assert.equal(ui.text('date'), '10.12');
  assert.equal(ui.text('result-title'), noAnnouncementTitle);
  ui.finishReveal();
  assert.equal(ui.nodes.get('broadcast').dataset.state, 'unknown');
  assert.equal(ui.nodes.get('replay').disabled, true);
  assert.equal(ui.calls.length, 1, 'midnight recalculation must not depend on another successful request');
});

test('initial HTTP, network, malformed JSON and schema failures show unavailable without fabricating a result', async () => {
  for (const reply of [{ ok: false }, new Error('offline'), { ok: true, json: async () => { throw new SyntaxError('invalid JSON'); } }, response({ data: {} })]) {
    const ui = await page({ replies: [reply] });
    assert.deepEqual(ui.calls.map(call => call.url), ['/api/aihot-reset']);
    assert.equal(ui.text('result-title'), unavailableTitle);
    assert.equal(ui.nodes.get('broadcast').dataset.state, 'unknown');
    assert.equal(ui.text('result-description'), '正在自动重试，请稍后再查看。');
    assert.equal(ui.text('record-time'), '暂无可用公告数据');
    assert.equal(ui.nodes.get('replay').disabled, true);
    assert.equal(ui.reveals(), 0);
    assert.doesNotMatch(ui.visibleCopy(), /aihot|是，额度已重置|否，额度未重置|RESET \/ (YES|NO)/i);
  }
});

test('stale cached evidence is unavailable even when it contains a same-day confirmation', async () => {
  for (const value of [feed(true, { stale: true }), feed(false, { stale: true }), feed(true, { error: 'upstream failed' })]) {
    const ui = await page({ replies: [response(value)] });
    assert.equal(ui.text('result-title'), unavailableTitle);
    assert.equal(ui.nodes.get('broadcast').dataset.state, 'unknown');
    assert.equal(ui.text('signal-code'), 'UNAVAILABLE');
    assert.equal(ui.nodes.get('replay').disabled, true);
    assert.equal(ui.reveals(), 0);
    assert.equal(ui.nodes.get('connection-dot').classList.contains('offline'), true);
    assert.doesNotMatch(ui.visibleCopy(), /aihot|是，额度已重置|否，额度未重置|RESET \/ (YES|NO)/i);
  }
});

test('a failure during the reveal cancels every pending result timer and recovery starts a fresh reveal', async () => {
  const ui = await page({ replies: [response(feed(true)), new Error('offline'), response(feed(true))] });
  assert.equal(ui.text('result-title'), '接收最新信号');
  assert.equal(ui.timeouts.size, 2);
  ui.runTimeout(1550);
  await ui.poll();
  assert.equal(ui.text('result-title'), unavailableTitle);
  assert.equal(ui.timeouts.size, 0);
  for (const className of ['revealing', 'revealed', 'wiping']) assert.equal(ui.nodes.get('broadcast').classList.contains(className), false);
  ui.finishReveal();
  assert.equal(ui.text('result-title'), unavailableTitle);
  assert.equal(ui.nodes.get('replay').disabled, true);
  await ui.poll();
  assert.equal(ui.text('result-title'), '接收最新信号');
  assert.equal(ui.timeouts.size, 2);
  ui.finishReveal();
  assert.equal(ui.text('result-title'), confirmedTitle);
  assert.equal(ui.nodes.get('replay').disabled, false);
});

test('record and frames mode keeps manual status and recording functions even with source=aihot', async () => {
  const ui = await page({ search: '?record=1&frames=1&source=aihot', replies: [response({ reset: true, updatedAt: '2026-10-11T11:00:00+08:00' })] });
  assert.deepEqual(ui.calls.map(call => call.url), ['/api/status']);
  assert.equal(ui.document.body.classList.contains('recording'), true);
  assert.equal(ui.document.body.classList.contains('embedded'), false);
  for (const name of ['recordSignal', 'beginFrameRender', 'renderSignalFrame']) assert.equal(typeof ui.window[name], 'function');
  assert.equal(ui.intervals.length, 0);
  assert.equal(ui.reveals(), 0);
});
