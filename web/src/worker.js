// API for the sauna map. Static files in ../public are served by Pages;
// only /api/* reaches this code, via functions/api/[[path]].js.
//
//   POST /api/ingest                      one scraper run (bearer INGEST_TOKEN)
//   GET  /api/venues                      venues + next-7-days stats
//   GET  /api/day?date=YYYY-MM-DD         every session on a London date
//   GET  /api/venues/:id/pattern          avg fill by weekday x hour, past sessions
//   GET  /api/curve?venue=..&session=..   booking curve of one session

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
    stmts.push(env.DB.prepare(`
      INSERT INTO snapshots (venue_id, session_id, scraped_at, capacity, booked, waitlist, minutes_to_start)
      SELECT r->>'venue_id', r->>'session_id', ?1, r->>'capacity', r->>'booked', r->>'waitlist', r->>'minutes_to_start'
      FROM (SELECT value AS r FROM json_each(?2)) WHERE true
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
    `).bind(at, chunk));
  }
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

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const { pathname } = url;
    try {
      if (pathname === '/api/ingest' && request.method === 'POST') return await ingest(request, env);
      if (request.method !== 'GET') return json({ error: 'method not allowed' }, 405);
      if (pathname === '/api/venues') return await venues(env);
      if (pathname === '/api/day') return await day(url, env);
      if (pathname === '/api/curve') return await curve(url, env);
      const m = pathname.match(/^\/api\/venues\/([\w-]+)\/pattern$/);
      if (m) return await pattern(m[1], env);
      return json({ error: 'not found' }, 404);
    } catch (err) {
      console.error(err);
      return json({ error: String(err?.message ?? err) }, 500);
    }
  },
};
