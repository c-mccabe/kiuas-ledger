// Momence class schedules (the "host schedule" plugin many studios embed):
// fixed sessions with a capacity, as opposed to the appointment boards in
// momence.mjs. The plugin reads a public, read-only API that returns each
// session's capacity and remaining spots. No auth needed.
//
// config: { hostId, include?: regex source matched against the session name,
//           locationIds?: [ids] } — studios that also run yoga etc. need
// `include` so only sauna sessions are kept.

import { getJson, londonMidnightIso, session } from '../lib.mjs';

const TYPES = ['course-class', 'fitness', 'retreat', 'special-event', 'special-event-new'];

export async function scrape({ hostId, include, locationIds = [] }, { dates }) {
  const dayAfter = new Date(new Date(`${dates.at(-1)}T12:00:00Z`).getTime() + 86400e3).toISOString().slice(0, 10);
  const q = new URLSearchParams({ fromDate: londonMidnightIso(dates[0]), toDate: londonMidnightIso(dayAfter), pageSize: '500', page: '0' });
  for (const t of TYPES) q.append('sessionTypes[]', t);
  for (const id of locationIds) q.append('locationIds[]', String(id));
  const { payload } = await getJson(`https://readonly-api.momence.com/host-plugins/host/${hostId}/host-schedule/sessions?${q}`);
  const keep = include ? new RegExp(include, 'i') : null;
  return payload
    .filter((s) => !s.isCancelled && s.inPerson !== false && s.capacity > 0)
    .filter((s) => !keep || keep.test(s.sessionName))
    .map((s) => session({
      id: String(s.id),
      start: new Date(s.startsAt),
      durationMin: s.durationMinutes,
      name: s.sessionName.replace(/^\[[^\]]*\]\s*/, '').trim(), // drop tags like "[recovery]"
      capacity: s.capacity,
      // remainingSpots is what the widget shows; ticketsSold can miss comps.
      booked: s.capacity - (s.remainingSpots?.remaining ?? s.capacity - (s.ticketsSold ?? 0)),
      price: s.fixedTicketPrice,
    }));
}
