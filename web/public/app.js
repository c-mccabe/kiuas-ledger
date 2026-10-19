const TZ = 'Europe/London';
const fmtDate = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(d);
const fmtDay = (d) => new Intl.DateTimeFormat('en-GB', { timeZone: TZ, weekday: 'short', day: 'numeric' }).format(d);
const fmtTime = (iso) => new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(iso));
const pct = (x) => `${Math.round(x * 100)}%`;
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const state = {
  date: fmtDate(new Date()),
  tod: 'any',
  need: 1,
  hideFull: false,
  venues: [],
  sessions: [],
  dayCache: new Map(),
};

// --- color: sequential blue, 5 buckets of share booked -------------------
const bucket = (fill) => Math.min(4, Math.floor(fill * 5));
const qVar = (fill) => `var(--q${bucket(fill)})`;
const qInk = (fill) => (bucket(fill) >= 2 ? 'var(--q-ink-dark)' : 'var(--q-ink-light)');

// --- data -----------------------------------------------------------------
async function getJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  return res.json();
}

async function loadDay(date) {
  if (!state.dayCache.has(date)) state.dayCache.set(date, getJson(`/api/day?date=${date}`).then((d) => d.sessions));
  return state.dayCache.get(date);
}

function inTod(iso) {
  const h = Number(fmtTime(iso).slice(0, 2));
  if (state.tod === 'am') return h < 12;
  if (state.tod === 'pm') return h >= 12 && h < 17;
  if (state.tod === 'eve') return h >= 17;
  return true;
}

function visibleSessions(venueId) {
  return state.sessions.filter((s) => s.venue_id === venueId && inTod(s.start_utc));
}

function summarize(sessions) {
  const now = Date.now();
  const cap = sessions.reduce((n, s) => n + s.capacity, 0);
  const booked = sessions.reduce((n, s) => n + Math.min(s.booked, s.capacity), 0);
  const open = sessions.filter((s) => s.capacity - s.booked >= state.need && new Date(s.start_utc) > now);
  return { cap, booked, fill: cap ? booked / cap : null, open: open.length, total: sessions.length };
}

// --- map ------------------------------------------------------------------
let map, markers = new Map();
function initMap() {
  map = L.map('map', { zoomControl: true, scrollWheelZoom: true }).setView([51.505, -0.09], 11);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19, className: 'tiles',
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  }).addTo(map);
}

function drawMarkers() {
  for (const m of markers.values()) m.remove();
  markers.clear();
  const pts = [];
  for (const v of state.venues) {
    if (v.lat == null) continue;
    const sum = summarize(visibleSessions(v.id));
    const bg = sum.fill == null ? 'var(--none)' : qVar(sum.fill);
    const ink = sum.fill == null ? 'var(--text-3)' : qInk(sum.fill);
    const size = 34;
    const icon = L.divIcon({
      className: '',
      html: `<div class="pin" style="width:${size}px;height:${size}px;background:${bg};color:${ink}">${sum.total ? sum.open : '–'}</div>`,
      iconSize: [size, size],
      iconAnchor: [size / 2, size / 2],
    });
    const m = L.marker([v.lat, v.lng], { icon, title: `${v.venue} ${v.site}` }).addTo(map);
    m.bindTooltip(`<b>${esc(v.venue)}</b> ${esc(v.site)}<br>${sum.total
      ? `${sum.open} of ${sum.total} sessions with space · ${pct(sum.fill)} booked`
      : 'No sessions this day'}`, { direction: 'top', offset: [0, -16] });
    m.on('click', () => {
      const el = document.getElementById(`v-${v.id}`);
      el?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      el?.classList.add('flash');
      setTimeout(() => el?.classList.remove('flash'), 1400);
    });
    markers.set(v.id, m);
    pts.push([v.lat, v.lng]);
  }
  if (pts.length && !drawMarkers.fitted) { map.fitBounds(pts, { padding: [30, 30] }); drawMarkers.fitted = true; }
}

// --- list -----------------------------------------------------------------
function renderList() {
  const list = document.getElementById('list');
  const tpl = document.getElementById('venue-tpl');
  const now = Date.now();
  const rows = state.venues.map((v) => ({ v, sessions: visibleSessions(v.id), sum: summarize(visibleSessions(v.id)) }));
  // Venues with bookable space first, then by how quiet they are.
  rows.sort((a, b) => (b.sum.open > 0) - (a.sum.open > 0) || (a.sum.fill ?? 2) - (b.sum.fill ?? 2));

  list.replaceChildren();
  for (const { v, sessions, sum } of rows) {
    const node = tpl.content.firstElementChild.cloneNode(true);
    node.id = `v-${v.id}`;
    node.querySelector('.vname').textContent = v.venue;
    node.querySelector('.vsite').textContent = v.site;
    node.querySelector('.vaddr').textContent = v.address ?? '';
    const stat = node.querySelector('.vstat');
    stat.innerHTML = sum.total
      ? `<strong>${pct(sum.fill)}</strong>booked · ${sum.open}/${sum.total} open`
      : '<strong>–</strong>no sessions';
    if (!v.last_ok) stat.innerHTML += `<br><span class="warn" title="${esc(v.last_error)}">⚠ last check failed</span>`;

    const slots = node.querySelector('.slots');
    const shown = sessions.filter((s) => !state.hideFull || s.capacity - s.booked >= state.need);
    if (!shown.length) {
      slots.outerHTML = `<p class="noslots">${sessions.length ? 'No sessions with enough space.' : 'Nothing listed for this day.'}</p>`;
    }
    for (const s of shown) {
      const left = s.capacity - s.booked;
      const fill = Math.min(1, s.booked / s.capacity);
      const enough = left >= state.need;
      const a = document.createElement('a');
      a.className = `slot${enough ? '' : ' full'}${new Date(s.start_utc) < now ? ' past' : ''}`;
      a.href = v.url;
      a.target = '_blank';
      a.rel = 'noopener';
      if (enough) { a.style.background = qVar(fill); a.style.color = qInk(fill); }
      a.innerHTML = `<b>${fmtTime(s.start_utc)}</b><small>${left <= 0 ? 'Full' : enough ? `${left} left` : `${left} left`}</small>`;
      a.dataset.tip = `${s.name ?? ''}\n${fmtTime(s.start_utc)}${s.duration_min ? ` · ${s.duration_min} min` : ''}\n${Math.min(s.booked, s.capacity)}/${s.capacity} booked${s.booked > s.capacity ? ` (+${s.booked - s.capacity} over)` : ''}${s.waitlist ? ` · waitlist ${s.waitlist}` : ''}`;
      slots.append(a);
    }

    const book = node.querySelector('.book');
    book.href = v.url;
    const btn = node.querySelector('.pattern-btn');
    const pane = node.querySelector('.pattern');
    btn.addEventListener('click', () => togglePattern(v, pane));
    list.append(node);
  }
  if (!rows.length) list.innerHTML = '<p class="empty">No data yet.</p>';
}

// --- usual busyness heatmap -------------------------------------------------
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
async function togglePattern(v, pane) {
  if (!pane.hidden) { pane.hidden = true; return; }
  pane.hidden = false;
  pane.innerHTML = '<p>Loading…</p>';
  const { cells } = await getJson(`/api/venues/${v.id}/pattern`);
  const total = cells.reduce((n, c) => n + c.sessions, 0);
  if (total < 20) {
    pane.innerHTML = `<p>Not enough history yet (${total} finished session${total === 1 ? '' : 's'}). This fills in as hourly snapshots build up over the coming weeks.</p>`;
    return;
  }
  const hours = [...new Set(cells.map((c) => c.hour))].sort((a, b) => a - b);
  const at = new Map(cells.map((c) => [`${c.weekday}|${c.hour}`, c]));
  let html = `<p>Average share of places booked by the time each session started, from ${total} past sessions.</p>`;
  html += `<div class="heat" style="--cols:${hours.length}"><span></span>`;
  for (const h of hours) html += `<span class="hl">${h % 3 === 0 ? h : ''}</span>`;
  for (const d of WEEKDAYS) {
    html += `<span class="lab">${d}</span>`;
    for (const h of hours) {
      const c = at.get(`${d}|${h}`);
      html += c
        ? `<span class="c" style="background:${qVar(c.fill)}" data-tip="${d} ${String(h).padStart(2, '0')}:00\n${pct(c.fill)} booked on average\n~${c.people.toFixed(1)} people · ${c.sessions} session${c.sessions === 1 ? '' : 's'}"></span>`
        : '<span class="c"></span>';
    }
  }
  pane.innerHTML = html + '</div>';
}

// --- tooltip for slots and heat cells -------------------------------------
const tip = document.getElementById('tip');
document.addEventListener('pointerover', (e) => {
  const t = e.target.closest('[data-tip]');
  if (!t) { tip.hidden = true; return; }
  tip.textContent = '';
  t.dataset.tip.split('\n').forEach((line, i) => {
    const el = document.createElement(i === 0 ? 'b' : 'div');
    el.textContent = line;
    tip.append(el, document.createElement('br'));
  });
  tip.hidden = false;
});
document.addEventListener('pointermove', (e) => {
  if (tip.hidden) return;
  const x = Math.min(e.clientX + 14, innerWidth - tip.offsetWidth - 8);
  const y = e.clientY + 16 + tip.offsetHeight > innerHeight ? e.clientY - tip.offsetHeight - 10 : e.clientY + 16;
  tip.style.left = `${x}px`;
  tip.style.top = `${y}px`;
});

// --- controls -------------------------------------------------------------
function renderDays() {
  const el = document.getElementById('days');
  el.replaceChildren();
  for (let i = 0; i < 7; i++) {
    const d = new Date(Date.now() + i * 86400e3);
    const iso = fmtDate(d);
    const b = document.createElement('button');
    b.textContent = i === 0 ? 'Today' : i === 1 ? 'Tomorrow' : fmtDay(d);
    b.className = iso === state.date ? 'on' : '';
    b.setAttribute('role', 'tab');
    b.setAttribute('aria-selected', iso === state.date);
    b.onclick = () => { state.date = iso; renderDays(); refresh(); };
    el.append(b);
  }
}

document.getElementById('tod').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  state.tod = b.dataset.v;
  for (const x of e.currentTarget.children) x.classList.toggle('on', x === b);
  render();
});
document.getElementById('need').addEventListener('change', (e) => { state.need = Number(e.target.value); render(); });
document.getElementById('hidefull').addEventListener('change', (e) => { state.hideFull = e.target.checked; render(); });

function render() { drawMarkers(); renderList(); }

async function refresh() {
  state.sessions = await loadDay(state.date);
  render();
}

function renderFreshness() {
  const latest = state.venues.map((v) => v.last_scraped_at).filter(Boolean).sort().at(-1);
  if (!latest) return;
  const mins = Math.round((Date.now() - new Date(latest)) / 60000);
  document.getElementById('fresh').textContent =
    `Last checked ${mins < 1 ? 'just now' : mins < 60 ? `${mins} min ago` : `${Math.round(mins / 60)} h ago`} · ${state.venues.length} saunas`;
}

async function main() {
  initMap();
  renderDays();
  try {
    const { venues } = await getJson('/api/venues');
    state.venues = venues;
    renderFreshness();
    await refresh();
  } catch (err) {
    document.getElementById('list').innerHTML = `<p class="empty">Couldn't load data (${esc(err.message)}).</p>`;
  }
}
main();
