// API for the sauna map. Static files in ../public are served by Pages;
// only /api/* reaches this code, via functions/api/[[path]].js.
//
//   POST /api/ingest                      one scraper run (bearer INGEST_TOKEN)
//   GET  /api/venues                      venues + next-7-days stats
//   GET  /api/day?date=YYYY-MM-DD         every session on a London date
//   GET  /api/venues/:id/pattern          avg fill by weekday x hour, past sessions
//   GET  /api/curve?venue=..&session=..   booking curve of one session
//   POST /api/e                           one analytics event from the page (no cookies)
//   GET  /api/stats?days=30               usage summary (bearer STATS_TOKEN)

const TZ = 'Europe/London';
const londonDate = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(d);

// D1 counts every statement against a per-invocation limit, so rows go in as
// one JSON parameter per chunk and SQLite's json_each unpacks them.
const CHUNK = 400;

const json = (data, status = 200, maxAge = 0) => new Response(JSON.stringify(data), {
  status,
  headers: {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': maxAge ? `public, max-age=${maxAge}` : 'no-store',
  },
});

async function ingest(request, env) {
  const auth = request.headers.get('Authorization') ?? '';
  if (!env.INGEST_TOKEN || auth !== `Bearer ${env.INGEST_TOKEN}`) return json({ error: 'unauthorized' }, 401);

  const run = await request.json();
  if (!run?.scraped_at || !Array.isArray(run.venues) || !Array.isArray(run.rows)) {
    return json({ error: 'expected {scraped_at, venues, rows}' }, 400);
  }
  const at = run.scraped_at;
  const stmts = [
    env.DB.prepare(`
      INSERT INTO venues (id, venue, site, platform, address, lat, lng, url, last_scraped_at, last_ok, last_error)
      SELECT v->>'id', v->>'venue', v->>'site', v->>'platform', v->>'address', v->>'lat', v->>'lng', v->>'url',
             ?1, v->>'ok', v->>'error'
      FROM (SELECT value AS v FROM json_each(?2)) WHERE true
      ON CONFLICT (id) DO UPDATE SET
        venue = excluded.venue, site = excluded.site, platform = excluded.platform, address = excluded.address,
        lat = excluded.lat, lng = excluded.lng, url = excluded.url,
        last_scraped_at = excluded.last_scraped_at, last_ok = excluded.last_ok, last_error = excluded.last_error
    `).bind(at, JSON.stringify(run.venues)),
  ];
  for (let i = 0; i < run.rows.length; i += CHUNK) {
    const chunk = JSON.stringify(run.rows.slice(i, i + CHUNK));
    // Runs every 15 minutes and most sessions don't change between runs, so
    // only write what changed (D1's free tier allows 100k row writes a day).
    // A snapshot is kept when the numbers differ from the session's current
    // row; this must run before the sessions upsert below.
    stmts.push(env.DB.prepare(`
      INSERT INTO snapshots (venue_id, session_id, scraped_at, capacity, booked, waitlist, minutes_to_start)
      SELECT r->>'venue_id', r->>'session_id', ?1, r->>'capacity', r->>'booked', r->>'waitlist', r->>'minutes_to_start'
      FROM (SELECT value AS r FROM json_each(?2))
      WHERE (r->>'minutes_to_start') >= -15 AND NOT EXISTS (
        SELECT 1 FROM sessions s
        WHERE s.venue_id = r->>'venue_id' AND s.session_id = r->>'session_id'
          AND s.capacity = r->>'capacity' AND s.booked = r->>'booked' AND s.waitlist IS (r->>'waitlist'))
      ON CONFLICT DO NOTHING
    `).bind(at, chunk));
    // Stop updating a session once it has started, so it keeps its final numbers.
    stmts.push(env.DB.prepare(`
      INSERT INTO sessions (venue_id, session_id, start_utc, date, weekday, start_local, duration_min, name,
                            capacity, booked, waitlist, first_seen, last_seen)
      SELECT r->>'venue_id', r->>'session_id', r->>'start_utc', r->>'date', r->>'weekday', r->>'start_local',
             r->>'duration_min', r->>'name', r->>'capacity', r->>'booked', r->>'waitlist', ?1, ?1
      FROM (SELECT value AS r FROM json_each(?2)) WHERE (r->>'minutes_to_start') >= -15
      ON CONFLICT (venue_id, session_id) DO UPDATE SET
        start_utc = excluded.start_utc, date = excluded.date, weekday = excluded.weekday,
        start_local = excluded.start_local, duration_min = excluded.duration_min, name = excluded.name,
        capacity = excluded.capacity, booked = excluded.booked, waitlist = excluded.waitlist,
        last_seen = excluded.last_seen
      WHERE sessions.capacity IS NOT excluded.capacity OR sessions.booked IS NOT excluded.booked
         OR sessions.waitlist IS NOT excluded.waitlist OR sessions.start_utc IS NOT excluded.start_utc
         OR sessions.name IS NOT excluded.name OR sessions.duration_min IS NOT excluded.duration_min
    `).bind(at, chunk));
  }
  // Drop upcoming sessions that this run no longer lists (cancelled, or wrongly
  // recorded before), but only on venue-days the run actually returned rows for,
  // so one failed page load doesn't wipe a day.
  // (last_seen only moves when a row changes, so match on session ids.)
  const venueDays = [...new Set(run.rows.map((r) => `${r.venue_id}|${r.date}`))];
  const seen = run.rows.map((r) => `${r.venue_id}|${r.session_id}`);
  const cutoff = new Date(new Date(at).getTime() + 15 * 60000).toISOString();
  stmts.push(env.DB.prepare(`
    DELETE FROM sessions
    WHERE start_utc > ?1
      AND (venue_id || '|' || date) IN (SELECT value FROM json_each(?2))
      AND (venue_id || '|' || session_id) NOT IN (SELECT value FROM json_each(?3))
  `).bind(cutoff, JSON.stringify(venueDays), JSON.stringify(seen)));
  const results = await env.DB.batch(stmts);
  const written = results.reduce((n, r) => n + (r.meta?.rows_written ?? 0), 0);
  return json({ ok: true, venues: run.venues.length, rows: run.rows.length, rows_written: written });
}

async function venues(env) {
  const now = new Date();
  const until = londonDate(new Date(now.getTime() + 6 * 86400e3));
  const { results: vs } = await env.DB.prepare(`SELECT * FROM venues ORDER BY venue, site`).all();
  const { results: stats } = await env.DB.prepare(`
    SELECT venue_id,
           count(*) AS sessions,
           sum(capacity) AS capacity,
           sum(min(booked, capacity)) AS booked,
           sum(booked >= capacity) AS full_sessions,
           min(CASE WHEN booked < capacity THEN start_utc END) AS next_open_utc
    FROM sessions
    WHERE start_utc >= ?1 AND date <= ?2 AND capacity > 0
    GROUP BY venue_id
  `).bind(now.toISOString(), until).all();
  const byId = Object.fromEntries(stats.map((s) => [s.venue_id, s]));
  return json({
    now: now.toISOString(),
    venues: vs.map((v) => ({ ...v, last_ok: !!v.last_ok, upcoming: byId[v.id] ?? null })),
  }, 200, 60);
}

async function day(url, env) {
  const date = url.searchParams.get('date') ?? londonDate(new Date());
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return json({ error: 'date must be YYYY-MM-DD' }, 400);
  const { results } = await env.DB.prepare(`
    SELECT venue_id, session_id, start_utc, start_local, duration_min, name, capacity, booked, waitlist, last_seen
    FROM sessions WHERE date = ?1 AND capacity > 0
    ORDER BY start_utc, venue_id
  `).bind(date).all();
  return json({ date, sessions: results }, 200, 60);
}

async function pattern(id, env) {
  // Hour buckets from the London start time; fill capped at 100% per session.
  const { results } = await env.DB.prepare(`
    SELECT weekday, CAST(substr(start_local, 1, 2) AS INTEGER) AS hour,
           avg(min(booked, capacity) * 1.0 / capacity) AS fill,
           avg(booked) AS people,
           count(*) AS sessions
    FROM sessions
    WHERE venue_id = ?1 AND start_utc < ?2 AND capacity > 0
    GROUP BY weekday, hour
  `).bind(id, new Date().toISOString()).all();
  return json({ venue_id: id, cells: results }, 200, 300);
}

async function curve(url, env) {
  const venue = url.searchParams.get('venue'), session = url.searchParams.get('session');
  if (!venue || !session) return json({ error: 'venue and session required' }, 400);
  const { results } = await env.DB.prepare(`
    SELECT scraped_at, capacity, booked, waitlist, minutes_to_start
    FROM snapshots WHERE venue_id = ?1 AND session_id = ?2 ORDER BY scraped_at
  `).bind(venue, session).all();
  return json({ venue_id: venue, session_id: session, points: results }, 200, 300);
}

// --- analytics ---------------------------------------------------------------

const EVENT_TYPES = new Set(['pageview', 'book_click', 'venue_open', 'filter']);
const BOT = /bot|crawl|spider|slurp|preview|headless|lighthouse|monitor|curl|wget|python|node-fetch/i;
const clip = (v, n = 120) => (v == null ? null : String(v).slice(0, n));

async function sha256hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function track(request, env) {
  const ua = request.headers.get('User-Agent') ?? '';
  if (!ua || BOT.test(ua)) return new Response(null, { status: 204 });
  let e;
  try { e = JSON.parse(await request.text()); } catch { return json({ error: 'bad json' }, 400); }
  if (!EVENT_TYPES.has(e?.t)) return json({ error: 'unknown event' }, 400);

  const now = new Date();
  const day = londonDate(now);
  const ip = request.headers.get('CF-Connecting-IP') ?? '';
  // Rotates daily: the same person gets a new id tomorrow, and the id can't be reversed.
  const visitor = (await sha256hex(`${day}|${ip}|${ua}|${env.STATS_SALT ?? env.INGEST_TOKEN ?? ''}`)).slice(0, 16);
  let referrer = null;
  try { if (e.r) referrer = new URL(e.r).hostname.replace(/^www\./, ''); } catch {}
  if (referrer && referrer === new URL(request.url).hostname) referrer = null;

  await env.DB.prepare(`
    INSERT INTO events (ts, day, visitor, type, venue_id, detail, path, referrer, utm_source, country, device)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
  `).bind(
    now.toISOString(), day, visitor, e.t, clip(e.v, 60), clip(e.d), clip(e.p, 200), referrer, clip(e.u, 60),
    request.cf?.country ?? null, /Mobi|Android|iPhone/i.test(ua) ? 'mobile' : 'desktop',
  ).run();
  return new Response(null, { status: 204 });
}

async function stats(url, request, env) {
  const auth = request.headers.get('Authorization') ?? '';
  if (!env.STATS_TOKEN || auth !== `Bearer ${env.STATS_TOKEN}`) return json({ error: 'unauthorized' }, 401);
  const days = Math.min(365, Math.max(1, Number(url.searchParams.get('days')) || 30));
  const since = londonDate(new Date(Date.now() - (days - 1) * 86400e3));
  const q = (sql) => env.DB.prepare(sql).bind(since).all().then((r) => r.results);
  const [totals, daily, venues, referrers, sources, countries, devices, filters] = await Promise.all([
    q(`SELECT count(DISTINCT visitor || day) AS visitors,
              sum(type = 'pageview') AS pageviews,
              sum(type = 'book_click') AS book_clicks,
              count(DISTINCT CASE WHEN type = 'book_click' THEN visitor || day END) AS clicking_visitors,
              sum(type = 'venue_open') AS venue_opens
       FROM events WHERE day >= ?1`),
    q(`SELECT day, count(DISTINCT visitor) AS visitors, sum(type = 'pageview') AS pageviews,
              sum(type = 'book_click') AS book_clicks
       FROM events WHERE day >= ?1 GROUP BY day ORDER BY day`),
    q(`SELECT venue_id, sum(type = 'book_click') AS book_clicks,
              sum(type = 'book_click' AND detail = 'session') AS session_clicks,
              sum(type = 'venue_open') AS opens
       FROM events WHERE day >= ?1 AND venue_id IS NOT NULL GROUP BY venue_id ORDER BY book_clicks DESC, opens DESC`),
    q(`SELECT coalesce(referrer, '(direct)') AS name, count(DISTINCT visitor || day) AS visitors
       FROM events WHERE day >= ?1 AND type = 'pageview' GROUP BY name ORDER BY visitors DESC LIMIT 20`),
    q(`SELECT utm_source AS name, count(DISTINCT visitor || day) AS visitors
       FROM events WHERE day >= ?1 AND type = 'pageview' AND utm_source IS NOT NULL GROUP BY name ORDER BY visitors DESC LIMIT 20`),
    q(`SELECT coalesce(country, '??') AS name, count(DISTINCT visitor || day) AS visitors
       FROM events WHERE day >= ?1 GROUP BY name ORDER BY visitors DESC LIMIT 15`),
    q(`SELECT device AS name, count(DISTINCT visitor || day) AS visitors
       FROM events WHERE day >= ?1 GROUP BY name ORDER BY visitors DESC`),
    q(`SELECT detail AS name, count(*) AS uses
       FROM events WHERE day >= ?1 AND type = 'filter' GROUP BY name ORDER BY uses DESC LIMIT 20`),
  ]);
  return json({ since, days, totals: totals[0], daily, venues, referrers, sources, countries, devices, filters });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const { pathname } = url;
    try {
      if (pathname === '/api/ingest' && request.method === 'POST') return await ingest(request, env);
      if (pathname === '/api/e' && request.method === 'POST') return await track(request, env);
      if (request.method !== 'GET') return json({ error: 'method not allowed' }, 405);
      if (pathname === '/api/venues') return await venues(env);
      if (pathname === '/api/day') return await day(url, env);
      if (pathname === '/api/curve') return await curve(url, env);
      if (pathname === '/api/stats') return await stats(url, request, env);
      const m = pathname.match(/^\/api\/venues\/([\w-]+)\/pattern$/);
      if (m) return await pattern(m[1], env);
      return json({ error: 'not found' }, 404);
    } catch (err) {
      console.error(err);
      return json({ error: String(err?.message ?? err) }, 500);
    }
  },
};
