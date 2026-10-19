// Server-rendered pages for search engines and link previews. The timetable
// at / is drawn by app.js, so crawlers see little there; these pages carry
// the same data as plain HTML, one per sauna and one per area.
//
//   /                 the static index.html, plus canonical/OG tags and links
//   /saunas           every sauna, grouped by area
//   /saunas/:slug     one sauna: sessions with space this week, typical times
//   /areas/:slug      saunas in one part of London
//   /sitemap.xml, /robots.txt

const TZ = 'Europe/London';
const DAYS_AHEAD = 7;
const londonDate = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(d);
const fmtTime = (d) => new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(d);
const fmtDay = (d) => new Intl.DateTimeFormat('en-GB', { timeZone: TZ, weekday: 'long', day: 'numeric', month: 'long' }).format(d);
const fmtDayShort = (d) => new Intl.DateTimeFormat('en-GB', { timeZone: TZ, weekday: 'short', day: 'numeric', month: 'short' }).format(d);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const slugify = (s) => s.toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

// Same rule as app.js: members-only slots aren't bookable by the public.
const MEMBERS = /\bmembers\b|\bprivate (booking|hire)\b/i;

const SHORT = {
  'Community Sauna Baths': 'Community Sauna',
  'Druid Street Saunas': 'Druid Street',
  'The Cabin Sauna': 'The Cabin',
};

// Postcode area -> part of London. Outer-London postcodes fall into "outer".
const AREAS = {
  'central-london': { name: 'Central London', prefixes: ['EC', 'WC'] },
  'east-london': { name: 'East London', prefixes: ['E'] },
  'south-east-london': { name: 'South East London', prefixes: ['SE'] },
  'south-west-london': { name: 'South West London', prefixes: ['SW'] },
  'west-london': { name: 'West London', prefixes: ['W'] },
  'north-london': { name: 'North London', prefixes: ['N', 'NW'] },
  'outer-london': { name: 'Outer London', prefixes: [] },
};
function areaOf(v) {
  const pc = v.address?.match(/\b([A-Z]{1,2})\d[A-Z\d]?\s*\d[A-Z]{2}\b/);
  const letters = pc?.[1];
  for (const [slug, a] of Object.entries(AREAS)) if (a.prefixes.includes(letters)) return slug;
  return 'outer-london';
}

const fullName = (v) => `${v.venue} ${v.site}`;
const venueSlug = (v) => slugify(fullName(v));

function bookingUrl(url, content) {
  try {
    const u = new URL(url);
    u.searchParams.set('utm_source', 'saunafinder');
    u.searchParams.set('utm_medium', 'referral');
    u.searchParams.set('utm_campaign', 'sauna_finder');
    u.searchParams.set('utm_content', content);
    return u.toString();
  } catch {
    return url;
  }
}

function km(a, b) {
  const r = Math.PI / 180;
  const x = (b.lng - a.lng) * r * Math.cos(((a.lat + b.lat) / 2) * r);
  const y = (b.lat - a.lat) * r;
  return Math.sqrt(x * x + y * y) * 6371;
}

const siteUrl = (env) => (env.SITE_URL ?? 'https://sauna-finder.pages.dev').replace(/\/$/, '');

// Anything but the canonical host (preview deploys, pages.dev once a custom
// domain is live) stays out of the index.
function robotsHeader(request, env) {
  return new URL(request.url).host === new URL(siteUrl(env)).host ? {} : { 'X-Robots-Tag': 'noindex' };
}

function html(body, request, env, status = 200) {
  return new Response(body, {
    status,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'public, max-age=600',
      ...robotsHeader(request, env),
    },
  });
}

// ---- data -----------------------------------------------------------------

async function loadVenues(env) {
  const { results } = await env.DB.prepare(`SELECT * FROM venues ORDER BY venue, site`).all();
  return results.map((v) => ({ ...v, slug: venueSlug(v), area: areaOf(v) }));
}

// Upcoming public sessions for the next week, optionally for some venues only.
async function loadUpcoming(env, ids) {
  const now = new Date();
  const until = londonDate(new Date(now.getTime() + (DAYS_AHEAD - 1) * 86400e3));
  const where = ids ? `AND venue_id IN (SELECT value FROM json_each(?3))` : '';
  const stmt = env.DB.prepare(`
    SELECT venue_id, start_utc, date, start_local, duration_min, name, capacity, booked
    FROM sessions WHERE start_utc >= ?1 AND date <= ?2 AND capacity > 0 ${where}
    ORDER BY start_utc
  `);
  const { results } = await (ids ? stmt.bind(now.toISOString(), until, JSON.stringify(ids)) : stmt.bind(now.toISOString(), until)).all();
  return results
    .filter((s) => !MEMBERS.test(s.name ?? ''))
    .map((s) => ({ ...s, left: Math.max(0, s.capacity - s.booked) }));
}

async function loadPattern(env, id) {
  const { results } = await env.DB.prepare(`
    SELECT weekday, CAST(substr(start_local, 1, 2) AS INTEGER) AS hour,
           avg(min(booked, capacity) * 1.0 / capacity) AS fill, count(*) AS sessions
    FROM sessions
    WHERE venue_id = ?1 AND start_utc < ?2 AND capacity > 0 AND coalesce(name, '') NOT LIKE '%members%' AND coalesce(name, '') NOT LIKE '%private booking%'
    GROUP BY weekday, hour
  `).bind(id, new Date().toISOString()).all();
  return results;
}

function summarise(sessions) {
  const open = sessions.filter((s) => s.left > 0);
  return {
    total: sessions.length,
    open: open.length,
    next: open[0] ?? null,
    today: open.filter((s) => s.date === londonDate(new Date())).length,
  };
}

// ---- layout ---------------------------------------------------------------

const PAGE_CSS = `
.page { max-width: 980px; margin: 0 auto; padding: 0 28px 48px; }
.crumbs { margin: 26px 0 0; font-size: 13.5px; color: var(--stone-3); }
.crumbs a { color: inherit; }
.page h1 { font-size: clamp(30px, 4.6vw, 46px); line-height: 1.04; letter-spacing: -0.03em; font-weight: 800; margin: 10px 0 12px; text-wrap: balance; }
.page h2 { font-size: 20px; letter-spacing: -0.01em; margin: 34px 0 10px; }
.page p { max-width: 68ch; }
.page a { color: var(--plunge); text-underline-offset: 3px; }
.page .btn { color: var(--plunge-ink); }
.facts { display: flex; flex-wrap: wrap; gap: 8px 22px; padding: 0; list-style: none; color: var(--stone-2); }
.facts b { color: var(--stone); }
.dayblock { background: var(--paper); border-radius: 12px; padding: 12px 16px; margin-bottom: 8px; }
.dayblock h3 { margin: 0 0 8px; font-size: 15px; }
.chips { display: flex; flex-wrap: wrap; gap: 6px; }
.chip { display: inline-flex; gap: 6px; align-items: baseline; padding: 5px 10px; border-radius: 8px; background: var(--h0); color: var(--stone); text-decoration: none; font-size: 14px; }
.page a.chip { color: var(--stone); }
.chip b { font-weight: 700; }
.chip.full { background: var(--sunk); color: var(--stone-3); }
.chip.busy { background: var(--h2); }
.cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 10px; padding: 0; list-style: none; }
.cards li { background: var(--paper); border-radius: 12px; padding: 14px 16px; }
.cards a.name { font-weight: 700; font-size: 16px; color: var(--stone); text-decoration: none; }
.cards a.name:hover { text-decoration: underline; }
.cards p { margin: 4px 0 0; color: var(--stone-2); font-size: 14px; }
.muted { color: var(--stone-3); }
.cta { margin-top: 30px; display: flex; flex-wrap: wrap; gap: 10px; align-items: center; }
.ghost { display: inline-block; padding: 9px 16px; border-radius: 999px; background: var(--sunk); color: var(--stone) !important; text-decoration: none; font-weight: 600; }
@media (max-width: 640px) { .page { padding-inline: 16px; } }
`;

const MASTHEAD = `<header class="masthead">
    <a class="wordmark" href="/" aria-label="Sauna Finder home">
      <svg viewBox="0 0 32 32" aria-hidden="true">
        <path class="steam" d="M12 7c-1.5-1.6 1.5-2.4 0-4M17 6c-1.5-1.6 1.5-2.4 0-4M22 7c-1.5-1.6 1.5-2.4 0-4" />
        <ellipse class="s3" cx="16" cy="27" rx="13" ry="4" />
        <ellipse class="s2" cx="14.5" cy="20.5" rx="9.5" ry="3.8" />
        <ellipse class="s1" cx="17" cy="14.5" rx="6.5" ry="3" />
      </svg>
      <span>Sauna Finder</span>
    </a>
  </header>`;

// <head> tags shared by every page, including the injected ones on /.
export function headTags({ site, path, title, description, jsonld = [] }) {
  const url = `${site}${path}`;
  return `
  <link rel="canonical" href="${esc(url)}">
  <meta property="og:type" content="website">
  <meta property="og:site_name" content="Sauna Finder">
  <meta property="og:locale" content="en_GB">
  <meta property="og:title" content="${esc(title)}">
  <meta property="og:description" content="${esc(description)}">
  <meta property="og:url" content="${esc(url)}">
  <meta property="og:image" content="${site}/og.png">
  <meta property="og:image:width" content="1200">
  <meta property="og:image:height" content="630">
  <meta name="twitter:card" content="summary_large_image">
  ${jsonld.map((d) => `<script type="application/ld+json">${JSON.stringify(d).replace(/</g, '\\u003c')}</script>`).join('\n  ')}`;
}

function layout({ site, path, title, description, jsonld, body }) {
  return `<!doctype html>
<html lang="en-GB">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${esc(title)}</title>
  <meta name="description" content="${esc(description)}">
  <meta name="theme-color" content="#e8edee" media="(prefers-color-scheme: light)">
  <meta name="theme-color" content="#111719" media="(prefers-color-scheme: dark)">
  <link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><ellipse cx='16' cy='25' rx='13' ry='5' fill='%2322292d'/><ellipse cx='14' cy='17' rx='9' ry='4.5' fill='%234d585e'/><ellipse cx='17' cy='10' rx='6' ry='3.5' fill='%23db6a2c'/></svg>">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Schibsted+Grotesk:wght@400..900&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="/style.css">
  <style>${PAGE_CSS}</style>${headTags({ site, path, title, description, jsonld })}
</head>
<body>
  ${MASTHEAD}
  <main class="page">${body}</main>
  <footer class="foot">${footerLinks}</footer>
  <script>
    // Same cookieless page count as the timetable (see /api/e).
    try { const q = new URLSearchParams(location.search); navigator.sendBeacon('/api/e', JSON.stringify({ t: 'pageview', p: location.pathname, r: document.referrer, u: q.get('utm_source') ?? q.get('ref') })); } catch {}
  </script>
</body>
</html>`;
}

let footerLinks = '';
function setFooter(venues) {
  const areas = Object.entries(AREAS).filter(([slug]) => venues.some((v) => v.area === slug));
  footerLinks = `
    <nav aria-label="Saunas by area"><p><b>Saunas by area:</b> ${areas.map(([slug, a]) => `<a href="/areas/${slug}">${esc(a.name)}</a>`).join(' · ')} · <a href="/saunas">All saunas</a></p></nav>
    <p>Counts come from each sauna's public booking page, checked every 15 minutes. Book on the sauna's own site. Sauna Finder isn't affiliated with any of them.</p>`;
  return footerLinks;
}

function breadcrumbs(site, items) {
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: items.map(([name, path], i) => ({ '@type': 'ListItem', position: i + 1, name, item: `${site}${path}` })),
  };
}

function chip(s, v) {
  const t = fmtTime(new Date(s.start_utc));
  const tip = esc(`${s.name ?? ''}${s.duration_min ? `, ${s.duration_min} min` : ''}`);
  if (s.left === 0) return `<span class="chip full" title="${tip}">${t} <b>Full</b></span>`;
  const busy = s.booked / s.capacity >= 0.75 ? ' busy' : '';
  return `<a class="chip${busy}" title="${tip}" href="${esc(bookingUrl(v.url, 'seo'))}" rel="nofollow noopener" target="_blank">${t} <b>${plural(s.left, 'spot')} left</b></a>`;
}

function nextLine(sum) {
  if (!sum.next) return 'No sessions with space in the next week.';
  const d = new Date(sum.next.start_utc);
  const when = sum.next.date === londonDate(new Date()) ? `today at ${fmtTime(d)}` : `${fmtDayShort(d)} at ${fmtTime(d)}`;
  return `Next space: ${when}, ${plural(sum.next.left, 'spot')} left.`;
}

// ---- pages ----------------------------------------------------------------

async function venuePage(slug, request, env) {
  const site = siteUrl(env);
  const venues = await loadVenues(env);
  setFooter(venues);
  const v = venues.find((x) => x.slug === slug);
  if (!v) return notFound(request, env, venues);
  const [sessions, cells] = await Promise.all([loadUpcoming(env, [v.id]), loadPattern(env, v.id)]);
  const sum = summarise(sessions);
  const name = fullName(v);
  const area = AREAS[v.area];

  const byDay = new Map();
  for (const s of sessions) (byDay.get(s.date) ?? byDay.set(s.date, []).get(s.date)).push(s);
  const days = [...byDay.values()].map((list) => `
      <section class="dayblock"><h3>${esc(fmtDay(new Date(list[0].start_utc)))}</h3>
        <div class="chips">${list.map((s) => chip(s, v)).join('')}</div></section>`).join('');

  // Facts derived from this week's timetable, so every page says something true and specific.
  const lengths = sessions.map((s) => s.duration_min).filter(Boolean);
  const commonLen = lengths.length ? Object.entries(lengths.reduce((m, l) => ((m[l] = (m[l] ?? 0) + 1), m), {})).sort((a, b) => b[1] - a[1])[0][0] : null;
  const mode = (xs) => (xs.length ? Number(Object.entries(xs.reduce((m, x) => ((m[x] = (m[x] ?? 0) + 1), m), {})).sort((a, b) => b[1] - a[1])[0][0]) : null);
  const usualCap = mode(sessions.map((s) => s.capacity));
  const starts = sessions.map((s) => s.start_local.slice(-5)).sort();
  const pct = sessions.length ? Math.round((sessions.reduce((a, s) => a + Math.min(s.booked, s.capacity), 0) / sessions.reduce((a, s) => a + s.capacity, 0)) * 100) : null;

  // Busiest and quietest times once enough past sessions exist.
  let usually = '';
  const enough = cells.filter((c) => c.sessions >= 3);
  if (enough.length >= 6) {
    const byFill = [...enough].sort((a, b) => b.fill - a.fill);
    const label = (c) => `${c.weekday}s around ${String(c.hour).padStart(2, '0')}:00`;
    usually = `<h2>When it's usually busy</h2>
      <p>From past sessions, ${esc(shortName(v))} is busiest on ${label(byFill[0])} (${Math.round(byFill[0].fill * 100)}% booked on average) and quietest on ${label(byFill.at(-1))} (${Math.round(byFill.at(-1).fill * 100)}%).</p>`;
  }

  const nearby = venues.filter((x) => x.id !== v.id && x.lat != null && v.lat != null)
    .map((x) => ({ x, d: km(v, x) })).sort((a, b) => a.d - b.d).slice(0, 4);

  const title = `${name}: live sauna availability | Sauna Finder`;
  const description = `${sum.open ? `${plural(sum.open, 'session')} with space` : 'Sessions'} at ${name} in the next 7 days, rechecked live every 15 minutes. ${nextLine(sum)}`;
  const jsonld = [
    {
      '@context': 'https://schema.org',
      '@type': 'HealthAndBeautyBusiness',
      name,
      url: v.url,
      address: { '@type': 'PostalAddress', streetAddress: v.address, addressLocality: 'London', addressCountry: 'GB' },
      ...(v.lat != null ? { geo: { '@type': 'GeoCoordinates', latitude: v.lat, longitude: v.lng } } : {}),
    },
    breadcrumbs(site, [['Sauna Finder', '/'], ['Saunas', '/saunas'], [area.name, `/areas/${v.area}`], [name, `/saunas/${v.slug}`]]),
  ];

  const body = `
    <p class="crumbs"><a href="/">Sauna Finder</a> › <a href="/saunas">Saunas</a> › <a href="/areas/${v.area}">${esc(area.name)}</a></p>
    <h1>${esc(name)}: live availability</h1>
    <p>${!sum.total ? `We haven't seen any public sessions at ${esc(name)} for the next week yet.`
      : sum.open === sum.total ? `All ${plural(sum.total, 'public session')} at ${esc(name)} in the next week have space.`
      : `${sum.open} of the next ${plural(sum.total, 'public session')} at ${esc(name)} ${sum.open === 1 ? 'has' : 'have'} space.`} ${esc(nextLine(sum))}
      ${v.last_scraped_at ? `<span class="muted">Last checked ${esc(londonDate(new Date(v.last_scraped_at)) === londonDate(new Date()) ? 'today' : fmtDayShort(new Date(v.last_scraped_at)))} at ${esc(fmtTime(new Date(v.last_scraped_at)))}; rechecked every 15 minutes.</span>` : ''}</p>
    <ul class="facts">
      <li><b>Address</b> <a href="https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${v.venue} ${v.address}`)}" rel="nofollow noopener" target="_blank">${esc(v.address)}</a></li>
      ${commonLen ? `<li><b>Sessions</b> usually ${commonLen} minutes</li>` : ''}
      ${usualCap ? `<li><b>Usually</b> ${usualCap} places per session</li>` : ''}
      ${starts.length ? `<li><b>Start times</b> ${starts[0]} to ${starts.at(-1)}</li>` : ''}
      ${pct != null ? `<li><b>This week</b> ${pct}% booked so far</li>` : ''}
    </ul>
    <div class="cta">
      <a class="btn" href="${esc(bookingUrl(v.url, 'seo_venue'))}" rel="nofollow noopener" target="_blank">Book at ${esc(shortName(v))}</a>
      <a class="ghost" href="/?sauna=${encodeURIComponent(v.id)}">Compare with every London sauna</a>
    </div>
    <h2>Next 7 days</h2>
    ${days || '<p class="muted">No public sessions found for the next week.</p>'}
    <p class="muted">Tap a time to book it on ${esc(shortName(v))}'s own site. Members-only slots are left out.</p>
    ${usually}
    ${nearby.length ? `<h2>Saunas near ${esc(v.site)}</h2><ul class="cards">${nearby.map(({ x, d }) => `
      <li><a class="name" href="/saunas/${x.slug}">${esc(fullName(x))}</a><p>${d.toFixed(1)} km away</p></li>`).join('')}</ul>` : ''}`;
  return html(layout({ site, path: `/saunas/${v.slug}`, title, description, jsonld, body }), request, env);
}

function venueCards(list, sessions) {
  return `<ul class="cards">${list.map((v) => {
    const sum = summarise(sessions.filter((s) => s.venue_id === v.id));
    return `
      <li><a class="name" href="/saunas/${v.slug}">${esc(fullName(v))}</a>
        <p>${esc(v.address)}</p>
        <p>${sum.today ? `<b>${plural(sum.today, 'session')} with space today.</b> ` : ''}${esc(nextLine(sum))}</p></li>`;
  }).join('')}</ul>`;
}

async function areaPage(slug, request, env) {
  const site = siteUrl(env);
  const venues = await loadVenues(env);
  setFooter(venues);
  const area = AREAS[slug];
  const list = venues.filter((v) => v.area === slug);
  if (!area || !list.length) return notFound(request, env, venues);
  const sessions = await loadUpcoming(env, list.map((v) => v.id));
  const today = list.filter((v) => sessions.some((s) => s.venue_id === v.id && s.left > 0 && s.date === londonDate(new Date())));
  const title = `Saunas in ${area.name} with space right now | Sauna Finder`;
  const description = `Live availability for ${plural(list.length, 'sauna')} in ${area.name}: ${list.map(fullName).join(', ')}. Updated every 15 minutes.`;
  const others = Object.entries(AREAS).filter(([s]) => s !== slug && venues.some((v) => v.area === s));
  const body = `
    <p class="crumbs"><a href="/">Sauna Finder</a> › <a href="/saunas">Saunas</a></p>
    <h1>Live sauna availability in ${esc(area.name)}</h1>
    <p>${today.length} of the ${plural(list.length, 'sauna')} we track in ${esc(area.name)} ${today.length === 1 ? 'has' : 'have'} space today. Each listing shows the next session with a free spot, read live from the sauna's own booking page every 15 minutes.</p>
    ${venueCards(list, sessions)}
    <div class="cta"><a class="btn" href="/">See today's timetable</a></div>
    ${others.length ? `<h2>Other parts of London</h2><p>${others.map(([s, a]) => `<a href="/areas/${s}">${esc(a.name)}</a>`).join(' · ')}</p>` : ''}`;
  const jsonld = [breadcrumbs(site, [['Sauna Finder', '/'], ['Saunas', '/saunas'], [area.name, `/areas/${slug}`]])];
  return html(layout({ site, path: `/areas/${slug}`, title, description, jsonld, body }), request, env);
}

async function allSaunasPage(request, env) {
  const site = siteUrl(env);
  const venues = await loadVenues(env);
  setFooter(venues);
  const sessions = await loadUpcoming(env);
  const title = `Live availability at every London sauna we track | Sauna Finder`;
  const description = `${plural(venues.length, 'London sauna')} with live session availability, grouped by area. Updated every 15 minutes.`;
  const groups = Object.entries(AREAS).map(([slug, a]) => [slug, a, venues.filter((v) => v.area === slug)]).filter(([, , l]) => l.length);
  const body = `
    <p class="crumbs"><a href="/">Sauna Finder</a></p>
    <h1>London saunas, checked live</h1>
    <p>Sauna Finder is a live check of ${plural(venues.length, 'London sauna')}: every 15 minutes it reads each one's booking page and shows which sessions still have space. Pick one to see its week, or <a href="/">compare them all on one timetable</a>.</p>
    ${groups.map(([slug, a, list]) => `<h2><a href="/areas/${slug}">${esc(a.name)}</a></h2>${venueCards(list, sessions)}`).join('')}`;
  const jsonld = [
    breadcrumbs(site, [['Sauna Finder', '/'], ['Saunas', '/saunas']]),
    { '@context': 'https://schema.org', '@type': 'ItemList', itemListElement: venues.map((v, i) => ({ '@type': 'ListItem', position: i + 1, url: `${site}/saunas/${v.slug}`, name: fullName(v) })) },
  ];
  return html(layout({ site, path: '/saunas', title, description, jsonld, body }), request, env);
}

function notFound(request, env, venues) {
  setFooter(venues);
  const body = `<h1>No sauna here</h1><p>That page doesn't exist. Try <a href="/saunas">the list of London saunas</a>.</p>`;
  const res = layout({ site: siteUrl(env), path: '/saunas', title: 'Not found | Sauna Finder', description: 'Page not found.', body });
  return html(res.replace('<meta name="description"', '<meta name="robots" content="noindex">\n  <meta name="description"'), request, env, 404);
}

// ---- home page enrichment ---------------------------------------------------

// The static index.html, with canonical/OG/JSON-LD in <head> and a crawlable
// list of saunas and areas in the footer.
async function homePage(request, env) {
  const site = siteUrl(env);
  const res = await env.ASSETS.fetch(request);
  if (!res.ok || !res.headers.get('Content-Type')?.includes('text/html')) return res;
  const venues = await loadVenues(env);
  const head = headTags({
    site,
    path: '/',
    title: 'Live London sauna availability | Sauna Finder',
    description: `A live check of ${plural(venues.length, 'London sauna')}, every 15 minutes: which sessions have space right now.`,
    jsonld: [{
      '@context': 'https://schema.org',
      '@type': 'WebSite',
      name: 'Sauna Finder',
      url: `${site}/`,
      description: 'A live check of which London saunas have space, every 15 minutes.',
    }],
  });
  const areas = Object.entries(AREAS).filter(([slug]) => venues.some((v) => v.area === slug));
  const links = `
    <nav class="sitelinks" aria-label="Saunas">
      <p><b>Saunas:</b> ${venues.map((v) => `<a href="/saunas/${v.slug}">${esc(fullName(v))}</a>`).join(' · ')}</p>
      <p><b>By area:</b> ${areas.map(([slug, a]) => `<a href="/areas/${slug}">${esc(a.name)}</a>`).join(' · ')} · <a href="/saunas">All saunas</a></p>
    </nav>`;
  const out = new HTMLRewriter()
    .on('head', { element: (el) => el.append(head, { html: true }) })
    .on('footer.foot', { element: (el) => el.prepend(links, { html: true }) })
    .transform(res);
  const headers = new Headers(out.headers);
  headers.set('Cache-Control', 'public, max-age=300');
  for (const [k, val] of Object.entries(robotsHeader(request, env))) headers.set(k, val);
  return new Response(out.body, { status: out.status, headers });
}

async function sitemap(request, env) {
  const site = siteUrl(env);
  const venues = await loadVenues(env);
  const lastmod = venues.map((v) => v.last_scraped_at).filter(Boolean).sort().at(-1)?.slice(0, 10) ?? londonDate(new Date());
  const areas = Object.keys(AREAS).filter((slug) => venues.some((v) => v.area === slug));
  const paths = ['/', '/saunas', ...areas.map((s) => `/areas/${s}`), ...venues.map((v) => `/saunas/${v.slug}`)];
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${paths.map((p) => `  <url><loc>${site}${p}</loc><lastmod>${lastmod}</lastmod><changefreq>hourly</changefreq></url>`).join('\n')}
</urlset>
`;
  return new Response(xml, { headers: { 'Content-Type': 'application/xml; charset=utf-8', 'Cache-Control': 'public, max-age=3600' } });
}

function robots(request, env) {
  const site = siteUrl(env);
  const own = new URL(request.url).host === new URL(site).host;
  const body = own
    ? `User-agent: *\nDisallow: /api/\nDisallow: /stats\n\nSitemap: ${site}/sitemap.xml\n`
    : `User-agent: *\nDisallow: /\n`;
  return new Response(body, { headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'public, max-age=3600' } });
}

export async function handle(request, env) {
  const { pathname } = new URL(request.url);
  try {
    if (pathname === '/') return await homePage(request, env);
    if (pathname === '/sitemap.xml') return await sitemap(request, env);
    if (pathname === '/robots.txt') return robots(request, env);
    if (pathname === '/saunas' || pathname === '/saunas/') return await allSaunasPage(request, env);
    let m = pathname.match(/^\/saunas\/([a-z0-9-]+)\/?$/);
    if (m) return await venuePage(m[1], request, env);
    m = pathname.match(/^\/areas\/([a-z0-9-]+)\/?$/);
    if (m) return await areaPage(m[1], request, env);
    return env.ASSETS.fetch(request);
  } catch (err) {
    console.error(err);
    return new Response('Something went wrong.', { status: 500 });
  }
}

const shortName = (v) => SHORT[v.venue] ?? v.venue;
