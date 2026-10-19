// Mindbody. The public marketplace search API behind mindbody.io returns every
// class time at a location with `capacity` and `openings` (places left). No
// auth needed. Find a venue's `slug` with POST /v1/search/locations
// ({ filter: { term: "<name>" } }).
//
// config: { slug, include?: regex source matched against the class name } —
// studios that also run yoga and pilates need `include` so only sauna sessions
// are kept.

import { USER_AGENT, londonMidnightIso, session } from '../lib.mjs';

const API = 'https://prod-mkt-gateway.mindbody.io/v1/search/class_times';
const PAGE = 100;

export async function scrape({ slug, include }, { dates }) {
  const dayAfter = new Date(new Date(`${dates.at(-1)}T12:00:00Z`).getTime() + 86400e3).toISOString().slice(0, 10);
  const keep = include ? new RegExp(include, 'i') : null;
  const out = [];
  for (let page = 1; page <= 20; page++) {
    const res = await fetch(API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': USER_AGENT },
      body: JSON.stringify({
        sort: 'start_time',
        page: { size: PAGE, number: page },
        filter: {
          radius: 0,
          locationSlugs: [slug],
          inventorySource: ['MB'],
          startTimeRanges: [{ from: londonMidnightIso(dates[0]), to: londonMidnightIso(dayAfter) }],
        },
      }),
      signal: AbortSignal.timeout(30_000),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`mindbody ${slug}: HTTP ${res.status} ${text.slice(0, 200)}`);
    const { data } = JSON.parse(text);
    for (const { id, attributes: a } of data) {
      if (!a.capacity || (keep && !keep.test(a.displayName ?? ''))) continue;
      // The cheapest drop-in that isn't an intro offer, e.g. off-peak sauna £12
      // where the general "studio or sauna" drop-in is £19.
      const drop = (a.purchaseOptions ?? []).filter((o) => o.isSingleSession && !o.isIntroOffer).map((o) => Number(o.pricing?.online));
      out.push(session({
        id: String(JSON.parse(a.inventoryRefJson ?? '{}').mb_class_id ?? id),
        start: new Date(a.startTime),
        durationMin: a.duration ?? '',
        name: a.displayName.replace(/^(SAUNA|SPA)\s*[:-]\s*/i, ''),
        capacity: a.capacity,
        booked: a.capacity - Math.max(0, a.openings ?? a.webOpenings ?? 0),
        price: drop.length ? Math.min(...drop) : null,
      }));
    }
    if (data.length < PAGE) break;
  }
  return out;
}
