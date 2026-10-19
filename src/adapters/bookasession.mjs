// bookasession.org (Arvo, Old Kent Road Sauna). A Next.js app that renders the
// whole booking window into the page: its React Server Components payload holds
// every session instance with `effectiveCapacity` and `spotsRemaining`. There's
// no separate JSON API, so we fetch the public page and pull the instance
// objects out of the payload. No auth needed.
//
// config: { slug, locationIds?: [ids] } — venues with a studio as well as a
// sauna list the sauna's location id so only its sessions are kept.

import { USER_AGENT, session } from '../lib.mjs';

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const str = (obj, key) => obj.match(new RegExp(`"${key}":"((?:[^"\\\\]|\\\\.)*)"`))?.[1];
const num = (obj, key) => {
  const m = obj.match(new RegExp(`"${key}":(-?\\d+)`));
  return m ? Number(m[1]) : null;
};
const unescape = (s) => (s == null ? s : JSON.parse(`"${s}"`));

export async function scrape({ slug, locationIds }, { dates }) {
  const res = await fetch(`https://bookasession.org/${slug}`, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'text/html' },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`bookasession ${slug}: HTTP ${res.status}`);
  // The payload is a JS string inside <script> tags, so its quotes are escaped.
  const page = (await res.text()).replace(/\\"/g, '"');

  // Template (session type) names and schedule locations, for instances that
  // don't carry their own name or location.
  const names = new Map();
  for (const m of page.matchAll(new RegExp(`"(?:id|templateId)":"(${UUID})","name":"((?:[^"\\\\]|\\\\.)*)"`, 'g'))) {
    if (!names.has(m[1])) names.set(m[1], unescape(m[2]));
  }
  const scheduleLoc = new Map();
  for (const m of page.matchAll(new RegExp(`"id":"(${UUID})","time":"[^"]*","days":\\[[^\\]]*\\],"session_id":"${UUID}".{0,200}?"location_id":"(${UUID})"`, 'g'))) {
    scheduleLoc.set(m[1], m[2]);
  }
  const oneOffLoc = new Map();
  for (const m of page.matchAll(new RegExp(`"template_id":"(${UUID})","date":"([\\d-]+)","time":"[^"]*","duration_minutes":\\d+,"location_id":"(${UUID})"`, 'g'))) {
    oneOffLoc.set(`${m[1]}:${m[2]}`, m[3]);
  }

  // Each instance object starts with {"id":…,"start_time":…; the same instance
  // can appear more than once (featured list, calendar), so keep the first.
  const starts = [...page.matchAll(new RegExp(`\\{"id":"(${UUID})","start_time":"`, 'g'))];
  const want = new Set(dates);
  const out = new Map();
  starts.forEach((m, i) => {
    if (out.has(m[1])) return;
    const obj = page.slice(m.index, starts[i + 1]?.index ?? m.index + 4000).slice(0, 4000);
    const capacity = num(obj, 'effectiveCapacity');
    const left = num(obj, 'spotsRemaining');
    const startIso = str(obj, 'start_time');
    if (capacity == null || left == null || !startIso) return;
    if (str(obj, 'status') !== 'scheduled' || /"isHidden":true|"isPrivatelyBooked":true/.test(obj)) return;
    const start = new Date(startIso);
    const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London' }).format(start);
    if (!want.has(date)) return;
    const templateId = str(obj, 'template_id');
    const loc = str(obj, 'location_id') ?? scheduleLoc.get(str(obj, 'schedule_id')) ?? oneOffLoc.get(`${templateId}:${date}`);
    if (locationIds && !locationIds.includes(loc)) return;
    const end = new Date(str(obj, 'end_time'));
    out.set(m[1], session({
      id: m[1],
      start,
      durationMin: Math.round((end - start) / 60000) || '',
      name: unescape(str(obj, 'effectiveName')) ?? names.get(templateId) ?? 'Sauna session', // some templates have no name
      capacity,
      booked: capacity - left,
    }));
  });
  return [...out.values()];
}
