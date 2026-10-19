// Periode (periode.no), used by Community Sauna Baths. The booking pages are a
// Firebase app: each product ("booking manifest") has a slots document per day
// in Firestore with `available` (capacity) and `booked` per start time. The page
// only shows a price or "Waitlist", but its own Firestore listen stream carries
// the counts. We load the public booking-group page for each day in Chromium,
// record that stream as the page receives it, and parse the documents out.
//
// Products can share capacity through a parent product (e.g. "Weekday" and
// "Weekend/Holiday" sessions use the same saunas). The child's own slot counts
// are then zero and the real counts live on the parent's slots, so we resolve
// each child slot to its parent's slot at the same time.

import { fromLondon, newContext, session } from '../lib.mjs';

const BASE = 'https://minside.periode.no/bookinggroups';
const MAX_WAIT_MS = 30_000;
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
    if (!m) { missing.push(manifestId); continue; }
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
  await Promise.all(groupIds.flatMap((g) => dates.map((d) => withSlot(() => loadDay(merchantId, g, d, docs)))));

  if (process.env.PERIODE_DUMP) {
    const { writeFileSync } = await import('node:fs');
    writeFileSync(process.env.PERIODE_DUMP, JSON.stringify(Object.fromEntries(docs), null, 1));
  }

  const manifest = (id) => docs.get(`bookingManifests/${id}`);
  const slotsDoc = (id, date) => docs.get(`dateSlots/${merchantId}/manifests/${id}/slots/${date}`)?.slots ?? [];

  const rows = new Map();
  for (const groupId of groupIds) {
    const group = docs.get(`bookingManifestGroups/${groupId}`);
    if (!group) throw new Error(`booking group ${groupId} not loaded`);
    // Members-only products often share a parent with the public one; list
    // the public one first so shared slots get its name.
    const manifestIds = (group.columns ?? []).flatMap((c) => c.manifests ?? []).map((m) => m.manifestId)
      .sort((a, b) => /^members/i.test(manifest(a)?.name ?? '') - /^members/i.test(manifest(b)?.name ?? ''));
    const groupParents = [...new Set(manifestIds.map((id) => manifest(id)?.parentProduct?.id).filter(Boolean))];
    for (const mid of manifestIds) {
      const m = manifest(mid);
      if (!m || m.archived || NOT_SAUNA.test(m.name)) continue;
      const parentId = m.parentProduct?.id;
      for (const date of dates) {
        for (const s of slotsDoc(mid, date)) {
          // A child's own counts are always zero; the counts live on a parent's
          // slot at the same time. That's normally its own parent, but e.g.
          // Stratford's "Weekday" product has Saturday slots whose counts sit
          // on the weekend product's parent, so fall back to any parent in the
          // group that has this time. With none, skip rather than record a
          // false "empty".
          let ownerId = mid, src = s;
          if (parentId) {
            ownerId = [parentId, ...groupParents].find((id) => slotsDoc(id, date).some((x) => x.time === s.time));
            if (!ownerId) continue;
            src = slotsDoc(ownerId, date).find((x) => x.time === s.time);
          }
          const key = `${ownerId}:${date}:${s.time}`;
          if (rows.has(key)) continue;
          const hh = Math.floor(s.time), mm = Math.round((s.time - hh) * 60);
          rows.set(key, session({
            id: key,
            start: fromLondon(date, hh, mm),
            durationMin: Math.round((src.length ?? m.length ?? 0) * 60) || '',
            name: m.name,
            capacity: src.available,
            booked: src.booked,
          }));
        }
      }
    }
  }
  return [...rows.values()];
}
