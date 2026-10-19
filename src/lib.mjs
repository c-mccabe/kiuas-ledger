import { chromium } from 'playwright';

export const TZ = 'Europe/London';

// The default HeadlessChrome UA gets stuck at some bot challenges (Bookee's AWS WAF).
export const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

export const londonDate = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(d); // YYYY-MM-DD
export const londonWeekday = (d) => new Intl.DateTimeFormat('en-GB', { timeZone: TZ, weekday: 'short' }).format(d);
export const londonTime = (d) =>
  new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(d);

export function datesAhead(now, days) {
  const out = [];
  for (let i = 0; i < days; i++) out.push(londonDate(new Date(now.getTime() + i * 86400e3)));
  return [...new Set(out)];
}

// Offset of London from UTC, in minutes, at the given instant (60 in BST, 0 in GMT).
function londonOffsetMinutes(d) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: TZ, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).formatToParts(d).map((p) => [p.type, p.value]),
  );
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return Math.round((asUtc - d.getTime()) / 60000);
}

// London wall-clock date + time → Date.
export function fromLondon(date, hh, mm = 0) {
  const guess = new Date(`${date}T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00Z`);
  return new Date(guess.getTime() - londonOffsetMinutes(guess) * 60000);
}

// Start of the London day `date`, as an ISO string with offset (e.g. 2026-10-19T00:00:00+01:00).
export function londonMidnightIso(date) {
  const off = londonOffsetMinutes(fromLondon(date, 12));
  const sign = off >= 0 ? '+' : '-';
  const a = Math.abs(off);
  return `${date}T00:00:00${sign}${String(Math.floor(a / 60)).padStart(2, '0')}:${String(a % 60).padStart(2, '0')}`;
}

export async function getJson(url, init = {}) {
  const res = await fetch(url, {
    ...init,
    headers: { Accept: 'application/json', 'User-Agent': USER_AGENT, ...(init.headers ?? {}) },
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${init.method ?? 'GET'} ${url}: HTTP ${res.status} ${text.slice(0, 200)}`);
  return JSON.parse(text);
}

let browserPromise;
export function getBrowser() {
  browserPromise ??= chromium.launch({ headless: true });
  return browserPromise;
}
export async function closeBrowser() {
  if (browserPromise) await (await browserPromise).close();
}
export async function newContext() {
  const browser = await getBrowser();
  return browser.newContext({ userAgent: USER_AGENT, locale: 'en-GB', timezoneId: TZ });
}

// Builds a row from a session's start Date plus capacity numbers. Adapters return these.
// price: the standard one-person price in pounds, where the platform exposes it.
export function session({ id, start, durationMin, name, capacity, booked, waitlist = '', price = null }) {
  return { id, start, durationMin, name, capacity, booked, waitlist, price: Number.isFinite(price) ? Math.round(price * 100) / 100 : null };
}
