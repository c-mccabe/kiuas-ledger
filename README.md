# London sauna tracker

Snapshots how full upcoming sessions are at 13 London saunas, so we can learn when each one is busy or quiet. It grew out of [druid-sauna-tracker](https://github.com/c-mccabe/druid-sauna-tracker), which covers Druid Street only.

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

We looked at these and left them out for now:

- **Rooftop Saunas** (Hackney, Brixton) and **Skuna Boats** (Canary Wharf) only sell private cabins or boats, so "how full" just means booked or not.
- **Finnish Church** (Rotherhithe), **Porchester Spa** and **York Hall** are walk-in or council leisure-centre spas with no session booking.
- **Slomo** (King's Cross) is a seasonal pop-up behind Cloudflare Turnstile. **Banya No.1**: we couldn't find a working site. **Sea Lanes** (Canary Wharf): no booking site found yet.

## How each adapter works

`src/adapters/<platform>.mjs` exports `scrape(config, { now, days, dates })` and returns sessions as `{ id, start, durationMin, name, capacity, booked, waitlist }`.

- **bookee**: the API sits behind an AWS WAF bot challenge. We load the widget in headless Chromium, wait for the WAF token in `localStorage`, then POST to `/api/embed/events` from inside the page for each date. This is the same approach as druid-sauna-tracker.
- **periode**: the booking pages are a Firebase app. We load `minside.periode.no/bookinggroups/<merchant>/<group>/<date>` for each day, record the Firestore listen stream the page receives, and parse the `bookingManifests` and `dateSlots/.../slots/<date>` documents from it. Weekday and weekend products share saunas through a `parentProduct`, and the real counts sit on the parent's slots. Each page load uses its own browser context, because the Firebase SDK shares one connection between tabs and a second tab would get its data via IndexedDB instead of the stream we record. This adapter is the slowest one, at one page load per site per day, with at most 4 at a time. It also has known gaps. The page doesn't always query every product's slots, so a few site-days come back empty (e.g. Camberwell Sunday and Walthamstow Saturday in the first run), and the run log warns `parent slot docs missing`. On weekends the parent product (`HWi2...` at Stratford) holds a half-hourly occupancy timeline rather than per-session counts, and we take the value at each session's start. `PERIODE_DUMP=file.json` writes every Firestore document the pages delivered, for debugging.
- **marianatek / arketa / legitfit / momence**: these are plain unauthenticated JSON or GraphQL endpoints that the venues' own widgets call.
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

`.github/workflows/scrape.yml` runs the scraper on GitHub Actions and commits new rows to `data/`. It runs at :45 past every hour from 05:45 to 21:45 UTC. You can also start it from **Actions → Scrape sessions → Run workflow**, optionally with `only` and `days_ahead`.

Notes:

- **Minutes.** The repo is public, so Actions minutes are free. A run takes about 2.5 minutes on Actions, including the Chromium install.
- **Late runs.** GitHub's cron is best-effort, often 5–30 minutes late and sometimes skipped. `minutes_to_start` records the actual lead time.
- **Repo size.** About 1,000 rows (~130 KB) per run. Hourly, that's ~65 MB a month of CSV in git, so the monthly files will need compressing, or moving to a release asset or object storage, within a few months.
- **Fragility.** Bookee and Periode depend on page behaviour (the WAF token, the Firestore stream format), so they're the most likely to break. `latest-run.json` and the job log show which venue failed.

## Web app

`web/` is a Cloudflare Worker with a D1 (SQLite) database, live at https://kiuas.pintjudge-worker.workers.dev. It shows a map of the venues coloured by % booked, the sessions for each day with spaces left, filters (day, time of day, spots needed, hide full) and a weekday × hour "usual busyness" heatmap that fills in as history builds up.

- **Data flow.** After each scrape, `src/push.mjs` POSTs `out/run.json` to `/api/ingest` using the `PUSH_URL` and `PUSH_TOKEN` repo secrets. The token must match the Worker secret `INGEST_TOKEN`. The CSVs in git stay the archive of record.
- **Tables.** `sessions` holds the latest numbers for each session. It stops updating 15 minutes after a session starts, so past sessions keep their final fill. `snapshots` holds every observation, for booking curves (`/api/curve`).
- **API.** `GET /api/venues`, `/api/day?date=YYYY-MM-DD`, `/api/venues/:id/pattern`, `/api/curve?venue=&session=`.
- **Free tier.** About 3,200 rows written per run × 17 runs ≈ 55k a day, against D1's free limit of 100k a day. Storage grows by about 2 MB a day, against 5 GB free. If more venues push this past the write limit, store snapshots less often than hourly.
- **Deploy.** `cd web && npx wrangler deploy`. Migrations: `npx wrangler d1 migrations apply kiuas --remote`. Map tiles come from OpenStreetMap.

## Adding a venue

1. Load its booking page with devtools open (or a Playwright script that logs XHR responses) and find the request that returns the schedule.
2. If the platform already has an adapter, find the ID: Bookee `url_prefix` and `region_id`, Periode booking-group IDs from the site's "Book" links, Mariana Tek `region` and `location` from the `classes` call, Arketa host ID from the `widget-api` URL, LegitFit profile ID or slug from `legitfit.com/p/timetable/<id>`, Momence board and service IDs. Add a line to `src/venues.mjs`.
3. Otherwise, write `src/adapters/<platform>.mjs`.
