import { beijingDay, eventDay, nextWindow, forecast, sourceUrl } from './monitor-data.js';
if (new URLSearchParams(location.search).get('embed') === '1') document.body.classList.add('embedded');

const $ = id => document.getElementById(id);
let today = beijingDay(new Date().toISOString());
let month = today.slice(0, 7);
let selected = today;
let events = [];
let language = 'zh';
let loading = false;
let hasFeed = false;
let retryAt = 0;
let retryTimer;
const time = value => value && Number.isFinite(Date.parse(value)) ? new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(value)) : '时间待确认';
const node = (tag, className, text) => {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
};
const link = (text, url, className) => {
  const href = sourceUrl(url);
  if (!href) return null;
  const el = node('a', className, text);
  el.href = href; el.target = '_blank'; el.rel = 'noopener noreferrer';
  return el;
};
const statusLabel = event => ({ confirmed: '已确认', announced: '公开预告', in_progress: '正在下发', expired_unconfirmed: '窗口已过，待确认', likely_completed: '可能完成，未确认' })[event.presentation?.status || event.status] || '状态待核实';

function updateToday() {
  today = beijingDay(new Date().toISOString());
  $('today-date').textContent = today.slice(5).replace('-', '.');
  $('today-weekday').textContent = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', weekday: 'long' }).format(new Date());
  $('today-label').textContent = `${today.slice(0, 4)} · 北京时间`;
  renderCalendar();
}

function renderWindow() {
  const upcoming = nextWindow(events);
  const unresolved = events.find(event => event.status === 'announced' && !['confirmed', 'likely_completed'].includes(event.presentation?.status));
  const estimate = upcoming && forecast(upcoming);
  $('window-details').replaceChildren();
  $('window-state').textContent = upcoming ? upcoming.estimate ? '预测窗口' : 'Tibo 公开预告' : unresolved ? statusLabel(unresolved) : '等待新的公开预告';
  $('window-title').textContent = upcoming ? upcoming.presentation?.status === 'in_progress' ? '正在下发\n预计完成窗口' : '下一次重置\n预计窗口' : unresolved ? forecast(unresolved) ? '预告窗口已过\n等待确认' : '已有重置预告\n时间待确认' : '下一次重置\n暂无预告';
  $('window-description').textContent = upcoming ? upcoming.estimate ? '根据公开预告估算，不代表 Tibo 的完成承诺或个人到账时间。' : '根据 Tibo 公开预告换算，实际完成情况以确认帖为准。' : unresolved ? '已有预告尚未获得完成确认，具体完成情况以确认帖为准。' : '当前已核实记录中暂无新预告，发布后预计时间会显示在这里。';
  if (upcoming) {
    $('window-details').append(node('strong', '', estimate.label || `${time(estimate.from)} — ${time(estimate.through)}`), node('span', '', upcoming.presentation?.audienceZh || '适用人群未明确'));
    if (upcoming.estimate?.reason) $('window-details').append(node('p', 'estimate-reason', upcoming.estimate.reason));
    if (upcoming.estimate && upcoming.schedule) $('window-details').append(node('p', 'estimate-reason', `原预告：${upcoming.schedule.label}`));
  }
  const latest = events[0];
  $('latest-event').replaceChildren();
  if (latest) {
    $('latest-event').append(node('span', '', latest.title || latest.displayLabel || '重置动态'), node('span', 'latest-sub', `${statusLabel(latest)} · ${time(latest.confirmedAt || latest.createdAt)}`));
  } else $('latest-event').textContent = '暂无公开记录';
}

function renderCalendar() {
  const [year, m] = month.split('-').map(Number);
  $('month-label').textContent = `${year} 年 ${m} 月`;
  const first = new Date(Date.UTC(year, m - 1, 1));
  const leading = (first.getUTCDay() + 6) % 7;
  const days = new Date(Date.UTC(year, m, 0)).getUTCDate();
  const fragment = document.createDocumentFragment();
  for (let i = 0; i < leading; i++) fragment.append(node('span'));
  for (let d = 1; d <= days; d++) {
    const day = `${month}-${String(d).padStart(2, '0')}`;
    const records = events.filter(event => eventDay(event) === day);
    const confirmed = records.some(event => event.status === 'confirmed');
    const types = [...new Set(records.map(event => event.presentation?.kindExplicit === false ? '方式未明' : ({ direct_reset: '直接重置', reset_credit: '发重置卡' })[event.type]).filter(Boolean))];
    const btn = node('button', `${confirmed ? 'confirmed-day ' : ''}${day === today ? 'today-day ' : ''}${day === selected ? 'selected' : ''}`, String(d));
    btn.type = 'button'; btn.setAttribute('aria-pressed', String(day === selected));
    btn.setAttribute('aria-label', `${year}年${m}月${d}日，${!hasFeed ? '记录尚未载入' : records.length ? `${records.length}条记录，${types.join('、')}` : '暂无记录'}`);
    if (types.length) {
      const labels = node('span', 'day-types');
      for (const type of types) labels.append(node('span', '', type));
      btn.append(labels);
    }
    if (records.length) btn.append(node('i', confirmed ? 'day-marker' : 'day-marker pending'));
    btn.addEventListener('click', () => { selected = day; renderCalendar(); renderPosts(); });
    fragment.append(btn);
  }
  $('calendar-grid').replaceChildren(fragment);
}

function renderPost(post) {
  const el = node('article', 'post');
  const meta = node('div', 'post-meta');
  meta.append(node('span', 'post-author', 'Tibo'), node('span', 'post-stage', post.stage || '公开动态'), node('time', '', time(post.publishedAt)));
  const full = language === 'zh' ? post.fullText : post.fullOriginalText;
  const excerpt = language === 'zh' ? post.text : post.originalText;
  el.append(meta, node('p', 'post-text', full || excerpt || '此条未提供文字，请查看原帖。'));
  if (!full && excerpt) el.append(node('span', 'excerpt-note', '本条为摘要，完整内容请查看原帖。'));
  for (const context of post.context || []) {
    const text = language === 'zh' ? context.text : context.originalText;
    if (!text) continue;
    const quote = node('div', 'context-note', text);
    const contextLink = link(`${context.author || '相关上下文'} ↗`, context.url);
    if (contextLink) quote.append(contextLink);
    el.append(quote);
  }
  const original = link('查看 X 原帖 ↗', post.url, 'post-link');
  if (original) el.append(original);
  return el;
}

function renderPosts() {
  const records = events.filter(event => eventDay(event) === selected);
  const [year, m, d] = selected.split('-');
  $('selected-title').textContent = `${Number(m)} 月 ${Number(d)} 日 · 原帖与时间线`;
  $('selected-summary').textContent = `${year} 年 · ${hasFeed ? `${records.length} 条记录` : '记录尚未载入'} · 确认帖时间不等于精确到账时间`;
  $('language-zh').setAttribute('aria-pressed', String(language === 'zh'));
  $('language-en').setAttribute('aria-pressed', String(language === 'en'));
  const fragment = document.createDocumentFragment();
  for (const event of records) {
    const article = node('article', 'event');
    const heading = node('div', 'event-heading');
    heading.append(node('h3', '', event.title || event.displayLabel || '重置动态'), node('span', `event-tag${event.status === 'confirmed' ? '' : ' pending'}`, statusLabel(event)));
    const p = event.presentation || {};
    const product = Array.isArray(p.productsZh) ? p.productsZh.join('、') : p.productsZh;
    const dayBasis = event.occurredOn ? '明确重置日' : event.confirmedAt ? '按确认帖日期归档' : '按预告日期归档';
    article.append(heading, node('p', 'audience', `${p.audienceZh || '适用人群未明确'}${product ? ` · ${product}` : ''} · ${dayBasis}${event.confirmationBasis === 'receipt_review' ? ' · 收据核验确认' : ''}`));
    if (event.posts?.length) {
      const posts = [...event.posts].sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt));
      article.append(renderPost(posts[0]));
      if (posts.length > 1) {
        const details = node('details', 'more-posts');
        const summary = node('summary', '', `展开其余 ${posts.length - 1} 条帖子`);
        details.append(summary);
        for (const post of posts.slice(1)) details.append(renderPost(post));
        details.addEventListener('toggle', () => { summary.textContent = details.open ? '收起其余帖子' : `展开其余 ${posts.length - 1} 条帖子`; });
        article.append(details);
      }
    } else article.append(node('p', 'empty-state', '此记录暂无可展示原帖。'));
    fragment.append(article);
  }
  if (!hasFeed) fragment.append(node('div', 'empty-state', '原帖尚未载入，请等待数据连接恢复。'));
  else if (!records.length) {
    const empty = node('div', 'empty-state');
    empty.append(node('strong', '', '这一天，没有公开记录'), node('span', '', '点击日历中带圆点的日期，查看对应动态与 Tibo 原帖。'));
    fragment.append(empty);
  }
  $('posts').replaceChildren(fragment);
}

async function loadFeed() {
  if (loading || Date.now() < retryAt) return;
  loading = true;
  try {
    const response = await fetch('/api/aihot-reset', { cache: 'no-store' });
    const result = await response.json();
    if (!response.ok) {
      retryAt = Date.parse(result.retryAt) || Date.now() + 600_000;
      clearTimeout(retryTimer);
      retryTimer = setTimeout(loadFeed, Math.max(1000, retryAt - Date.now() + 250));
      throw new Error(result.error);
    }
    clearTimeout(retryTimer);
    retryAt = 0;
    if (!Array.isArray(result.data?.events)) throw new Error('数据格式暂时无法识别');
    const firstLoad = !events.length;
    const next = result.data.events.filter(event => eventDay(event)).sort((a, b) => Date.parse(b.updatedAt || b.createdAt) - Date.parse(a.updatedAt || a.createdAt));
    events = next; hasFeed = true;
    if (firstLoad && !events.some(event => eventDay(event) === selected) && events[0]) { selected = eventDay(events[0]); month = selected.slice(0, 7); }
    $('history-count').textContent = String(events.length);
    $('history-start').textContent = result.data.historyFrom ? `始于 ${beijingDay(result.data.historyFrom)}` : '';
    const monitor = result.data.monitor || {};
    $('freshness').textContent = `采集 ${time(monitor.lastCollectedAt || result.fetchedAt)} · 核实 ${time(monitor.lastVerifiedAt || result.data.checkedAt)}`;
    const message = result.stale ? '数据源暂时无法连接，目前显示上次成功读取的记录。' : monitor.status === 'delayed' ? '核验进度有延迟，请结合最近核实时间阅读。' : !monitor.status || monitor.status === 'unknown' ? '数据源核验进度暂不明确，请结合最近核实时间阅读。' : '';
    $('feed-message').hidden = !message;
    $('feed-message').textContent = message;
    renderWindow(); renderCalendar(); renderPosts();
  } catch (error) {
    $('feed-message').hidden = false;
    $('feed-message').replaceChildren(node('span', '', error.message?.replaceAll('AIHOT', '数据源') || '数据暂时无法读取，请稍后再试。'));
    const retry = node('button', '', '稍后重试');
    retry.type = 'button'; retry.addEventListener('click', loadFeed);
    $('feed-message').append(retry);
    if (!events.length) {
      $('window-state').textContent = '数据暂不可用'; $('window-title').textContent = '暂时无法\n读取预告';
      $('window-description').textContent = '连接恢复后会自动更新。读取失败不代表没有重置。';
      $('latest-event').textContent = '等待数据连接恢复';
      $('posts').replaceChildren(node('div', 'empty-state', '暂时无法读取原帖，请稍后再试。'));
      $('freshness').textContent = '数据源连接暂时中断';
    }
  } finally { loading = false; }
}

for (const [id, offset] of [['prev-month', -1], ['next-month', 1]]) $(id).addEventListener('click', () => {
  const [year, m] = month.split('-').map(Number);
  const date = new Date(Date.UTC(year, m - 1 + offset, 1));
  month = date.toISOString().slice(0, 7); renderCalendar();
});
$('current-month').addEventListener('click', () => { month = today.slice(0, 7); selected = today; renderCalendar(); renderPosts(); });
for (const lang of ['zh', 'en']) $(`language-${lang}`).addEventListener('click', () => { language = lang; renderPosts(); });
updateToday(); loadFeed();
setInterval(() => { if (!document.hidden) updateToday(); }, 60_000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) updateToday(); });
setInterval(() => { if (!document.hidden) loadFeed(); }, 600_000);
