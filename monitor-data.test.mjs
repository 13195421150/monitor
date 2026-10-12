import { test } from 'node:test';
import assert from 'node:assert/strict';
import { beijingDay, eventDay, nextWindow, sourceUrl, todayBroadcast } from './public/monitor-data.js';

test('calendar dates use Beijing time and distinguish event date from confirmation', () => {
  assert.equal(beijingDay('2026-10-10T19:00:00Z'), '2026-10-11');
  assert.equal(eventDay({ occurredOn: '2026-10-09', confirmedAt: '2026-10-11T08:00:00Z' }), '2026-10-09');
  assert.equal(eventDay({ confirmedAt: '2026-10-10T19:00:00Z' }), '2026-10-11');
  assert.equal(beijingDay(null), null);
});

test('completed and expired schedules are not presented as the next reset', () => {
  const now = Date.parse('2026-10-11T12:00:00+08:00');
  const schedule = { from: '2026-10-11T15:00:00+08:00', through: '2026-10-11T15:00:00+08:00' };
  assert.equal(nextWindow([{ status: 'confirmed', schedule }], now), null);
  assert.equal(nextWindow([{ status: 'announced', schedule }], now + 4 * 3600_000), null);
  assert.equal(nextWindow([{ status: 'announced', presentation: { status: 'likely_completed' }, schedule }], now), null);
  const pending = { status: 'announced', schedule };
  assert.equal(nextWindow([pending], now), pending);
  const predicted = { status: 'announced', estimate: { ...schedule, basis: 'model' }, schedule: null };
  assert.equal(nextWindow([predicted], now), predicted);
});

test('source links allow only HTTPS source hosts', () => {
  assert.equal(sourceUrl('https://x.com/thsottiaux/status/123'), 'https://x.com/thsottiaux/status/123');
  for (const url of ['javascript:alert(1)', 'https://x.com.evil.test/', 'http://x.com/', 'not a url']) assert.equal(sourceUrl(url), null);
});

const broadcastNow = Date.parse('2026-10-11T12:00:00+08:00');
const confirmedEvent = (values = {}) => ({
  id: 'today-reset', status: 'confirmed', title: '额度重置已完成',
  createdAt: '2026-10-11T06:00:00+08:00', confirmedAt: '2026-10-11T11:00:00+08:00',
  updatedAt: '2026-10-11T11:00:00+08:00', occurredOn: null,
  posts: [{ url: 'https://x.com/thsottiaux/status/123' }], url: 'https://aihot.news/codex-reset',
  ...values,
});
const broadcastFeed = (events, values = {}) => ({
  data: { schemaVersion: 1, today: '2026-10-11', events }, stale: false,
  fetchedAt: '2026-10-11T03:30:00Z', ...values,
});

test('today broadcast selects the latest confirmed event and preserves its confirmation and source', () => {
  const newest = confirmedEvent({ id: 'newest', confirmedAt: '2026-10-11T11:30:00+08:00', updatedAt: '2026-10-11T11:40:00+08:00' });
  const sameConfirmation = { ...newest, id: 'earlier-update', updatedAt: '2026-10-11T11:35:00+08:00' };
  const feed = broadcastFeed([sameConfirmation, confirmedEvent(), newest]);
  const result = todayBroadcast(feed, broadcastNow);
  assert.equal(result.reset, true);
  assert.equal(result.state, 'confirmed');
  assert.equal(result.date, '2026-10-11');
  assert.equal(result.updatedAt, newest.confirmedAt);
  assert.equal(result.fetchedAt, feed.fetchedAt);
  assert.equal(result.stale, false);
  assert.deepEqual(result.event, { id: 'newest', title: newest.title, sourceUrl: newest.posts[0].url, occurredOn: null, date: '2026-10-11', confirmedAt: newest.confirmedAt, updatedAt: newest.updatedAt });
});

test('today broadcast excludes forecasts and every non-confirmed status', () => {
  const otherStatuses = ['announced', 'likely_completed', 'expired_unconfirmed', 'pending', 'unknown'];
  const events = otherStatuses.map(status => confirmedEvent({ status, presentation: { status: 'confirmed' } }));
  events.push(confirmedEvent({ id: 'yesterday', confirmedAt: '2026-10-10T11:00:00+08:00' }));
  assert.deepEqual(todayBroadcast(broadcastFeed(events), broadcastNow), { reset: null, state: 'no-announcement', date: '2026-10-11', updatedAt: null, fetchedAt: '2026-10-11T03:30:00Z', stale: false, event: null });
  assert.equal(todayBroadcast(broadcastFeed([]), broadcastNow).reset, null);
});

test('explicit occurrence date outranks confirmation date and creation time never establishes a reset day', () => {
  assert.equal(todayBroadcast(broadcastFeed([confirmedEvent({ occurredOn: '2026-10-10' })]), broadcastNow).reset, null);
  assert.equal(todayBroadcast(broadcastFeed([confirmedEvent({ occurredOn: '2026-10-11', confirmedAt: '2026-10-10T12:00:00+08:00' })]), broadcastNow).reset, true);
  assert.equal(todayBroadcast(broadcastFeed([confirmedEvent({ occurredOn: '2026-10-10T19:00:00Z' })]), broadcastNow).reset, true);
  assert.equal(todayBroadcast(broadcastFeed([confirmedEvent({ occurredOn: null, confirmedAt: null })]), broadcastNow).reset, null);
  const explicitDayOnly = todayBroadcast(broadcastFeed([confirmedEvent({ occurredOn: '2026-10-11', confirmedAt: null })]), broadcastNow);
  assert.equal(explicitDayOnly.reset, true);
  assert.equal(explicitDayOnly.updatedAt, null);
});

test('yesterday confirmation becomes no announcement after Beijing midnight', () => {
  const feed = broadcastFeed([confirmedEvent()]);
  assert.equal(todayBroadcast(feed, Date.parse('2026-10-11T15:59:59Z')).reset, true);
  const nextDay = todayBroadcast(feed, Date.parse('2026-10-11T16:00:00Z'));
  assert.equal(nextDay.reset, null);
  assert.equal(nextDay.state, 'no-announcement');
  assert.equal(nextDay.date, '2026-10-12');
  assert.equal(nextDay.updatedAt, null);
});

test('stale or failed data never establishes a current reset result', () => {
  for (const events of [[confirmedEvent()], []]) {
    for (const failure of [{ stale: true }, { error: '数据源暂时无法连接' }]) {
      const result = todayBroadcast(broadcastFeed(events, failure), broadcastNow);
      assert.equal(result.reset, null);
      assert.equal(result.state, 'unavailable');
      assert.equal(result.stale, true);
      assert.equal(result.updatedAt, null);
      assert.equal(result.event, null);
    }
  }
});

test('transport errors and malformed feed schema throw instead of becoming no', () => {
  for (const value of [null, { error: '数据源暂时无法连接' },
    broadcastFeed([], { data: { schemaVersion: 2, events: [] } }),
    broadcastFeed([], { data: { schemaVersion: 1, events: null } }),
    broadcastFeed([null]), broadcastFeed([{}]),
    broadcastFeed([], { fetchedAt: 'invalid' }), broadcastFeed([], { stale: undefined })]) {
    assert.throws(() => todayBroadcast(value, broadcastNow), /今日播报数据格式无效/);
  }
});
