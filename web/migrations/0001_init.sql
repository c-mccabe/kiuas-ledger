-- Venues, upserted from each ingest so adding one to src/venues.mjs is enough.
CREATE TABLE venues (
  id TEXT PRIMARY KEY,
  venue TEXT NOT NULL,
  site TEXT NOT NULL,
  platform TEXT NOT NULL,
  address TEXT,
  lat REAL,
  lng REAL,
  url TEXT,
  last_scraped_at TEXT,
  last_ok INTEGER,
  last_error TEXT
);

-- Latest known state of each session. Updated on every ingest until the
-- session starts, so after that it holds (roughly) the final numbers.
CREATE TABLE sessions (
  venue_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  start_utc TEXT NOT NULL,
  date TEXT NOT NULL,
  weekday TEXT NOT NULL,
  start_local TEXT NOT NULL,
  duration_min INTEGER,
  name TEXT,
  capacity INTEGER NOT NULL,
  booked INTEGER NOT NULL,
  waitlist INTEGER,
  first_seen TEXT NOT NULL,
  last_seen TEXT NOT NULL,
  PRIMARY KEY (venue_id, session_id)
) WITHOUT ROWID;
CREATE INDEX sessions_date ON sessions (date, venue_id);

-- Every observation, for booking curves. Keyed so each row costs one write.
CREATE TABLE snapshots (
  venue_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  scraped_at TEXT NOT NULL,
  capacity INTEGER NOT NULL,
  booked INTEGER NOT NULL,
  waitlist INTEGER,
  minutes_to_start INTEGER NOT NULL,
  PRIMARY KEY (venue_id, session_id, scraped_at)
) WITHOUT ROWID;
