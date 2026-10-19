-- Cookieless usage analytics. `visitor` is a hash of (day, IP, user agent,
-- secret salt), so it can't be tracked across days or reversed to an IP.
CREATE TABLE events (
  id INTEGER PRIMARY KEY,
  ts TEXT NOT NULL,          -- ISO UTC
  day TEXT NOT NULL,         -- London date
  visitor TEXT NOT NULL,
  type TEXT NOT NULL,        -- pageview | book_click | venue_open | filter
  venue_id TEXT,
  detail TEXT,               -- e.g. utm_content for clicks, filter name=value
  path TEXT,
  referrer TEXT,             -- referring host only
  utm_source TEXT,           -- utm_source/ref on the landing URL, for campaign tracking
  country TEXT,
  device TEXT                -- mobile | desktop
);
CREATE INDEX events_day_type ON events (day, type);
