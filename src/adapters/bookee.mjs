// Bookee (bookeeapp.com). The events API returns max_allowed and booked for every
// session, but sits behind an AWS WAF bot challenge, so we load the real widget
// in Chromium and call the API from inside the page with the WAF token it stores.

import { newContext, session } from '../lib.mjs';

export async function scrape({ urlPrefix, regionId }, { dates }) {
  const ctx = await newContext();
  try {
    const page = await ctx.newPage();
    await page.goto(`https://${urlPrefix}.onbookee.com/class-schedule/r/${regionId}`, { waitUntil: 'networkidle', timeout: 60_000 });
    await page.waitForFunction(() => localStorage.getItem('aws-waf-token'), null, { timeout: 30_000 });

    const byDate = await page.evaluate(async ({ urlPrefix, regionId, dates }) => {
      const token = localStorage.getItem('aws-waf-token');
      const out = {};
      for (const date of dates) {
        const res = await fetch(`https://data.bookeeapp.com/api/embed/events?region_id=${regionId}&url_prefix=${urlPrefix}`, {
          method: 'POST',
          headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json',
            Authorization: 'Bearer null',
            'x-aws-waf-token': token,
          },
          body: JSON.stringify({ filters: {}, region_id: String(regionId), start_date: date }),
        });
        const body = await res.json().catch(() => null);
        if (!res.ok || body?.status !== 'success') {
          throw new Error(`events ${date}: HTTP ${res.status} ${JSON.stringify(body)?.slice(0, 200)}`);
        }
        out[date] = body.data.events;
      }
      return out;
    }, { urlPrefix, regionId, dates });

    // The API returns the requested day's events; dedupe by id in case days overlap.
    const seen = new Map();
    for (const events of Object.values(byDate)) {
      for (const e of events) {
        seen.set(e.id, session({
          id: e.id,
          start: new Date(e.starts_at * 1000),
          durationMin: e.ends_at ? Math.round((e.ends_at - e.starts_at) / 60) : '',
          name: e.name,
          capacity: e.max_allowed,
          booked: e.booked,
          waitlist: e.waitlist,
        }));
      }
    }
    return [...seen.values()];
  } finally {
    await ctx.close();
  }
}
