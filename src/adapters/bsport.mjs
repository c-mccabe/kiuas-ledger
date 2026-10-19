// bsport (Revitalise Urban Spa). The booking widget reads a public API that
// lists every class ("offer") with `effectif` (capacity) and
// `validated_booking_count`. No auth needed. Find a studio's company id in its
// widget embed: BsportWidget.mount({ companyId: … }).
//
// config: { company, include?: regex source matched against the class name }

import { getJson, session } from '../lib.mjs';

export async function scrape({ company, include }, { dates }) {
  const keep = include ? new RegExp(include, 'i') : null;
  const out = [];
  let url = `https://api.production.bsport.io/book/v1/offer/?${new URLSearchParams({ company, min_date: dates[0], max_date: dates.at(-1), page_size: '200' })}`;
  for (let page = 0; url && page < 20; page++) {
    const d = await getJson(url);
    for (const o of d.results) {
      const name = o.name_override || o.activity_name;
      if (!o.effectif || o.manager_only || (keep && !keep.test(name))) continue;
      out.push(session({
        id: String(o.id),
        start: new Date(o.date_start),
        durationMin: o.duration_minute,
        name,
        capacity: o.effectif,
        booked: o.validated_booking_count,
      }));
    }
    url = d.next_page;
  }
  return out;
}
