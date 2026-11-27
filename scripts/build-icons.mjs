// Builds data/icons.json: a small colour signature for every cash item's icon, so the scanner can name
// items it has never seen hovered. Runs in GitHub Actions. Only signatures are stored (half-resolution
// colour averages), not the images. Items already in the file are skipped, so later runs are cheap.
import fs from "node:fs";
import sharp from "sharp";

const CATALOG = "data/catalog.json", OUT = "data/icons.json", LOG = "data/icons-log.json";
const catalog = JSON.parse(fs.readFileSync(CATALOG, "utf8"));
const icons = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, "utf8")) : { v: 1, items: {} };
const UA = { "user-agent": "kerningstreetbets icon signatures (+https://github.com/nathanshiaulam/kerningstreetbets)" };
const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = { ranAt: new Date().toISOString(), added: 0, skipped: 0, failed: [], sizes: {}, samples: [] };

// Signature: the image cut into 2 x 2 pixel cells, each stored as its average colour times opacity, plus opacity.
export async function signature(buf) {
  const meta = await sharp(buf).metadata();
  let w = meta.width, h = meta.height, k = 1;
  if (Math.max(w, h) > 48) k = Math.max(1, Math.round(Math.max(w, h) / 32));     // an enlarged render: bring it back to game pixels
  const tw = Math.max(1, Math.round(w / k)), th = Math.max(1, Math.round(h / k));
  const raw = await sharp(buf).ensureAlpha().resize(tw, th, { kernel: k > 1 ? "nearest" : "lanczos3", fit: "fill" }).raw().toBuffer();
  const cw = Math.ceil(tw / 2), ch = Math.ceil(th / 2), cells = Buffer.alloc(cw * ch * 4);
  let x1 = tw, y1 = th, x2 = -1, y2 = -1;
  for (let cy = 0; cy < ch; cy++) for (let cx = 0; cx < cw; cx++) {
    let r = 0, g = 0, b = 0, a = 0;
    for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
      const x = cx * 2 + dx, y = cy * 2 + dy; if (x >= tw || y >= th) continue;
      const q = (y * tw + x) * 4, al = raw[q + 3] / 255;
      r += raw[q] * al; g += raw[q + 1] * al; b += raw[q + 2] * al; a += al;
      if (raw[q + 3] > 16) { if (x < x1) x1 = x; if (x > x2) x2 = x; if (y < y1) y1 = y; if (y > y2) y2 = y; }
    }
    const o = (cy * cw + cx) * 4; cells[o] = Math.round(r / 4); cells[o + 1] = Math.round(g / 4); cells[o + 2] = Math.round(b / 4); cells[o + 3] = Math.round(a / 4 * 255);
  }
  return { w: tw, h: th, k, box: [x1, y1, x2, y2], src: [w, h, meta.format, !!meta.hasAlpha], d: cells.toString("base64") };
}

if (process.argv[1] && process.argv[1].endsWith("build-icons.mjs")) {
  try {
    const market = await (await fetch("https://maplestory-classic.com/market.json", { headers: UA })).json();
    const byName = new Map(), bySlug = new Map();
    for (const it of market.items || []) { byName.set(norm(it.n), it); bySlug.set(it.s, it); }
    for (const [slug, c] of Object.entries(catalog.items)) {
      if (icons.items[slug]) { log.skipped++; continue; }
      const it = bySlug.get(slug) || byName.get(norm(c.n)), ts = it ? it.s : slug;
      try {
        // the image file name usually equals the slug; names with apostrophes are written a few different ways
        const plain = (x) => String(x).toLowerCase().replace(/['’"]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
        let res = null;
        for (const cand of [...new Set([ts, slug, plain(c.n), plain(it ? it.n : c.n)])]) { res = await fetch("https://maplestory-classic.com/img/items/" + cand + ".webp", { headers: UA }); if (res.ok) break; await sleep(120); }
        if (!res || !res.ok) { log.failed.push([slug, res ? res.status : 0]); continue; }
        const sig = await signature(Buffer.from(await res.arrayBuffer()));
        const key = sig.src.slice(0, 2).join("x") + (sig.k > 1 ? " /" + sig.k : ""); log.sizes[key] = (log.sizes[key] || 0) + 1;
        if (log.samples.length < 6 || /tania-cloak|bunny-hat|lucia-hat|pumpkin-headgear|dragonfly-wings/.test(slug)) log.samples.push([slug, sig.w, sig.h, sig.k, sig.box, sig.src]);
        icons.items[slug] = { w: sig.w, h: sig.h, d: sig.d };
        log.added++;
      } catch (e) { log.failed.push([slug, String(e).slice(0, 80)]); }
      await sleep(120);
    }
    fs.writeFileSync(OUT, JSON.stringify(icons));
    log.ok = true; log.total = Object.keys(icons.items).length;
  } catch (e) { log.error = String(e).slice(0, 300); }
  fs.writeFileSync(LOG, JSON.stringify(log, null, 1));
  console.log(JSON.stringify(Object.assign({}, log, { samples: undefined, failed: log.failed.length })));
}
