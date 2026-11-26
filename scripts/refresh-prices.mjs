// Refreshes data/prices.json from maplestory-classic.com item pages.
// Runs in GitHub Actions. Writes data/refresh-log.json so each run's parsing can be checked.
import fs from "node:fs";

const PRICES = "data/prices.json", CATALOG = "data/catalog.json", LOG = "data/refresh-log.json";
const prices = JSON.parse(fs.readFileSync(PRICES, "utf8"));
const catalog = JSON.parse(fs.readFileSync(CATALOG, "utf8"));
const slugs = [...new Set([...Object.keys(prices.items), ...Object.keys(catalog.items).filter((s) => catalog.items[s].plan)])];
const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const num = (s) => +String(s).replace(/,/g, "");
const tag = (y, m, d) => String(y).slice(2) + String(m).padStart(2, "0") + String(d).padStart(2, "0");
const now = new Date(), todayTag = tag(now.getUTCFullYear(), now.getUTCMonth() + 1, now.getUTCDate());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const HOLD_MS = 18 * 3600e3; // a hand-read Cozy price (field t) is kept this long before the tracker may replace it
const log = { ranAt: now.toISOString(), items: {}, changed: 0, kept: 0, failed: 0 };

for (const slug of slugs) {
  const note = (log.items[slug] = {});
  try {
    const res = await fetch("https://maplestory-classic.com/market/" + slug, { headers: { "user-agent": "kerningstreetbets price refresh (+https://github.com/nathanshiaulam/kerningstreetbets)" } });
    note.status = res.status;
    if (!res.ok) { log.failed++; continue; }
    const html = await res.text();
    const text = html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/&[a-z#0-9]+;/gi, " ").replace(/\s+/g, " ");
    // daily rows such as "Nov 26, 2026 276,389 20" or "November 26, 2026 276,389 20"
    const rows = [];
    for (const m of text.matchAll(/\b([A-Z][a-z]{2})[a-z]*\.? (\d{1,2}), (\d{4}) ([\d,]{3,}) (\d{1,5})\b/g)) {
      const mo = MONTHS[m[1].toLowerCase()], p = num(m[4]);
      if (mo && p >= 100) rows.push([tag(+m[3], mo, +m[2]), p]);
    }
    const head = /sells for about ([\d,]+) mesos/i.exec(text) || /about ([\d,]+) mesos/i.exec(html);
    const sellers = /([\d,]+) players (?:are )?selling/i.exec(text);
    note.rows = rows.length; note.head = head ? num(head[1]) : null;
    rows.sort((a, b) => (a[0] < b[0] ? -1 : 1));
    const p = rows.length ? rows[rows.length - 1][1] : head ? num(head[1]) : null;
    if (p == null) { log.failed++; note.why = "no price found"; continue; }
    const e = prices.items[slug] || (prices.items[slug] = {});
    if (e.p && (p > e.p * 10 || p < e.p / 10)) { log.failed++; note.why = "implausible " + p + " vs " + e.p; continue; }
    if (sellers) e.s = num(sellers[1]);
    const pts = new Map((e.h || "").split(" ").filter(Boolean).map((x) => x.split(":")));
    const held = e.t && now - new Date(e.t) < HOLD_MS, heldTag = held ? tag(...e.t.slice(0, 10).split("-").map(Number)) : null;
    for (const [d, v] of rows.length ? rows : [[todayTag, p]]) if (!held || d < heldTag || !pts.has(d)) pts.set(d, String(v));
    e.h = [...pts.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).slice(-30).map((x) => x.join(":")).join(" ");
    if (held) { log.kept++; note.kept = true; continue; }
    delete e.t;
    if (e.p !== p) { log.changed++; e.p = p; }
    note.p = p;
  } catch (err) { log.failed++; note.why = String(err).slice(0, 120); }
  await sleep(700);
}

if (log.changed) { prices.asOf = now.toISOString(); }
fs.writeFileSync(PRICES, JSON.stringify(prices));
fs.writeFileSync(LOG, JSON.stringify(log, null, 1));
console.log(`changed ${log.changed}, kept ${log.kept}, failed ${log.failed} of ${slugs.length}`);
