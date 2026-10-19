// Momence appointment boards (momence.com). Appointments aren't fixed classes:
// the board offers a start time every 30 min. The available-times endpoint
// lists, for each start time, the existing reservations overlapping it
// (occupiedByExistingReservations, with numberOfAttendees) and whether it is
// taken. We sum attendees per start time. No auth needed.

import { getJson, londonMidnightIso, session } from '../lib.mjs';

export async function scrape({ boardId, serviceId, durationMin }, { dates }) {
  const services = await getJson(`https://momence.com/_api/primary/plugin/appointment-boards/${boardId}/services`);
  const svc = services.find((s) => s.appointmentService.id === serviceId)?.appointmentService;
  if (!svc) throw new Error(`service ${serviceId} not on board ${boardId}`);
  const capacity = svc.maxAttendeeCapacity;

  const dayAfter = new Date(new Date(`${dates.at(-1)}T12:00:00Z`).getTime() + 86400e3).toISOString().slice(0, 10);
  const url = new URL(`https://momence.com/_api/primary/plugin/appointment-boards/${boardId}/available-times`);
  url.search = new URLSearchParams({
    from: londonMidnightIso(dates[0]),
    to: londonMidnightIso(dayAfter),
    attendeeCount: '1',
    serviceId: String(serviceId),
    durationInMinutes: String(durationMin),
    includeUnavailable: 'true',
  });
  const days = await getJson(url);
  const rows = [];
  for (const slot of days.flat()) {
    if (slot.isCutOff) continue; // already started / past the booking cut-off
    const reservations = slot.occupiedByExistingReservations ?? [];
    let booked = reservations.reduce((n, r) => n + r.numberOfAttendees, 0);
    // A taken slot doesn't always list its reservations; treat it as full.
    if (slot.isTaken && booked < capacity) booked = capacity;
    rows.push(session({
      id: `${serviceId}:${slot.value}`,
      start: new Date(slot.value),
      durationMin,
      name: svc.name.replace(/^[^\p{L}\p{N}]+/u, '').trim(),
      capacity,
      booked,
    }));
  }
  return rows;
}
