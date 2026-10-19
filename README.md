# London sauna tracker

Snapshots how full upcoming sessions are at 18 London saunas, so we can learn when each one is busy or quiet. It grew out of [druid-sauna-tracker](https://github.com/c-mccabe/druid-sauna-tracker), which covers Druid Street only.

None of these venues shows a "X of Y booked" number for its regular sessions. A few show "Waitlist" or "sold out", or a count only for events. Every one of them loads the real numbers from a public booking API, though, the same way Druid Street's Bookee widget does.

## Venues

| Venue | Site | Booking platform | What the site shows | What the API exposes |
|---|---|---|---|---|
| Druid Street Saunas | Bermondsey | Bookee | nothing | `max_allowed`, `booked`, `waitlist` |
| Sauna Social Club | Peckham | Bookee | nothing | `max_allowed`, `booked`, `waitlist` |
| Community Sauna Baths | Hackney Wick, Stratford, Walthamstow, Camberwell, Peckham | Periode (Firebase) | price or "Waitlist"; "7 / 24" on events only | per-slot `available` (capacity) and `booked` |
| Arc | Canary Wharf | Mariana Tek | spots left on some classes | `capacity`, `available_spot_count`, `waitlist_count` |
| Hotdrop | Battersea | Arketa | nothing | `max_capacity`, `total_booked`, `waitlistLength` |
| Sauna & Plunge | Shoreditch | Momence (appointments) | nothing | reservations overlapping each start time, with attendee counts |
| The Cabin Sauna | Clapham Common | LegitFit | nothing | `size`, `filledSlotCount` |
| Pulse Club | Fulham, Putney | LegitFit | nothing | `size`, `filledSlotCount` |
| Saunos | Regent's Canal, Islington | LegitFit | nothing | `size`, `filledSlotCount` |
| Reset Sauna | Islington | Momence (class schedule) | spots left | `capacity`, `remainingSpots`, `fixedTicketPrice` |
| Waking Dreams | Bethnal Green | Momence (class schedule) | spots left | `capacity`, `remainingSpots`, `fixedTicketPrice` |
| Urban Heat | Camberwell | Momence (class schedule) | spots left | `capacity`, `remainingSpots`, `fixedTicketPrice` |
| Innervisions Alchemy | South Bermondsey | Momence (class schedule) | spots left | `capacity`, `remainingSpots`, `fixedTicketPrice` |

We looked at these and left them out for now:

- **Rooftop Saunas** (Hackney, Brixton) and **Skuna Boats** (Canary Wharf) only sell private cabins or boats, so "how full" just means booked or not.
- **Finnish Church** (Rotherhithe), **Porchester Spa** and **York Hall** are walk-in or council leisure-centre spas with no session booking.
- **Slomo** (King's Cross) is a seasonal pop-up behind Cloudflare Turnstile. **Banya No.1**: we couldn't find a working site. **Sea Lanes** (Canary Wharf): no booking site found yet.

## How each adapter works

`src/adapters/<platform>.mjs` exports `scrape(config, { now, days, dates })` and returns sessions as `{ id, start, durationMin, name, capacity, booked, waitlist }`.

- **bookee**: the API sits behind an AWS WAF bot challenge. We load the widget in headless Chromium, wait for the WAF token in `localStorage`, then POST to `/api/embed/events` from inside the page for each date. This is the same approach as druid-sauna-tracker.
- **periode**: the booking pages are a Firebase app. We load `minside.periode.no/bookinggroups/<merchant>/<group>/<date>` for each day, record the Firestore listen stream the page receives, and parse the `bookingManifests` and `dateSlots/.../slots/<date>` documents from it. Weekday and weekend products share saunas through a `parentProduct`, and the parent's slots are the source of truth; the products' own slot docs are often missing or stale. Where the parent's slots are whole sessions (1 to 1.5 hours), each one is a session start. Where they are a half-hour grid (`length` 0.5, e.g. Hackney Wick and weekends), a product holds `slotDelta + 1` consecutive half-hours, so a start is only valid if all of them exist, and spots left is the minimum free across them. Products with no parent use their own slots. If a page didn't deliver the parent docs, the day is retried once. Each page load uses its own browser context, because the Firebase SDK shares one connection between tabs and a second tab would get its data via IndexedDB instead of the stream we record. This is the slowest adapter, at one page load per site per day, with at most 4 at a time. `PERIODE_MAX_WAIT_MS` changes how long each page is given, and `PERIODE_DUMP=file.json` writes every Firestore document the pages delivered, for debugging.
- **marianatek / arketa / legitfit / momence**: these are plain unauthenticated JSON or GraphQL endpoints that the venues' own widgets call.
- **momence-schedule**: studios that embed Momence's class schedule read `readonly-api.momence.com/host-plugins/host/<hostId>/host-schedule/sessions`, which is public and returns capacity, remaining spots and price for every session. Find `hostId` by loading the booking page and watching for that request. Studios that also run yoga and so on get an `include` regex so only sauna sessions are kept.
- **momence** caveat: Sauna & Plunge has no fixed sessions. You book any 30-minute start time, and up to 6 people can share a slot. We record each start time with the attendees of the reservations overlapping it. So the "sessions" there are rolling slots rather than classes, and a 60-minute booking counts in two of them.

## Data

`data/snapshots-YYYY-MM.csv`, one row per session per run:

| column | meaning |
|---|---|
| `scraped_at_utc` | when the run started |
| `venue`, `site`, `platform` | which sauna, and which adapter |
| `session_id` | stable across runs, unique within a venue |
| `date`, `weekday`, `start_local`, `duration_min` | session start in London time |
| `name` | session name, e.g. "Sauna - Off-Peak Session" |
| `capacity`, `booked`, `spots_left` | `spots_left = capacity - booked`. It can be negative when a venue overbooks or later cuts capacity (seen at Community Sauna). |
| `waitlist` | waitlist size where the platform reports one |
| `minutes_to_start` | negative means the session had already started |

`data/latest-run.json` is overwritten on each run with a per-venue summary: OK or failed, session count, % booked and timing.

Each run looks 7 days ahead, so repeated runs give a booking curve for every session. To see how full a session ended up, take the row with the smallest non-negative `minutes_to_start` for each `(venue, site, session_id)`.

## Running locally

```sh
npm ci
npx playwright install chromium
npm run scrape                       # all venues, 7 days
ONLY=pulse,arc DAYS_AHEAD=2 npm run scrape   # a subset
```

One failing venue doesn't stop the others. The run exits non-zero only if more than half the venues fail.

## Deployment

`.github/workflows/scrape.yml` runs the scraper on GitHub Actions and commits new rows to `data/`. It runs every 15 minutes from 05:00 to 22:45 UTC; only the :45 run of every second hour (05:45–21:45) commits data to git. You can also start it from **Actions → Scrape sessions → Run workflow**, optionally with `only` and `days_ahead`.

Notes:

- **Minutes.** The repo is public, so Actions minutes are free. A run takes about 2.5 minutes on Actions, including the Chromium install.
- **Late runs.** GitHub's cron is best-effort, often 5–30 minutes late and sometimes skipped. `minutes_to_start` records the actual lead time.
- **Repo size.** About 1,000 rows (~130 KB) per run. At the archive rate (9 runs a day) that's ~35 MB a month of CSV in git, so the monthly files will need compressing, or moving to a release asset or object storage, within a few months.
- **Fragility.** Bookee and Periode depend on page behaviour (the WAF token, the Firestore stream format), so they're the most likely to break. `latest-run.json` and the job log show which venue failed.

## Web app

`web/` is a Cloudflare Pages site with a D1 (SQLite) database, live at https://sauna-finder.pages.dev.

- **What it shows.** Per region (or for all of London): a headline saying how many saunas have space for the chosen day, time and group size. Below that, a day timetable: one row per sauna, with each session placed on a shared hour axis. Each block fills from the bottom with an ember colour as it books up and shows spots left. There's also a map with one pin per sauna, giving the number of sessions with space. Clicking a sauna opens its address, a booking button, and a weekday × hour "usually" heatmap, which fills in once history builds up. Members-only slots are hidden.
- **Booking links** carry `utm_source=saunafinder&utm_medium=referral&utm_campaign=sauna_finder`. `utm_content` is `session` for a session block or `venue` for the "Book at" button, so each venue can see the traffic we send.
- **Data flow.** After each scrape, `src/push.mjs` POSTs `out/run.json` to `/api/ingest` using the `PUSH_URL` and `PUSH_TOKEN` repo secrets. The token must match the Pages secret `INGEST_TOKEN`. The CSVs in git stay the archive of record.
- **Code.** `functions/api/[[path]].js` hands every `/api/*` request to `src/worker.js`. `sessions` holds the latest numbers for each session and stops updating 15 minutes after the session starts. `snapshots` holds every observation (`/api/curve`).
- **Cleanup.** Each ingest deletes upcoming sessions (starting more than 15 minutes after the run) that the run didn't list, but only for venue-days the run covered. That removes cancelled sessions and ghosts. `last_seen` is the time a session's numbers last changed.
- **Analytics.** The page POSTs events to `/api/e`: `pageview`, `book_click`, `venue_open` and `filter`. There are no cookies. A visitor is `sha256(day|IP|user agent|STATS_SALT)` cut to 16 characters, so it rotates daily. Referrer is stored as host only, country comes from Cloudflare, and bots are dropped by user agent. Add `?ref=name` or `utm_source=name` to links you share and they show up under Campaigns. The dashboard is at `/stats` (not indexed). It asks for the Pages secret `STATS_TOKEN`, which is kept locally in `.env.local` as `STATS_KEY`, and it reads `GET /api/stats?days=N` with that key as a Bearer token.
- **Regions.** `src/regions.js` splits London into six regions (Central, North, East, South East, South West, West) by postcode district, so the site scales past a few dozen saunas. W1 and SW1 count as central, Chelsea and Fulham (SW3/5/6/7/10) as west, and outer postcodes join the region they border. `/api/venues` includes each venue's `region`.
- **Pages.** `/` is a server-rendered home page (`src/seo.js`): a full-bleed sauna photo, a live pill, six region tiles ("X of N saunas have space today", next free spot, one ember bar per sauna), a "Near me" button (browser geolocation picks the region of the nearest sauna; the location never leaves the browser), and the next free spots across London. `/areas/<region>` and `/all` serve `public/app.html` (the interactive timetable and map) through HTMLRewriter, with the region's title, tabs, headline and venue cards rendered server-side; `app.js` reads `data-region` from `<body>` and filters to it. `/app` redirects to `/all`. `?sauna=<id>` opens that sauna on the timetable.
- **SEO.** `src/seo.js`, routed by the small files in `functions/`, also renders `/saunas` (all, by region), `/saunas/<venue-site slug>` (the next 7 days, typical times, nearby saunas, schema.org `HealthAndBeautyBusiness`), plus `/sitemap.xml` and `/robots.txt`. Pages carry canonical, Open Graph and JSON-LD tags. `SITE_URL` in `wrangler.jsonc` is the canonical origin; any other host (preview deploys, or pages.dev once a custom domain is set) is sent `noindex`. The share image is `public/og.png`.
- **Photo.** The hero is "A wood burning stove inside of a wooden cabin" from Unsplash (photo `sDqyw1c5xaM`, Unsplash License, credited in the footer), saved as `public/img/hero-1200.jpg` and `hero-1800.jpg`.
- **API.** `GET /api/venues`, `/api/day?date=YYYY-MM-DD`, `/api/venues/:id/pattern`, `/api/curve?venue=&session=`.
- **Free tier.** The scrape runs every 15 minutes (05:00–22:45 UTC, about 72 runs a day). Ingest only writes sessions whose numbers changed, and keeps a snapshot only when they change, which keeps writes well under D1's free limit of 100k a day. Git gets a data commit only from the :45 run of every second hour.
- **Deploy.** `cd web && npx wrangler pages deploy --branch main`. Migrations: `npx wrangler d1 migrations apply kiuas --remote`. Map tiles come from OpenStreetMap.
- **Design.** The interface uses cold colours (plunge-water blue-grey, slate ink, a teal accent). The data uses a single-hue ember ramp, which glows brighter at night in dark mode. The typeface is Schibsted Grotesk.

## Adding a venue

1. Load its booking page with devtools open (or a Playwright script that logs XHR responses) and find the request that returns the schedule.
2. If the platform already has an adapter, find the ID: Bookee `url_prefix` and `region_id`, Periode booking-group IDs from the site's "Book" links, Mariana Tek `region` and `location` from the `classes` call, Arketa host ID from the `widget-api` URL, LegitFit profile ID or slug from `legitfit.com/p/timetable/<id>`, Momence board and service IDs. Add a line to `src/venues.mjs`.
3. Otherwise, write `src/adapters/<platform>.mjs`.
