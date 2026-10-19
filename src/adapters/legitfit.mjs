// LegitFit (legitfit.com). The public timetable's GraphQL query returns size
// (capacity) and filledSlotCount for each event. No auth needed.

import { getJson, session } from '../lib.mjs';

const QUERY = `query PublicTimetable($id: ID!, $start: Date!, $end: Date!) {
  publicProfessional(id: $id) {
    __typename
    ... on PublicProfessional {
      publicEvents(start: $start, end: $end, filters: {sessionTypes: [NORMAL, VIRTUAL]}) {
        __typename
        ... on PublicEventsSuccess { events { _id title start end size filledSlotCount } }
      }
    }
  }
}`;

export async function scrape({ profileId }, { now, days }) {
  const end = new Date(now.getTime() + days * 86400e3);
  const body = await getJson('https://legitfit.com/api/v2/graphql', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ operationName: 'PublicTimetable', query: QUERY, variables: { id: profileId, start: now.toISOString(), end: end.toISOString() } }),
  });
  const events = body?.data?.publicProfessional?.publicEvents?.events;
  if (!events) throw new Error(`unexpected response: ${JSON.stringify(body).slice(0, 300)}`);
  return events.map((e) => session({
    id: e._id,
    start: new Date(e.start),
    durationMin: Math.round((new Date(e.end) - new Date(e.start)) / 60000),
    name: e.title,
    capacity: e.size,
    booked: e.filledSlotCount,
  }));
}
