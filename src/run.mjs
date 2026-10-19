// Snapshots how full upcoming sessions are at every venue in venues.mjs and
// appends one row per session to data/snapshots-YYYY-MM.csv.
//
// Env: DAYS_AHEAD (default 7), ONLY (comma-separated substrings of "venue site"
// to run a subset, e.g. ONLY=pulse,arc).

import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { closeBrowser, datesAhead, londonDate, londonTime, londonWeekday } from './lib.mjs';
import { VENUES } from './venues.mjs';

const DAYS_AHEAD = Number(process.env.DAYS_AHEAD ?? 7);
const ONLY = (process.env.ONLY ?? '').toLowerCase().split(',').filter(Boolean);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = join(ROOT, 'data');
// Full results of this run, for src/push.mjs to send to the web backend. Not committed.
const OUT_FILE = join(ROOT, 'out', 'run.json');

const COLUMNS = [
  'scraped_at_utc', 'venue', 'site', 'platform', 'session_id', 'date', 'weekday', 'start_local',
  'duration_min', 'name', 'capacity', 'booked', 'spots_left', 'waitlist', 'minutes_to_start',
];

const csvCell = (v) => {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

async function main() {
  const now = new Date();
  const dates = datesAhead(now, DAYS_AHEAD);
  const venues = VENUES.filter((v) => !ONLY.length || ONLY.some((o) => `${v.venue} ${v.site}`.toLowerCase().includes(o)));
  const adapters = Object.fromEntries(await Promise.all(
    [...new Set(venues.map((v) => v.platform))].map(async (p) => [p, await import(`./adapters/${p}.mjs`)]),
  ));

  const results = await Promise.all(venues.map(async (v) => {
    const t0 = Date.now();
    try {
      const sessions = await adapters[v.platform].scrape(v.config, { now, days: DAYS_AHEAD, dates });
      return { v, sessions, ms: Date.now() - t0 };
    } catch (err) {
      return { v, error: err, ms: Date.now() - t0 };
    }
  }));
  await closeBrowser();

  const lastDay = dates.at(-1);
  const rows = [];
  for (const { v, sessions = [] } of results) {
    for (const s of sessions) {
      const date = londonDate(s.start);
      // Keep only sessions from now (or just started) up to the end of the window.
      const minutes = Math.round((s.start - now) / 60000);
      if (minutes < -120 || date > lastDay) continue;
      rows.push({
        venue_id: v.id,
        start_utc: s.start.toISOString(),
        scraped_at_utc: now.toISOString(),
        venue: v.venue,
        site: v.site,
        platform: v.platform,
        session_id: s.id,
        date,
        weekday: londonWeekday(s.start),
        start_local: londonTime(s.start),
        duration_min: s.durationMin,
        name: s.name,
        capacity: s.capacity,
        booked: s.booked,
        spots_left: s.capacity - s.booked,
        waitlist: s.waitlist,
        minutes_to_start: minutes,
      });
    }
  }
  rows.sort((a, b) => a.venue.localeCompare(b.venue) || a.site.localeCompare(b.site) || a.date.localeCompare(b.date) || a.start_local.localeCompare(b.start_local));

  // One file per month keeps files a manageable size for git.
  mkdirSync(DATA_DIR, { recursive: true });
  const file = join(DATA_DIR, `snapshots-${londonDate(now).slice(0, 7)}.csv`);
  if (!existsSync(file)) appendFileSync(file, COLUMNS.join(',') + '\n');
  if (rows.length) appendFileSync(file, rows.map((r) => COLUMNS.map((c) => csvCell(r[c])).join(',')).join('\n') + '\n');

  // Per-run summary, overwritten each run, for a quick look at the latest state.
  const summary = results.map(({ v, sessions, error, ms }) => {
    const mine = rows.filter((r) => r.venue === v.venue && r.site === v.site);
    const cap = mine.reduce((n, r) => n + r.capacity, 0);
    const booked = mine.reduce((n, r) => n + Math.min(r.booked, r.capacity), 0);
    return {
      venue: v.venue, site: v.site, platform: v.platform, ok: !error, seconds: Math.round(ms / 100) / 10,
      sessions: mine.length, capacity: cap, booked, fill: cap ? Math.round((booked / cap) * 1000) / 10 : null,
      error: error ? String(error.message ?? error).slice(0, 300) : undefined,
      raw_sessions: sessions?.length,
    };
  });
  writeFileSync(join(DATA_DIR, 'latest-run.json'), JSON.stringify({ scraped_at_utc: now.toISOString(), days_ahead: DAYS_AHEAD, venues: summary }, null, 2) + '\n');

  mkdirSync(dirname(OUT_FILE), { recursive: true });
  writeFileSync(OUT_FILE, JSON.stringify({
    scraped_at: now.toISOString(),
    venues: results.map(({ v, error }) => {
      const { config, ...meta } = v;
      return { ...meta, ok: !error, error: error ? String(error.message ?? error).slice(0, 300) : null };
    }),
    rows: rows.map((r) => ({
      venue_id: r.venue_id, session_id: String(r.session_id), start_utc: r.start_utc, date: r.date,
      weekday: r.weekday, start_local: r.start_local, duration_min: r.duration_min === '' ? null : r.duration_min,
      name: r.name, capacity: r.capacity, booked: r.booked, waitlist: r.waitlist === '' ? null : r.waitlist,
      minutes_to_start: r.minutes_to_start,
    })),
  }));

  console.log(`Wrote ${rows.length} rows to ${file}\n`);
  for (const s of summary) {
    const label = `${s.venue} (${s.site})`.padEnd(42);
    console.log(s.ok
      ? `  ok   ${label} ${String(s.sessions).padStart(4)} sessions, ${String(s.fill ?? '-').padStart(5)}% booked  [${s.platform}, ${s.seconds}s]`
      : `  FAIL ${label} ${s.error}`);
  }

  const failed = summary.filter((s) => !s.ok);
  if (failed.length) {
    console.error(`\n${failed.length}/${summary.length} venues failed`);
    // Partial data is still worth committing; only fail the job if most venues broke.
    if (failed.length > summary.length / 2) process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
