// Mariana Tek (marianatek.com). The public classes endpoint returns capacity,
// available_spot_count and waitlist_count. No auth needed.

import { getJson, session } from '../lib.mjs';

export async function scrape({ tenant, region, location }, { dates }) {
  const url = new URL(`https://${tenant}.marianatek.com/api/customer/v1/classes`);
  url.search = new URLSearchParams({
    min_start_date: dates[0], max_start_date: dates.at(-1), page_size: '500', location, region,
  });
  const body = await getJson(url);
  return body.results
    .filter((c) => !c.is_cancelled && c.capacity > 0)
    .map((c) => session({
      id: c.id,
      start: new Date(c.start_datetime),
      durationMin: c.class_type?.duration ?? '',
      name: c.name,
      capacity: c.capacity,
      booked: c.capacity - c.available_spot_count,
      waitlist: c.waitlist_count,
    }));
}
