// Lowlu (Wandsworth, Kentish Town, Ilford). lowlu.com/book reads Lowlu's own
// public API: each day's schedule lists hourly sessions with `booking_spaces`
// (capacity), `booking_count` and the price. No auth needed. Club ids come
// from /clubs/paginated.
//
// config: { clubId }

import { fromLondon, getJson, londonDate, session } from '../lib.mjs';

export async function scrape({ clubId }, { dates }) {
  const q = new URLSearchParams({ start_date: dates[0], date_range: String(dates.length) });
  const { schedules } = await getJson(`https://prod-api.lowlu.co/schedules/club-id/${clubId}?${q}`);
  const want = new Set(dates);
  const out = [];
  for (const day of schedules) {
    const date = londonDate(new Date(day.schedule_date));
    if (day.is_closed || !want.has(date)) continue;
    for (const s of day.sessions) {
      // Locked or privately hired hours can't be booked by the public.
      if (s.is_locked || s.has_private_booking || !s.booking_spaces) continue;
      const [h, m] = s.start_time.split(':').map(Number);
      const [eh, em] = s.end_time.split(':').map(Number);
      const tag = s.is_female_only ? ' (women only)' : s.is_male_only ? ' (men only)' : '';
      out.push(session({
        id: String(s.id),
        start: fromLondon(date, h, m),
        durationMin: (eh * 60 + em) - (h * 60 + m),
        name: (s.activity_name || 'Sauna & cold plunge') + tag,
        capacity: s.booking_spaces,
        booked: Math.min(s.booking_spaces, (s.booking_count ?? 0) + (s.event_bookings_count ?? 0)),
        price: Number(s.price),
      }));
    }
  }
  return out;
}
