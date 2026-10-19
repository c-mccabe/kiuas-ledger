// Wunderbook (Temz floating saunas). The schedule API encrypts its requests and
// responses, so instead we read what the public page shows: each session card
// has "booked/capacity" (e.g. "2/6") and the price. The app is Flutter, which
// draws to a canvas; turning on its accessibility layer puts the same text in
// the DOM. We click through the day strip and scroll each day's list.
//
// config: { tenant, location } — `tenant` is the tenantName in the
// link.wunderbook.com URL; `location` is the place text each card shows (it
// separates the session name from the rest of the card).

import { fromLondon, newContext, session } from '../lib.mjs';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

// Text of every semantics node, in document order, joined.
const pageText = (page) => page.evaluate(() => document.querySelector('flt-semantics-host')?.textContent ?? '');

// Clicks the first semantics node whose text matches `re` (a source string).
async function clickNode(page, re) {
  const box = await page.evaluate((src) => {
    const r = new RegExp(src);
    const n = [...document.querySelectorAll('flt-semantics')].find((e) => r.test(e.textContent.trim()));
    if (!n) return null;
    const b = n.getBoundingClientRect();
    return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
  }, re);
  if (!box) return false;
  await page.mouse.click(box.x, box.y);
  return true;
}

function parseDay(text, date, location) {
  const list = text.slice(text.indexOf('Next Month') + 'Next Month'.length);
  const parts = list.split(/(\d\d:\d\d) - (\d\d:\d\d)/);
  const out = new Map();
  for (let i = 1; i + 2 < parts.length; i += 3) {
    const [from, to, body] = [parts[i], parts[i + 1], parts[i + 2]];
    const at = body.indexOf(location);
    const count = body.match(/(\d+)\s*\/\s*(\d+)/);
    if (at < 0 || !count) continue;
    const [h, m] = from.split(':').map(Number);
    const [eh, em] = to.split(':').map(Number);
    const name = body.slice(0, at).trim();
    out.set(`${from}:${name}`, session({
      id: `${date}T${from}:${name}`,
      start: fromLondon(date, h, m),
      durationMin: (eh * 60 + em) - (h * 60 + m),
      name,
      capacity: Number(count[2]),
      booked: Number(count[1]),
      price: Number(body.match(/£\s*([\d.]+)/)?.[1]),
    }));
  }
  return out;
}

export async function scrape({ tenant, location }, { dates }) {
  const ctx = await newContext();
  try {
    const page = await ctx.newPage();
    await page.setViewportSize({ width: 1200, height: 1600 });
    await page.goto(`https://link.wunderbook.com/tenant?tenantName=${encodeURIComponent(tenant)}`, { waitUntil: 'networkidle', timeout: 60_000 });
    await page.waitForTimeout(3000);
    await page.evaluate(() => document.querySelector('flt-semantics-placeholder')?.click());
    await page.waitForTimeout(1500);

    const out = [];
    for (const date of dates) {
      const [y, mo, d] = date.split('-').map(Number);
      const label = `${MONTHS[mo - 1]} ${y}`;
      await page.mouse.move(600, 200);
      await page.mouse.wheel(0, -20000); // back to the day strip
      await page.waitForTimeout(500);
      if (!(await pageText(page)).includes(label)) {
        await clickNode(page, '^Next Month');
        await page.waitForTimeout(2500);
        if (!(await pageText(page)).includes(label)) throw new Error(`wunderbook ${tenant}: couldn't reach ${label}`);
      }
      if (!(await clickNode(page, `^(Mon|Tue|Wed|Thu|Fri|Sat|Sun)\\s*${d}$`))) throw new Error(`wunderbook ${tenant}: no day ${date}`);
      await page.waitForTimeout(2500);
      // The list is lazy: only cards on screen are in the accessibility tree.
      const seen = new Map();
      for (let i = 0; i < 12; i++) {
        const before = seen.size;
        for (const [k, v] of parseDay(await pageText(page), date, location)) seen.set(k, v);
        if (i > 0 && seen.size === before) break;
        await page.mouse.move(600, 1200);
        await page.mouse.wheel(0, 1200);
        await page.waitForTimeout(700);
      }
      out.push(...seen.values());
    }
    return out;
  } finally {
    await ctx.close();
  }
}
