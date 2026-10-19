const TZ = 'Europe/London';
const fmtDate = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(d);
const fmtWeekday = (d, style = 'short') => new Intl.DateTimeFormat('en-GB', { timeZone: TZ, weekday: style }).format(d);
const fmtDayMonth = (d) => new Intl.DateTimeFormat('en-GB', { timeZone: TZ, day: 'numeric', month: 'short' }).format(d);
const fmtTime = (d) => new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(d);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// Every outbound booking link carries UTM tags so venues can see the traffic we send.
function bookingUrl(url, content) {
  try {
    const u = new URL(url);
    u.searchParams.set('utm_source', 'saunafinder');
    u.searchParams.set('utm_medium', 'referral');
    u.searchParams.set('utm_campaign', 'sauna_finder');
    u.searchParams.set('utm_content', content);
    return u.toString();
  } catch {
    return url;
  }
}

// Cookieless usage counting: one small beacon per event, see /api/e.
const landing = new URLSearchParams(location.search);
const campaign = landing.get('utm_source') ?? landing.get('ref');
function track(t, v, d) {
  const body = JSON.stringify({ t, v, d, p: location.pathname, r: document.referrer, u: campaign });
  try {
    if (!navigator.sendBeacon?.('/api/e', body)) fetch('/api/e', { method: 'POST', body, keepalive: true });
  } catch {}
}

// Shorter names for the row labels; the site name sits underneath.
const SHORT = {
  'Community Sauna Baths': 'Community Sauna',
  'Druid Street Saunas': 'Druid Street',
  'The Cabin Sauna': 'The Cabin',
};
const shortName = (v) => SHORT[v.venue] ?? v.venue;
const TOD = {
  any: { label: '', from: 0, to: 24 },
  am: { label: 'morning', from: 0, to: 12 },
  pm: { label: 'afternoon', from: 12, to: 17 },
  eve: { label: 'evening', from: 17, to: 24 },
};

const state = {
  loaded: false,
  date: fmtDate(new Date()),
  tod: 'any',
  need: 1,
  hideFull: false,
  venues: [],
  sessions: [],
  open: null,      // venue id with its detail expanded
  animate: true,   // fills rise once, on the first draw
  dayCache: new Map(),
  patternCache: new Map(),
};

// --- data ------------------------------------------------------------------
async function getJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} returned ${res.status}`);
  return res.json();
}
function loadDay(date) {
  if (!state.dayCache.has(date)) {
    // Members-only priority slots can't be booked by the public, so leave them out.
    state.dayCache.set(date, getJson(`/api/day?date=${date}`)
      .then((d) => d.sessions.filter((s) => !/\bmembers\b/i.test(s.name ?? '')).map(enrich)));
  }
  return state.dayCache.get(date);
}
function enrich(s) {
  const [h, m] = s.start_local.split(':').map(Number);
  const dur = s.duration_min || 60;
  const start = new Date(s.start_utc);
  return {
    ...s, start, end: new Date(start.getTime() + dur * 60000),
    h0: h + m / 60, h1: h + m / 60 + dur / 60,
    left: s.capacity - s.booked, fill: Math.min(1, s.booked / s.capacity),
  };
}

const isToday = () => state.date === fmtDate(new Date());
const inTod = (s) => s.h0 >= TOD[state.tod].from && s.h0 < TOD[state.tod].to;
const bookable = (s, now = Date.now()) => s.left >= state.need && s.start.getTime() > now;
const heat = (fill) => Math.min(4, Math.floor(fill * 5));

function venueSessions(id) {
  return state.sessions.filter((s) => s.venue_id === id && inTod(s));
}
function summary(sessions) {
  const now = Date.now();
  const cap = sessions.reduce((n, s) => n + s.capacity, 0);
  const booked = sessions.reduce((n, s) => n + Math.min(s.booked, s.capacity), 0);
  return { fill: cap ? booked / cap : null, open: sessions.filter((s) => bookable(s, now)).length, total: sessions.length };
}

// --- headline ----------------------------------------------------------------
function whenPhrase() {
  const part = TOD[state.tod].label;
  if (isToday()) return part ? `this ${part}` : 'today';
  const d = new Date(`${state.date}T12:00:00Z`);
  const tomorrow = state.date === fmtDate(new Date(Date.now() + 86400e3));
  const day = tomorrow ? 'tomorrow' : `on ${fmtWeekday(d, 'long')}`;
  return part ? `${day} ${part}` : day;
}
function renderHeadline() {
  const h1 = document.getElementById('headline');
  const sub = document.getElementById('subline');
  const who = state.need > 1 ? ` for ${state.need} people` : '';
  const [nh] = fmtTime(new Date()).split(':').map(Number);
  if (isToday() && state.tod !== 'any' && nh >= TOD[state.tod].to) {
    h1.textContent = `This ${TOD[state.tod].label}'s sessions have finished.`;
    sub.innerHTML = `<button type="button" class="linkish" id="go-tomorrow">See tomorrow ${TOD[state.tod].label}</button>`;
    document.getElementById('go-tomorrow').onclick = () => {
      state.date = fmtDate(new Date(Date.now() + 86400e3));
      track('filter', null, 'day=+1');
      renderDays();
      refresh();
    };
    return;
  }
  const n = state.venues.filter((v) => summary(venueSessions(v.id)).open > 0).length;
  h1.textContent = n === 0
    ? `No sauna has space${who} ${whenPhrase()}.`
    : `${n} of ${state.venues.length} saunas have space${who} ${whenPhrase()}.`;

  const candidates = state.sessions.filter((s) => inTod(s) && bookable(s));
  if (!candidates.length) {
    sub.textContent = isToday() ? 'Try tomorrow, or a different time of day.' : 'Try another day or time of day.';
    return;
  }
  const byId = Object.fromEntries(state.venues.map((v) => [v.id, v]));
  const pick = isToday()
    ? candidates.reduce((a, b) => (b.start < a.start ? b : a))
    : candidates.reduce((a, b) => (b.fill < a.fill || (b.fill === a.fill && b.left > a.left) ? b : a));
  const v = byId[pick.venue_id];
  const place = `${shortName(v)}, ${v.site}`;
  sub.innerHTML = isToday()
    ? `Next with space: <b>${esc(place)}</b> at ${fmtTime(pick.start)}, ${plural(pick.left, 'spot')} left.`
    : `Quietest: <b>${esc(place)}</b> at ${fmtTime(pick.start)}, ${pick.booked} of ${pick.capacity} booked so far.`;
}

// --- timetable ----------------------------------------------------------------
const boardScroll = document.getElementById('board-scroll');
const board = document.getElementById('board');

const hourLabel = (h) => `${String(h % 24).padStart(2, '0')}:00`;

// Greedy interval packing so overlapping sessions get their own lane.
function packLanes(sessions) {
  const ends = [];
  return sessions.map((s) => {
    let lane = ends.findIndex((e) => e <= s.h0 + 1e-6);
    if (lane === -1) { lane = ends.length; ends.push(0); }
    ends[lane] = s.h1;
    return { s, lane };
  });
}

function renderBoard() {
  const now = Date.now();
  const vis = state.sessions.filter(inTod);
  const tod = TOD[state.tod];
  const t0 = vis.length ? Math.floor(Math.min(...vis.map((s) => s.h0))) : Math.max(tod.from, 7);
  let t1 = vis.length ? Math.ceil(Math.max(...vis.map((s) => s.h1))) : Math.min(tod.to, 22);
  if (t1 - t0 < 4) t1 = t0 + 4;
  const hours = t1 - t0;
  const rootStyle = getComputedStyle(document.documentElement);
  const labelW = parseFloat(rootStyle.getPropertyValue('--label-w'));
  const laneH = parseFloat(rootStyle.getPropertyValue('--lane'));
  const viewW = boardScroll.clientWidth;
  const pph = Math.max(viewW < 640 ? 64 : 40, (viewW - labelW - 12) / hours);
  const trackW = Math.round(hours * pph);
  board.style.setProperty('--track-w', `${trackW}px`);
  board.style.setProperty('--hour', `${pph}px`);
  boardScroll.style.setProperty('--view-w', `${viewW}px`);
  const x = (h) => (h - t0) * pph;

  const rows = state.venues.map((v) => {
    const all = venueSessions(v.id);
    const shown = all.filter((s) => !state.hideFull || s.left >= state.need);
    return { v, all, shown, sum: summary(all) };
  });
  rows.sort((a, b) => b.sum.open - a.sum.open || (a.sum.fill ?? 2) - (b.sum.fill ?? 2) || shortName(a.v).localeCompare(shortName(b.v)));

  let nowH = null;
  if (isToday()) {
    const [hh, mm] = fmtTime(new Date()).split(':').map(Number);
    if (hh + mm / 60 > t0 && hh + mm / 60 < t1) nowH = hh + mm / 60;
  }
  let html = '<div class="axis"><div class="pad"></div><div class="ticks">';
  const step = pph < 48 ? 2 : 1;
  for (let h = t0; h < t1; h++) {
    // Skip hour labels the "Now" tag would cover.
    if (nowH != null && Math.abs(x(h) - x(nowH)) < 40) continue;
    if ((h - t0) % step !== 0) continue;
    // The first label is left-aligned, so the next one needs extra room.
    if (h > t0 && x(h) - x(t0) < 64) continue;
    html += h === t0
      ? `<span style="left:4px;transform:none">${hourLabel(h)}</span>`
      : `<span style="left:${x(h)}px">${hourLabel(h)}</span>`;
  }
  html += '</div></div>';

  rows.forEach(({ v, all, shown }, i) => {
    const lanes = packLanes(shown.slice().sort((a, b) => a.h0 - b.h0));
    const nLanes = Math.max(1, ...lanes.map((l) => l.lane + 1));
    const open = state.open === v.id;
    html += `<div class="vrow${open ? ' open' : ''}" data-id="${v.id}" style="--row:${i}">`;
    html += `<button class="vlabel" type="button" aria-expanded="${open}" aria-controls="d-${v.id}">
      <span class="n">${esc(shortName(v))}</span><span class="s">${esc(v.site)}</span>
      ${v.last_ok ? '' : '<span class="warn">Not updated at the last check</span>'}</button>`;
    html += `<div class="track" style="height:${nLanes * laneH + 16}px">`;
    if (!shown.length) {
      html += `<span class="none">${all.length ? 'Nothing with space' : 'No sessions listed'}</span>`;
    }
    for (const { s, lane } of lanes) {
      const left = x(s.h0) + 1;
      const width = Math.max(18, (s.h1 - s.h0) * pph - 3);
      const b = heat(s.fill);
      const cls = ['slot'];
      if (width < 50) cls.push('narrow');
      if (s.left <= 0) cls.push('full');
      else if (s.left < state.need) cls.push('short');
      if (s.start.getTime() < now) cls.push('past');
      if (s.left > 0 && b === 4) cls.push('hot4');
      const k = s.left <= 0 ? (width < 50 ? '' : 'Full') : s.left;
      const tip = [
        s.name || 'Session',
        `${fmtTime(s.start)} to ${fmtTime(s.end)}`,
        s.left <= 0 ? `Full, ${s.capacity} places` : `${Math.min(s.booked, s.capacity)} of ${s.capacity} booked, ${plural(s.left, 'spot')} left`,
        s.waitlist ? `${s.waitlist} on the waitlist` : '',
        s.start.getTime() < now ? 'Already started' : '',
      ].filter(Boolean).join('\n');
      html += `<a class="${cls.join(' ')}" href="${esc(bookingUrl(v.url, 'session'))}" target="_blank" rel="noopener"
        style="left:${left}px;top:${8 + lane * laneH}px;width:${width}px;--f:${(s.fill * 100).toFixed(1)}%;--h:var(--h${b})"
        data-tip="${esc(tip)}" aria-label="${esc(`${shortName(v)} ${fmtTime(s.start)}: ${s.left <= 0 ? 'full' : `${s.left} spots left`}`)}">
        <span class="fill"></span><span class="lbl"><span class="t">${fmtTime(s.start)}</span><span class="k">${k}</span></span></a>`;
    }
    html += '</div></div>';
    if (open) html += detailHtml(v);
  });

  if (nowH != null) {
    const nx = labelW + x(nowH);
    html += `<div class="now" style="left:${nx}px;top:22px"></div><span class="now-tag" style="left:${nx}px">Now</span>`;
  }

  board.classList.toggle('rise', state.animate);
  board.innerHTML = rows.length ? html : '<p class="empty">No saunas have reported in yet.</p>';
  state.animate = false;
  if (state.open) loadPattern(state.venues.find((v) => v.id === state.open));
}

function scrollToNow() {
  const tag = board.querySelector('.now-tag');
  boardScroll.scrollLeft = tag ? Math.max(0, tag.offsetLeft - boardScroll.clientWidth * 0.35) : 0;
}

// --- venue detail ---------------------------------------------------------------
function detailHtml(v) {
  return `<div class="detail" id="d-${v.id}" data-id="${v.id}">
    <div>
      <p class="addr">${esc(v.address ?? '')}</p>
      <a class="btn" href="${esc(bookingUrl(v.url, 'venue'))}" target="_blank" rel="noopener">Book at ${esc(state.venues.filter((x) => x.venue === v.venue).length > 1 ? `${shortName(v)} ${v.site}` : shortName(v))}</a>
    </div>
    <div class="pattern" data-pattern="${v.id}"><h3>Usually</h3><p class="note">Loading…</p></div>
  </div>`;
}

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
async function loadPattern(v) {
  if (!v) return;
  if (!state.patternCache.has(v.id)) state.patternCache.set(v.id, getJson(`/api/venues/${v.id}/pattern`));
  let cells;
  try { ({ cells } = await state.patternCache.get(v.id)); } catch { cells = null; }
  const pane = board.querySelector(`[data-pattern="${v.id}"]`);
  if (!pane) return;
  if (!cells) {
    state.patternCache.delete(v.id);
    pane.innerHTML = '<h3>Usually</h3><p class="note">Couldn\'t load past sessions. Close and reopen to try again.</p>';
    return;
  }
  const total = cells.reduce((n, c) => n + c.sessions, 0);
  if (total < 20) {
    pane.innerHTML = `<h3>Usually</h3><p class="note">A weekly picture of when ${esc(shortName(v))} is busiest. Filling in now; check back in about two weeks.</p>`;
    return;
  }
  const hours = [...new Set(cells.map((c) => c.hour))].sort((a, b) => a - b);
  const at = new Map(cells.map((c) => [`${c.weekday}|${c.hour}`, c]));
  let html = `<h3>Usually</h3><p class="note">How booked sessions were by the time they started, from ${plural(total, 'past session')}.</p>`;
  html += `<div class="heat" style="--cols:${hours.length}"><span></span>`;
  for (const h of hours) html += `<span class="hl">${h % 3 === 0 ? hourLabel(h) : ''}</span>`;
  for (const d of WEEKDAYS) {
    html += `<span class="lab">${d}</span>`;
    for (const h of hours) {
      const c = at.get(`${d}|${h}`);
      html += c
        ? `<span class="c" style="background:var(--h${heat(c.fill)})" data-tip="${esc(`${d} ${hourLabel(h)}\n${Math.round(c.fill * 100)}% booked on average\nAbout ${c.people.toFixed(0)} people, from ${plural(c.sessions, 'session')}`)}"></span>`
        : '<span class="c"></span>';
    }
  }
  pane.innerHTML = html + '</div>';
}

board.addEventListener('click', (e) => {
  const link = e.target.closest('a.slot, a.btn');
  if (link) {
    const id = link.closest('.vrow, .detail')?.dataset.id;
    track('book_click', id, link.classList.contains('slot') ? 'session' : 'venue');
    return;
  }
  const btn = e.target.closest('.vlabel');
  if (btn) toggleVenue(btn.closest('.vrow').dataset.id, { via: 'row' });
});
function toggleVenue(id, { scroll = false, via } = {}) {
  state.open = state.open === id ? null : id;
  if (state.open) track('venue_open', id, via);
  const keep = boardScroll.scrollLeft;
  renderBoard();
  boardScroll.scrollLeft = keep;
  if (!state.open) return;
  const v = state.venues.find((x) => x.id === id);
  if (v?.lat != null) map.panTo([v.lat, v.lng], { animate: true });
  if (scroll) board.querySelector(`.vrow[data-id="${id}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

// Row and pin highlight each other.
board.addEventListener('pointerover', (e) => setHot(e.target.closest('.vrow')?.dataset.id ?? null));
board.addEventListener('pointerleave', () => setHot(null));
function setHot(id) {
  for (const [vid, m] of markers) {
    const el = m.getElement();
    el?.querySelector('.pin')?.classList.toggle('hot', vid === id);
    el?.classList.toggle('on-top', vid === id);
  }
  for (const r of board.querySelectorAll('.vrow')) r.classList.toggle('hot', r.dataset.id === id);
}

// --- map ----------------------------------------------------------------------------
let map;
const markers = new Map();
function initMap() {
  map = L.map('map', { scrollWheelZoom: false }).setView([51.505, -0.09], 11);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19, className: 'tiles',
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  }).addTo(map);
  map.attributionControl.setPrefix(false);
  new ResizeObserver(() => map.invalidateSize()).observe(document.getElementById('map'));
  // Scroll-zoom only once the map has been clicked, so the page scrolls past it.
  map.on('focus', () => map.scrollWheelZoom.enable());
  map.on('blur', () => map.scrollWheelZoom.disable());
}

function drawMarkers() {
  setHot(null);
  for (const m of markers.values()) m.remove();
  markers.clear();
  const pts = [];
  for (const v of state.venues) {
    if (v.lat == null) continue;
    const sum = summary(venueSessions(v.id));
    const b = sum.fill == null ? 0 : heat(sum.fill);
    const ink = b >= 3 ? 'var(--on-h-dark)' : 'var(--on-h-light)';
    const size = 32;
    const icon = L.divIcon({
      className: '',
      html: `<div class="pin${sum.open ? '' : ' zero'}" style="--h:var(--h${b});--ink:${ink}">${sum.open}</div>`,
      iconSize: [size, size],
      iconAnchor: [size / 2, size / 2],
    });
    const m = L.marker([v.lat, v.lng], { icon, title: `${shortName(v)}, ${v.site}` }).addTo(map);
    const line = sum.total
      ? `${sum.open ? `${plural(sum.open, 'session')} with space` : 'No sessions with space'}, ${Math.round(sum.fill * 100)}% booked`
      : 'No sessions listed';
    m.bindTooltip(`<b>${esc(shortName(v))}</b> ${esc(v.site)}<br>${line}`, { direction: 'top', offset: [0, -18] });
    m.on('mouseover', () => setHot(v.id));
    m.on('mouseout', () => setHot(null));
    m.on('click', () => { if (state.open !== v.id) toggleVenue(v.id, { scroll: true, via: 'pin' }); });
    markers.set(v.id, m);
    pts.push([v.lat, v.lng]);
  }
  if (pts.length && !drawMarkers.fitted) {
    map.fitBounds(pts, { padding: [28, 28] });
    drawMarkers.fitted = true;
  }
}

// --- tooltip ----------------------------------------------------------------------------
const tip = document.getElementById('tip');
function showTip(t) {
  tip.replaceChildren();
  t.dataset.tip.split('\n').forEach((line, i) => {
    const el = document.createElement(i === 0 ? 'b' : 'div');
    el.textContent = line;
    if (i > 1) el.className = 'dim';
    tip.append(el);
  });
  tip.hidden = false;
}
function placeTip(x, y) {
  const left = Math.min(x + 14, innerWidth - tip.offsetWidth - 8);
  const top = y + 18 + tip.offsetHeight > innerHeight ? y - tip.offsetHeight - 12 : y + 18;
  tip.style.left = `${Math.max(8, left)}px`;
  tip.style.top = `${top}px`;
}
document.addEventListener('pointerover', (e) => {
  const t = e.target.closest?.('[data-tip]');
  if (!t || e.pointerType === 'touch') { tip.hidden = true; return; }
  showTip(t);
  placeTip(e.clientX, e.clientY);
});
document.addEventListener('pointermove', (e) => { if (!tip.hidden) placeTip(e.clientX, e.clientY); });
document.addEventListener('focusin', (e) => {
  const t = e.target.closest?.('[data-tip]');
  if (!t) { tip.hidden = true; return; }
  showTip(t);
  const r = t.getBoundingClientRect();
  placeTip(r.left, r.bottom - 8);
});
document.addEventListener('scroll', () => { tip.hidden = true; }, true);

// --- controls -----------------------------------------------------------------------------
function renderDays() {
  const el = document.getElementById('days');
  el.replaceChildren();
  for (let i = 0; i < 7; i++) {
    const d = new Date(Date.now() + i * 86400e3);
    const iso = fmtDate(d);
    const b = document.createElement('button');
    b.type = 'button';
    b.setAttribute('role', 'tab');
    b.setAttribute('aria-selected', iso === state.date);
    b.innerHTML = `<small>${i === 0 ? 'Today' : i === 1 ? 'Tomorrow' : fmtWeekday(d)}</small><span>${fmtDayMonth(d)}</span>`;
    b.onclick = () => { state.date = iso; track('filter', null, `day=+${i}`); renderDays(); refresh(); };
    el.append(b);
  }
}

document.getElementById('tod').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  state.tod = b.dataset.v;
  track('filter', null, `time=${state.tod}`);
  for (const x of e.currentTarget.children) x.setAttribute('aria-pressed', x === b);
  render({ resetScroll: true });
});
const needOut = document.getElementById('need-out');
const needDec = document.getElementById('need-dec');
const needInc = document.getElementById('need-inc');
function setNeed(n) {
  state.need = Math.min(6, Math.max(1, n));
  needOut.textContent = state.need === 1 ? '1 person' : `${state.need} people`;
  needDec.disabled = state.need === 1;
  needInc.disabled = state.need === 6;
  render();
}
needDec.onclick = () => { setNeed(state.need - 1); track('filter', null, `people=${state.need}`); };
needInc.onclick = () => { setNeed(state.need + 1); track('filter', null, `people=${state.need}`); };
document.getElementById('hidefull').addEventListener('change', (e) => {
  state.hideFull = e.target.checked;
  track('filter', null, `only_space=${state.hideFull ? 'on' : 'off'}`);
  render();
});

function render({ resetScroll = false } = {}) {
  if (!state.loaded) return;
  const keep = boardScroll.scrollLeft;
  renderHeadline();
  drawMarkers();
  renderBoard();
  if (resetScroll) scrollToNow(); else boardScroll.scrollLeft = keep;
}

async function refresh() {
  try {
    state.sessions = await loadDay(state.date);
  } catch (err) {
    state.dayCache.delete(state.date);
    board.innerHTML = `<p class="empty">Couldn't load sessions (${esc(err.message)}). Reload the page to try again.</p>`;
    return;
  }
  state.loaded = true;
  render({ resetScroll: true });
}

function renderFreshness() {
  const latest = state.venues.map((v) => v.last_scraped_at).filter(Boolean).sort().at(-1);
  if (!latest) return;
  const mins = Math.round((Date.now() - new Date(latest)) / 60000);
  const ago = mins < 2 ? 'just now' : mins < 60 ? `${mins} minutes ago` : mins < 120 ? 'an hour ago' : `${Math.round(mins / 60)} hours ago`;
  document.getElementById('fresh').textContent = `Updated ${ago}`;
}

let resizeTimer;
addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => render(), 120);
});

async function main() {
  track('pageview');
  initMap();
  renderDays();
  setNeed(1);
  try {
    ({ venues: state.venues } = await getJson('/api/venues'));
  } catch (err) {
    document.getElementById('headline').textContent = 'Sauna data is unavailable right now.';
    board.innerHTML = `<p class="empty">Couldn't reach the server (${esc(err.message)}). Reload the page to try again.</p>`;
    return;
  }
  renderFreshness();
  await refresh();
}
main();
