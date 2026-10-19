// Acuity Scheduling (Sweheat). The public scheduling page at <host>.as.me
// embeds the business's appointment types (name, duration, price, and
// classSize for group classes), and its availability API returns each start
// time with `slotsAvailable`. No auth needed. Sold-out times are left out of
// the response, so a full session simply isn't listed.
//
// config: { host, categories: [names], exclude?: regex source matched against
// the type name, serviceCapacity } — group classes carry their own classSize;
// open sessions sold as a "service" don't, so `serviceCapacity` is the room's
// size (the most slotsAvailable ever seen). New event types in the listed
// categories are picked up automatically.

import { USER_AGENT, getJson, session } from '../lib.mjs';

export async function scrape({ host, categories, exclude, serviceCapacity }, { dates }) {
  const res = await fetch(`https://${host}/`, { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`acuity ${host}: HTTP ${res.status}`);
  const business = JSON.parse((await res.text()).match(/BUSINESS\s*=\s*(\{.*?\});\s*\n/s)?.[1] ?? 'null');
  if (!business) throw new Error(`acuity ${host}: no BUSINESS config on page`);
  const skip = exclude ? new RegExp(exclude, 'i') : null;
  const types = categories.flatMap((c) => business.appointmentTypes[c] ?? [])
    .filter((t) => !(skip && skip.test(t.name)) && Number(t.classSize) !== 1); // classSize 1 = private hire

  const out = [];
  for (const type of types) {
    const { id } = type;
    const capacity = Number(type.classSize) || serviceCapacity;
    for (const date of dates) {
      const q = new URLSearchParams({ owner: business.ownerKey, appointmentTypeId: id, calendarId: 'any', startDate: date, timezone: 'Europe/London' });
      const times = (await getJson(`https://${host}/api/scheduling/v1/availability/times?${q}`))[date] ?? [];
      for (const t of times) {
        out.push(session({
          id: `${id}:${t.time}`,
          start: new Date(t.time.replace(/([+-]\d\d)(\d\d)$/, '$1:$2')),
          durationMin: type.duration,
          name: type.name,
          capacity,
          booked: Math.max(0, capacity - t.slotsAvailable),
          price: Number(type.price),
        }));
      }
    }
  }
  return out;
}
