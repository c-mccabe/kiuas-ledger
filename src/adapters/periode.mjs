// Periode (periode.no), used by Community Sauna Baths. The booking pages are a
// Firebase app: each product ("booking manifest") has a slots document per day
// in Firestore with `available` (capacity) and `booked` per start time. The page
// only shows a price or "Waitlist", but its own Firestore listen stream carries
// the counts. We load the public booking-group page for each day in Chromium,
// record that stream as the page receives it, and parse the documents out.
//
// Products can share capacity through a parent product. The parent's slots doc
// is a half-hourly timeline of the site: `available` places and `booked`
// people present in each half hour, with closed half hours simply absent. A
// child product (e.g. "Off-peak" / "Peak") sells sessions that hold
// `parentProduct.slotDelta + 1` consecutive parent half hours (when the parent
// is a half-hour grid; some parents hold whole sessions instead), so a start time
// is bookable only if every half hour it covers exists, and its spots left are
// the minimum over them. The child's own slots doc often isn't sent at all, so
// start times are derived from the parent timeline.

import { fromLondon, newContext, session } from '../lib.mjs';

const BASE = 'https://minside.periode.no/bookinggroups';
const MAX_WAIT_MS = Number(process.env.PERIODE_MAX_WAIT_MS ?? 30_000);
const SETTLE_MS = 5_000;

// Records the Firestore WebChannel responses (XHR) the page receives.
function recordListenStream() {
  window.__listen = [];
  const open = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    if (String(url).includes('Firestore/Listen/channel')) {
      let seen = 0;
      this.addEventListener('readystatechange', () => {
        if (this.readyState >= 3) {
          const t = this.responseText;
          if (t.length > seen) window.__listen.push(t.slice(seen));
          seen = t.length;
        }
      });
    }
    return open.call(this, method, url, ...rest);
  };
}

// WebChannel framing: "<length>\n<json>" repeated, where json is [[seq, [msg...]], ...].
function* channelMessages(text) {
  let i = 0;
  while (i < text.length) {
    const nl = text.indexOf('\n', i);
    if (nl < 0) return;
    const len = Number(text.slice(i, nl));
    if (!Number.isInteger(len)) return;
    const chunk = text.slice(nl + 1, nl + 1 + len);
    i = nl + 1 + len;
    let arr;
    try { arr = JSON.parse(chunk); } catch { continue; }
    for (const entry of arr) for (const msg of Array.isArray(entry?.[1]) ? entry[1] : []) yield msg;
  }
}

const fsValue = (v) => {
  if (v == null) return v;
  if ('stringValue' in v) return v.stringValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return v.doubleValue;
  if ('booleanValue' in v) return v.booleanValue;
  if ('nullValue' in v) return null;
  if ('timestampValue' in v) return v.timestampValue;
  if ('arrayValue' in v) return (v.arrayValue.values ?? []).map(fsValue);
  if ('mapValue' in v) return fsFields(v.mapValue.fields);
  return undefined;
};
const fsFields = (fields = {}) => Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, fsValue(v)]));

// Which slot documents a day's page must deliver before we have everything:
// one per (non-archived) product in the group, plus each product's parent.
function missingSlotDocs(docs, merchantId, groupId, date) {
  const group = docs.get(`bookingManifestGroups/${groupId}`);
  if (!group) return { missing: ['group'], parentsMissing: true };
  const missing = [];
  let parentsMissing = false;
  for (const { manifestId } of (group.columns ?? []).flatMap((c) => c.manifests ?? [])) {
    const m = docs.get(`bookingManifests/${manifestId}`);
    // Until the product doc arrives we can't tell whether it has a parent, so
    // treat it as a missing parent rather than giving up after SETTLE_MS.
    if (!m) { missing.push(manifestId); parentsMissing = true; continue; }
    if (m.archived) continue;
    if (!docs.has(`dateSlots/${merchantId}/manifests/${manifestId}/slots/${date}`)) missing.push(manifestId);
    const parentId = m.parentProduct?.id;
    if (parentId && !docs.has(`dateSlots/${merchantId}/manifests/${parentId}/slots/${date}`)) {
      missing.push(parentId);
      parentsMissing = true;
    }
  }
  return { missing, parentsMissing };
}

function parseInto(text, docs) {
  for (const msg of channelMessages(text)) {
    const doc = msg?.documentChange?.document;
    if (doc) docs.set(doc.name.split('/documents/')[1], fsFields(doc.fields));
  }
}

// Each load gets its own browser context: the Firestore SDK shares one
// connection between tabs of the same origin, so a second tab in a shared
// context gets its data via IndexedDB rather than its own (recorded) stream.
async function loadDay(merchantId, groupId, date, docs) {
  const ctx = await newContext();
  await ctx.addInitScript(recordListenStream);
  const page = await ctx.newPage();
  try {
    await page.goto(`${BASE}/${merchantId}/${groupId}/${date}`, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    // The listen stream never ends, so poll until every slot doc we need has
    // arrived. The page doesn't query every product on every day (e.g. the
    // weekend product on a weekday), so once the parents' docs (which carry
    // the counts) are in, give stragglers a few seconds and move on.
    const started = Date.now();
    let local = new Map(), state, parentsAt;
    for (;;) {
      await page.waitForTimeout(1000);
      local = new Map();
      parseInto((await page.evaluate(() => window.__listen)).join(''), local);
      state = missingSlotDocs(local, merchantId, groupId, date);
      if (!state.missing.length) break;
      if (!state.parentsMissing) parentsAt ??= Date.now();
      if (parentsAt && Date.now() - parentsAt > SETTLE_MS) break;
      if (Date.now() - started > MAX_WAIT_MS) break;
    }
    if (state.missing.includes('group')) throw new Error(`group ${groupId} not loaded for ${date}`);
    if (state.parentsMissing) console.warn(`periode ${groupId} ${date}: parent slot docs missing after ${MAX_WAIT_MS / 1000}s`);
    for (const [k, v] of local) docs.set(k, v);
    return !state.parentsMissing;
  } finally {
    await ctx.close();
  }
}

// Shared across all Periode venues in a run, so running five sites in
// parallel doesn't open dozens of browser contexts at once.
const MAX_PAGES = 4;
let active = 0;
const waiting = [];
async function withSlot(fn) {
  if (active >= MAX_PAGES) await new Promise((r) => waiting.push(r));
  active++;
  try { return await fn(); } finally { active--; waiting.shift()?.(); }
}

// Treatments (massage, reiki, ...) are bookable in the same groups but aren't
// sauna sessions.
const NOT_SAUNA = /massage|treatment|reiki|osteopath|facial|therapy|bodywork|acupunct|craniosacral|craneosacral/i;

export async function scrape({ merchantId, groupIds }, { dates }) {
  const docs = new Map(); // "collection/id/..." → fields
  await Promise.all(groupIds.flatMap((g) => dates.map((d) => withSlot(async () => {
    // The page sometimes stalls before sending the slot docs; one fresh retry fixes most.
    if (!(await loadDay(merchantId, g, d, docs))) await loadDay(merchantId, g, d, docs);
  }))));

  if (process.env.PERIODE_DUMP) {
    const { writeFileSync } = await import('node:fs');
    writeFileSync(process.env.PERIODE_DUMP, JSON.stringify(Object.fromEntries(docs), null, 1));
  }

  const manifest = (id) => docs.get(`bookingManifests/${id}`);
  const slotsDoc = (id, date) => docs.get(`dateSlots/${merchantId}/manifests/${id}/slots/${date}`)?.slots ?? [];

  // Places left for a session of `span` consecutive parent slots from `time`,
  // or null if any of those half hours is closed.
  const spanCounts = (parentId, date, time, span) => {
    const timeline = slotsDoc(parentId, date);
    let t = time, capacity = Infinity, left = Infinity, hours = 0;
    for (let i = 0; i < span; i++) {
      const x = timeline.find((y) => Math.abs(y.time - t) < 1e-6);
      if (!x) return null;
      capacity = Math.min(capacity, x.available);
      left = Math.min(left, x.available - x.booked);
      hours += x.length ?? 0.5;
      t += x.length ?? 0.5;
    }
    return { capacity, booked: capacity - left, hours };
  };

  const rows = new Map();
  const add = (key, m, date, time, counts, hours) => {
    if (rows.has(key)) return;
    const hh = Math.floor(time), mm = Math.round((time - hh) * 60);
    rows.set(key, session({
      id: key,
      start: fromLondon(date, hh, mm),
      durationMin: Math.round(hours * 60) || '',
      name: m.name,
      capacity: counts.capacity,
      booked: counts.booked,
      // The product's price is in pence, VAT included: the "Session" price the
      // booking page shows (members' and concession prices are in `discounts`).
      price: Number.isFinite(m.price) ? m.price / 100 : null,
    }));
  };
  for (const groupId of groupIds) {
    const group = docs.get(`bookingManifestGroups/${groupId}`);
    if (!group) throw new Error(`booking group ${groupId} not loaded`);
    // Members-only products often share a parent with the public one; list
    // the public one first so shared slots get its name.
    const manifestIds = (group.columns ?? []).flatMap((c) => c.manifests ?? []).map((m) => m.manifestId)
      .sort((a, b) => /^members/i.test(manifest(a)?.name ?? '') - /^members/i.test(manifest(b)?.name ?? ''));
    for (const mid of manifestIds) {
      const m = manifest(mid);
      if (!m || m.archived || NOT_SAUNA.test(m.name)) continue;
      const parentId = m.parentProduct?.id;
      for (const date of dates) {
        if (!parentId) {
          // Standalone product: its own slots carry the counts.
          for (const s of slotsDoc(mid, date)) {
            add(`${mid}:${date}:${s.time}`, m, date, s.time, { capacity: s.available, booked: s.booked }, s.length ?? m.length);
          }
          continue;
        }
        // slotDelta only means "extra half hours held" when the parent really is
        // a half-hour grid (Hackney Wick, weekends). Where the parent's slots are
        // whole 1–1.5h sessions (Stratford weekdays), each slot is one session.
        const parentSlots = slotsDoc(parentId, date);
        const grid = parentSlots.length > 0 && parentSlots.every((x) => (x.length ?? 0.5) === 0.5);
        const span = grid ? (m.parentProduct.slotDelta ?? 0) + 1 : 1;
        // Start times come from the parent's timeline only. The child's own
        // slots doc is often missing, and when present it can be stale: missing
        // times the booking page offers, or listing times it doesn't (Stratford's
        // weekday product on a Saturday). A start counts only if all the half
        // hours it needs are open.
        for (const { time } of parentSlots) {
          const counts = spanCounts(parentId, date, time, span);
          if (counts) add(`${parentId}:${date}:${time}`, m, date, time, counts, counts.hours);
        }
      }
    }
  }
  return [...rows.values()];
}
