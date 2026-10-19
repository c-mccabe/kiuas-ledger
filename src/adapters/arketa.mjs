// Arketa (arketa.co). The booking widget's schedule endpoint returns
// max_capacity, total_booked and waitlistLength. No auth needed.

import { getJson, session } from '../lib.mjs';

export async function scrape({ hostId }, { now, days }) {
  const url = new URL(`https://widget-api-tkaeguucxq-uc.a.run.app/${hostId}/schedule`);
  url.search = new URLSearchParams({
    startDateTime: now.toISOString(),
    endDateTime: new Date(now.getTime() + days * 86400e3).toISOString(),
    timezone: 'Europe/London',
  });
  const body = await getJson(url);
  return body.data.classes
    .filter((c) => !c.canceled && c.max_capacity > 0)
    .map((c) => session({
      id: c.id,
      start: new Date(c.start_time * 1000),
      durationMin: c.duration,
      name: c.name,
      capacity: c.max_capacity,
      booked: c.total_booked,
      waitlist: c.waitlistLength,
    }));
}
