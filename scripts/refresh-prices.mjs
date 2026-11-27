// Refreshes data/prices.json from the tracker's public market.json (one request for every item).
// Runs in GitHub Actions every three hours. Writes data/refresh-log.json so each run can be checked.
// A price read by hand from Cozy Market (field t) is kept for 18 hours before the tracker may replace it;
// the tracker still supplies the daily history and seller counts for those items.
import fs from "node:fs";

const PRICES = "data/prices.json", CATALOG = "data/catalog.json", LOG = "data/refresh-log.json";
const prices = JSON.parse(fs.readFileSync(PRICES, "utf8"));
const catalog = JSON.parse(fs.readFileSync(CATALOG, "utf8"));
const now = new Date(), HOLD_MS = 18 * 3600e3;
const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
const slugify = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const log = { ranAt: now.toISOString(), ok: false };

// history dates may be ISO strings, YYMMDD/YYYYMMDD strings, or epoch seconds/milliseconds
function tag(d) {
  if (typeof d === "number") { const t = new Date(d > 1e11 ? d : d * 1000); return isNaN(t) ? null : String(t.getUTCFullYear()).slice(2) + String(t.getUTCMonth() + 1).padStart(2, "0") + String(t.getUTCDate()).padStart(2, "0"); }
  const s = String(d), m = /^(\d{4})-(\d\d)-(\d\d)/.exec(s) || /^(\d{4})(\d\d)(\d\d)$/.exec(s);
  if (m) return m[1].slice(2) + m[2] + m[3];
  return /^\d{6}$/.test(s) ? s : null;
}

try {
  const res = await fetch("https://maplestory-classic.com/market.json", { headers: { "user-agent": "kerningstreetbets price refresh (+https://github.com/nathanshiaulam/kerningstreetbets)" } });
  log.status = res.status;
  if (!res.ok) throw new Error("HTTP " + res.status);
  const data = await res.json();
  const items = Array.isArray(data.items) ? data.items : [];
  log.updatedAt = data.updatedAt; log.total = items.length;
  log.categories = {}; for (const it of items) log.categories[it.k] = (log.categories[it.k] || 0) + 1;
  log.sample = items.filter((it) => /tania cloak|angel halo/i.test(it.n)).slice(0, 2).map((it) => Object.assign({}, it, { h: (it.h || []).slice(-3) }));
  const byName = new Map(), bySlug = new Map();
  for (const it of items) { byName.set(norm(it.n), it); bySlug.set(it.s, it); }

  // cash items the tracker knows that the catalog does not: add them without a crate so they get a price
  const known = new Set(Object.values(catalog.items).map((c) => norm(c.n)));
  log.added = 0;
  for (const it of items) {
    if (!/cash|cosmetic/i.test(String(it.k)) || known.has(norm(it.n)) || !it.n) continue;
    const slug = catalog.items[it.s] ? slugify(it.n) + "-2" : it.s || slugify(it.n);
    if (catalog.items[slug]) continue;
    catalog.items[slug] = { n: it.n }; known.add(norm(it.n)); log.added++;
  }

  log.matched = 0; log.changed = 0; log.kept = 0; log.unmatched = [];
  for (const [slug, c] of Object.entries(catalog.items)) {
    const it = bySlug.get(slug) || byName.get(norm(c.n));
    if (!it || !(it.p > 0)) { if (log.unmatched.length < 60) log.unmatched.push(c.n); continue; }
    log.matched++;
    const e = prices.items[slug] || (prices.items[slug] = {});
    if (e.p && (it.p > e.p * 20 || it.p < e.p / 20)) { log.implausible = (log.implausible || []).concat([[c.n, e.p, it.p]]).slice(0, 20); continue; }
    if (it.sellers != null) e.s = it.sellers;
    // What it actually sells for, from the tracker's record of sales. Kept even while a Cozy price is held:
    // the middle half of sale prices, the sale median, the share of listings that sold, and sales a day.
    if (it.p25 > 0 && it.p75 > 0) e.q = [Math.round(it.p25), Math.round(it.p75)];
    e.sp = Math.round(it.p);
    if (it.st != null) e.st = it.st;
    const days = (it.h || []).filter((r) => Array.isArray(r) && r[2] > 0).slice(0, -1).slice(-7);   // the newest day is still filling in
    if (days.length) e.v = Math.round((days.reduce((a, r) => a + r[2], 0) / days.length) * 10) / 10;
    const held = e.t && now - new Date(e.t) < HOLD_MS, heldTag = held ? tag(e.t) : null;
    const pts = new Map((e.h || "").split(" ").filter(Boolean).map((x) => x.split(":")));
    for (const row of it.h || []) {
      const d = tag(Array.isArray(row) ? row[0] : row && row.d), v = Array.isArray(row) ? row[1] : row && row.p;
      if (!d || !(v > 0)) continue;
      if (held && d >= heldTag && pts.has(d)) continue;      // keep the Cozy reading for its own day
      pts.set(d, String(Math.round(v)));
    }
    e.h = [...pts.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).slice(-45).map((x) => x.join(":")).join(" ");
    if (held) { log.kept++; continue; }
    delete e.t;
    if (e.p !== it.p) { e.p = it.p; log.changed++; }
  }
  if (log.changed || log.added) prices.asOf = now.toISOString();
  prices.tracker = { updatedAt: data.updatedAt, ranAt: now.toISOString() };
  fs.writeFileSync(PRICES, JSON.stringify(prices));
  fs.writeFileSync(CATALOG, JSON.stringify(catalog));
  log.ok = true;
} catch (err) { log.error = String(err).slice(0, 300); }
fs.writeFileSync(LOG, JSON.stringify(log, null, 1));
console.log(JSON.stringify(Object.assign({}, log, { sample: undefined, unmatched: (log.unmatched || []).length })));
if (!log.ok) process.exit(1);
