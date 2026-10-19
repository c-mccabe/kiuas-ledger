# London sauna tracker

Snapshots how full upcoming sessions are at 29 London saunas, so we can learn when each one is busy or quiet. It grew out of [druid-sauna-tracker](https://github.com/c-mccabe/druid-sauna-tracker), which covers Druid Street only.

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
| Arvo | Walthamstow | bookasession.org | spaces left | `effectiveCapacity`, `spotsRemaining` |
| Old Kent Road Sauna | Peckham | bookasession.org | spaces left | `effectiveCapacity`, `spotsRemaining` |
| Yogahome | Stoke Newington | Mindbody | spots left | `capacity`, `openings`, drop-in prices |
| The Sanctuary &Soul | Shoreditch | Momence (class schedule) | spots left | `capacity`, `remainingSpots`, `fixedTicketPrice` |
| Sweheat | Royal Docks | Acuity Scheduling | nothing | `slotsAvailable` per start time, `classSize` and price per type |
| Revitalise Urban Spa | Hackney | bsport | spots left | `effectif`, `validated_booking_count` |
| Lowlu | Wandsworth, Kentish Town, Ilford | Lowlu's own app | nothing | `booking_spaces`, `booking_count`, `price` |
| Temz Floating Saunas | Teddington, Hampton Court | Wunderbook | "booked/capacity" on each session | nothing usable (encrypted); we read the page |

We looked at these and left them out for now:

- **Rooftop Saunas** (Hackney, Brixton) and **Skuna Boats** (Canary Wharf) only sell private cabins or boats, so "how full" just means booked or not.
- **Finnish Church** (Rotherhithe), **Porchester Spa** and **York Hall** are walk-in or council leisure-centre spas with no session booking.
- **Slomo** (King's Cross) is a seasonal pop-up behind Cloudflare Turnstile. **Banya No.1**: we couldn't find a working site. **Sea Lanes** (Canary Wharf): no booking site found yet.

## How each adapter works

`src/adapters/<platform>.mjs` exports `scrape(config, { now, days, dates })` and returns sessions as `{ id, start, durationMin, name, capacity, booked, waitlist, price }`. `price` is the standard one-person price in pounds where the platform exposes it: Bookee `service_data.price`, Periode the product's `price` (pence, VAT included, i.e. the "Session" price the booking page shows), Momence `priceInCurrency` and `fixedTicketPrice`, Mindbody and Acuity the type's price, Lowlu the session's `price`. Mariana Tek, Arketa, LegitFit and bsport don't expose one, so those are blank.

- **bookee**: the API sits behind an AWS WAF bot challenge. We load the widget in headless Chromium, wait for the WAF token in `localStorage`, then POST to `/api/embed/events` from inside the page for each date. This is the same approach as druid-sauna-tracker.
- **periode**: the booking pages are a Firebase app. We load `minside.periode.no/bookinggroups/<merchant>/<group>/<date>` for each day, record the Firestore listen stream the page receives, and parse the `bookingManifests` and `dateSlots/.../slots/<date>` documents from it. Weekday and weekend products share saunas through a `parentProduct`, and the parent's slots are the source of truth; the products' own slot docs are often missing or stale. Where the parent's slots are whole sessions (1 to 1.5 hours), each one is a session start. Where they are a half-hour grid (`length` 0.5, e.g. Hackney Wick and weekends), a product holds `slotDelta + 1` consecutive half-hours, so a start is only valid if all of them exist, and spots left is the minimum free across them. Products with no parent use their own slots. If a page didn't deliver the parent docs, the day is retried once. Each page load uses its own browser context, because the Firebase SDK shares one connection between tabs and a second tab would get its data via IndexedDB instead of the stream we record. This is the slowest adapter, at one page load per site per day, with at most 4 at a time. `PERIODE_MAX_WAIT_MS` changes how long each page is given, and `PERIODE_DUMP=file.json` writes every Firestore document the pages delivered, for debugging.
- **marianatek / arketa / legitfit / momence**: these are plain unauthenticated JSON or GraphQL endpoints that the venues' own widgets call.
- **momence-schedule**: studios that embed Momence's class schedule read `readonly-api.momence.com/host-plugins/host/<hostId>/host-schedule/sessions`, which is public and returns capacity, remaining spots and price for every session. Find `hostId` by loading the booking page and watching for that request. Studios that also run yoga and so on get an `include` regex so only sauna sessions are kept.
- **bookasession**: a Next.js app with no separate JSON API. The public page `bookasession.org/<slug>` server-renders the whole booking window (about 20 days) into its React Server Components payload, and each session instance there has `effectiveCapacity` and `spotsRemaining`. We fetch the page and pull the instance objects out with regexes; names come from the instance or its template, and locations from the instance, its schedule or its one-off date. Arvo also runs a studio, so its config keeps only the sauna's `locationIds`.
- **mindbody**: the marketplace search API behind mindbody.io (`POST prod-mkt-gateway.mindbody.io/v1/search/class_times`, filtered by location `slug`) is public and returns `capacity` and `openings` for each class, plus purchase options; the price is the cheapest non-intro drop-in. Find a slug with `POST /v1/search/locations`. Only venues that sell sauna sessions as classes show up: FS8 and HOME don't, and Wellnest only lists a few guided rituals.
- **acuity**: the scheduling page `<name>.as.me` embeds the business's appointment types (`BUSINESS` JSON: name, duration, price, `classSize` for group classes), and `/api/scheduling/v1/availability/times?owner=…&appointmentTypeId=…&startDate=…` returns each start time's `slotsAvailable`. Sold-out times are left out of that response, so a full session just isn't listed. Sweheat's open sessions are a "service" with no size, so the config gives `serviceCapacity` (12, the most places ever seen free), and the 60- and 90-minute types share one room, so only the 90-minute starts are kept. Event types in the listed categories are picked up automatically.
- **bsport**: the widget reads `api.production.bsport.io/book/v1/offer/?company=<id>&min_date=…&max_date=…`, which is public and returns `effectif` (capacity) and `validated_booking_count` per class. Times come back in Paris time with an offset, which parses to the right instant. Find the company id in the page's `BsportWidget.mount({ companyId })`.
- **lowlu**: lowlu.com/book reads `prod-api.lowlu.co/schedules/club-id/<id>?start_date=…&date_range=…`, which lists each day's hourly sessions with `booking_spaces`, `booking_count` and `price`. Locked or privately hired hours are skipped. Club ids come from `/clubs/paginated`.
- **wunderbook**: the schedule API encrypts both request and response, so we don't use it. The public page shows "2/6" (booked/capacity) and the price on every session card; it's a Flutter app drawn on a canvas, but turning on Flutter's accessibility layer (clicking `flt-semantics-placeholder`) puts that text in the DOM. We click each day in the strip ("Next Month" when needed), scroll the lazy list, and split the text on the "HH:MM - HH:MM" times, using the site's `location` text to end the session name. Full sessions show no price.
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
| `price` | standard one-person price in £, blank where unknown (added 2026-10-19; older rows are blank) |

New columns are only ever added at the end. When a month's file predates one, the next run rewrites its header and pads the older rows.

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

- **What it shows.** Per region (or for all of London): a headline saying how many saunas have space for the chosen day, time and group size. Below that, a day timetable: one row per sauna, with each session placed on a shared hour axis. Each block fills from the bottom with an ember colour as it books up, and shows spots left and, where known and the block has room, the price. There's also a map with one pin per sauna, giving the number of sessions with space. Clicking a sauna opens its address, a booking button, and a weekday × hour "usually" heatmap, which fills in once history builds up. Members-only slots are hidden. Rows can be sorted by most space, cheapest ("from £X" among sessions still bookable) or nearest (browser geolocation, kept in the browser; "Near me" on the home page lands on `/areas/<region>?sort=near`).
- **Booking links** carry `utm_source=saunafinder&utm_medium=referral&utm_campaign=sauna_finder`. `utm_content` is `session` for a session block or `venue` for the "Book at" button, so each venue can see the traffic we send.
- **Data flow.** After each scrape, `src/push.mjs` POSTs `out/run.json` to `/api/ingest` using the `PUSH_URL` and `PUSH_TOKEN` repo secrets. The token must match the Pages secret `INGEST_TOKEN`. The CSVs in git stay the archive of record.
- **Code.** `functions/api/[[path]].js` hands every `/api/*` request to `src/worker.js`. `sessions` holds the latest numbers for each session and stops updating 15 minutes after the session starts. `snapshots` holds every observation (`/api/curve`).
- **Cleanup.** Each ingest deletes upcoming sessions (starting more than 15 minutes after the run) that the run didn't list, but only for venue-days the run covered. That removes cancelled sessions and ghosts. `last_seen` is the time a session's numbers last changed.
- **Analytics.** The page POSTs events to `/api/e`: `pageview`, `book_click`, `venue_open` and `filter`. There are no cookies. A visitor is `sha256(day|IP|user agent|STATS_SALT)` cut to 16 characters, so it rotates daily. Referrer is stored as host only, country comes from Cloudflare, and bots are dropped by user agent. Add `?ref=name` or `utm_source=name` to links you share and they show up under Campaigns. The dashboard is at `/stats` (not indexed). It asks for the Pages secret `STATS_TOKEN`, which is kept locally in `.env.local` as `STATS_KEY`, and it reads `GET /api/stats?days=N` with that key as a Bearer token.
- **Regions.** `src/regions.js` splits London into six regions (Central, North, East, South East, South West, West) by postcode district, so the site scales past a few dozen saunas. W1 and SW1 count as central, Chelsea and Fulham (SW3/5/6/7/10) as west, and outer postcodes join the region they border. `/api/venues` includes each venue's `region`.
- **Pages.** `/` serves `public/app.html` (the interactive timetable and map) for all of London, with region tabs (All, Central, North, East, South East, South West, West). `/areas/<region>` is the same page filtered to one region. Both are rendered through HTMLRewriter with the region's title, tabs, headline and venue cards, so crawlers see real content; `app.js` reads `data-region` from `<body>` and filters to it. `/all` and `/app` redirect to `/`. `?sauna=<id>` opens that sauna on the timetable, and `?sort=price|near` picks the sort.
- **SEO.** `src/seo.js`, routed by the small files in `functions/`, also renders `/saunas` (all, by region), `/saunas/<venue-site slug>` (the next 7 days, typical times, nearby saunas, schema.org `HealthAndBeautyBusiness`), plus `/sitemap.xml` and `/robots.txt`. Pages carry canonical, Open Graph and JSON-LD tags. `SITE_URL` in `wrangler.jsonc` is the canonical origin; any other host (preview deploys, or pages.dev once a custom domain is set) is sent `noindex`. The share image is `public/og.png`.
- **API.** `GET /api/venues`, `/api/day?date=YYYY-MM-DD`, `/api/venues/:id/pattern`, `/api/curve?venue=&session=`.
- **Free tier.** The scrape runs every 15 minutes (05:00–22:45 UTC, about 72 runs a day). Ingest only writes sessions whose numbers changed, and keeps a snapshot only when they change, which keeps writes well under D1's free limit of 100k a day. Git gets a data commit only from the :45 run of every second hour.
- **Deploy.** `cd web && npx wrangler pages deploy --branch main`. Migrations: `npx wrangler d1 migrations apply kiuas --remote`. Map tiles come from OpenStreetMap.
- **Design.** The interface uses cold colours (plunge-water blue-grey, slate ink, a teal accent). The data uses a single-hue ember ramp, which glows brighter at night in dark mode. The typeface is Schibsted Grotesk.

## Adding a venue

1. Load its booking page with devtools open (or a Playwright script that logs XHR responses) and find the request that returns the schedule.
2. If the platform already has an adapter, find the ID: Bookee `url_prefix` and `region_id`, Periode booking-group IDs from the site's "Book" links, Mariana Tek `region` and `location` from the `classes` call, Arketa host ID from the `widget-api` URL, LegitFit profile ID or slug from `legitfit.com/p/timetable/<id>`, Momence board and service IDs. Add a line to `src/venues.mjs`.
3. Otherwise, write `src/adapters/<platform>.mjs`.
