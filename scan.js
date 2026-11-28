/* Kerning Street Bets: inventory scanner, page side.
   Watches a shared MapleStory window (or a set of screenshots). Frames with no tooltip build a map of the
   inventory; frames with a tooltip give the hovered item's name. Names are tied to icons, and quantities are
   counted from the map, so hovering the same item twice, or its second copy, changes nothing.
   Everything runs in this tab. No picture leaves the browser. */
(function () {
  "use strict";
  const S = window.KSBScan;
  const st = { on: false, stream: null, track: null, video: null, timer: null, s: null, grid: null, sawOpenGrid: false, map: new S.InvMap(), named: [], manual: [], book: [], sigs: null, sigsLoading: null, dbCache: [], pending: 0, hover: null, lastRows: null, busy: false, ocr: null, ocrLoading: null, dirty: true, undo: null, ac: null, lastTick: 0, lastTips: [], frame: null, res: null, armed: 0 };
  const TIP_SAME = 14;   // two tooltip icons this close are the same item
  const here = (p) => new URL(p, document.baseURI).href;
  const fc = document.createElement("canvas"), fx = fc.getContext("2d", { willReadFrequently: true });

  /* ---------- small helpers ---------- */
  const say = (t) => { const n = $("#scanStatus"); if (n.textContent !== t) n.textContent = t; };
  function beep(kind) {
    if (!$("#scanSound").checked || !st.ac) return;
    const plan = { fresh: [[660, 0, 0.09], [990, 0.1, 0.14]], again: [[300, 0, 0.14]], row: [[1200, 0, 0.03]], bad: [[180, 0, 0.22]], hide: [[520, 0, 0.07], [520, 0.13, 0.07]] }[kind] || [];
    for (const [f, at, len] of plan) {
      const o = st.ac.createOscillator(), g = st.ac.createGain(), t = st.ac.currentTime + at;
      o.type = kind === "bad" ? "sawtooth" : "sine"; o.frequency.value = f;
      g.gain.setValueAtTime(kind === "row" ? 0.04 : 0.14, t); g.gain.exponentialRampToValueAtTime(0.001, t + len);
      o.connect(g).connect(st.ac.destination); o.start(t); o.stop(t + len + 0.02);
    }
  }
  function speak(t) { if ($("#scanSpeak").checked && window.speechSynthesis) { try { speechSynthesis.cancel(); speechSynthesis.speak(new SpeechSynthesisUtterance(t)); } catch (e) {} } }
  function loadScript(src) { return new Promise((ok, bad) => { const s = document.createElement("script"); s.src = src; s.onload = ok; s.onerror = () => bad(new Error("load " + src)); document.head.append(s); }); }
  function reader() {
    if (!st.ocrLoading) st.ocrLoading = (async () => {
      if (!window.Tesseract) await loadScript(here("vendor/tesseract/tesseract.min.js"));
      const w = await Tesseract.createWorker("eng", 1, { workerPath: here("vendor/tesseract/worker.min.js"), corePath: here("vendor/tesseract/"), langPath: here("vendor/tesseract/lang"), gzip: true });
      await w.setParameters({ tessedit_pageseg_mode: "7" });
      st.ocr = w; return w;
    })();
    return st.ocrLoading;
  }
  function toCanvas(im) { const c = document.createElement("canvas"); c.width = im.width; c.height = im.height; c.getContext("2d").putImageData(new ImageData(new Uint8ClampedArray(im.data), im.width, im.height), 0, 0); return c; }
  function thumbUrl(thumb) {
    if (!thumb) return ""; if (thumb.url) return thumb.url;
    const d = new Uint8ClampedArray(32 * 32 * 4);
    for (let i = 0; i < 32 * 32; i++) { d[i * 4] = thumb[i * 3]; d[i * 4 + 1] = thumb[i * 3 + 1]; d[i * 4 + 2] = thumb[i * 3 + 2]; d[i * 4 + 3] = 255; }
    thumb.url = toCanvas({ data: d, width: 32, height: 32 }).toDataURL("image/png");
    return thumb.url;
  }
  const knownNames = () => { const set = new Set(Object.values(catalog).map((c) => c.n)); pf.holdings.forEach((h) => { if (h.ok !== false && h.slug) set.add(h.name); }); st.named.forEach((n) => set.add(n.name)); return [...set]; };

  // Names carry over between scans: every named row in the portfolio keeps its icon, and that icon
  // names the same item next time without a hover.
  async function loadBook() {
    const out = [], c = document.createElement("canvas"); c.width = c.height = 32; const x = c.getContext("2d", { willReadFrequently: true });
    for (const h of pf.holdings) {
      if (!h.icon || h.ok === false) continue;
      try { const im = new Image(); im.src = h.icon; await im.decode(); x.clearRect(0, 0, 32, 32); x.drawImage(im, 0, 0, 32, 32); out.push({ fp: S.thumbFp(x.getImageData(0, 0, 32, 32).data), name: h.name }); } catch (e) {}
    }
    st.book = out; st.dirty = true;
  }

  // The icon dictionary: a signature of every cash item's icon, so most items are named without a hover.
  function loadIcons() {
    if (!st.sigsLoading) st.sigsLoading = fetch("data/icons.json").then((r) => (r.ok ? r.json() : null)).then((j) => { st.sigs = j ? S.prepIcons(j, catalog) : []; st.dirty = true; }).catch(() => { st.sigs = []; });
    return st.sigsLoading;
  }
  // Look a slot picture up in the dictionary, remembering the answer. At most `budget` new look-ups per call,
  // because each one compares against every icon; the rest are done on the next pass.
  function dbName(g, budget) {
    if (!st.sigs || !st.sigs.length || !g.thumb) return null;
    for (const e of st.dbCache) if (S.dist(e.fp, g.fp) <= 4) return e.m;
    if (budget.n <= 0) { st.pending++; return null; }
    budget.n--;
    const m = S.matchIcon(g.thumb, st.sigs); st.dbCache.push({ fp: g.fp, m });
    return m;
  }

  /* ---------- one frame ---------- */
  // Place what one picture shows of the inventory. `img` may be a cut-out of the frame whose corner is at
  // (ox, oy). A grid half hidden by a tooltip is still usable: the last fully visible position is used
  // if it has not moved. Runs on every frame while sharing, so a quick scroll is followed row by row.
  function mapStep(img, grid, tips, o, ox, oy) {
    let g = grid;
    if (grid && grid.covered && st.grid && Math.abs(grid.x0 + ox - st.grid.x0) <= 2 && Math.abs(grid.y0 + oy - st.grid.y0) <= 2) g = { x0: st.grid.x0 - ox, y0: st.grid.y0 - oy, s: st.grid.s };
    if (!g) return false;
    const rows = S.readSlots(img, g, tips, !!o.pages, st.wide || (st.sigs && st.sigs.length ? (st.wide = S.wideIcons(st.sigs)) : null));
    const firm = !!o.force || S.sameView(rows, st.lastRows);     // seen twice running: the list has stopped moving
    st.lastRows = rows;
    const ver = st.map.ver, r = st.map.add(rows, !!o.pages, firm);
    if (st.map.ver !== ver) st.dirty = true;                     // any slot that changed, not only new rows, refreshes the list
    if (!r || r.skip) { st.hidNow = []; return true; }
    // Slots in this view that are unreadable right now and have never been read: outlined on the preview.
    { const now = [], seg = st.map.rows;
      for (let i = 0; i < S.ROWS; i++) { const row = seg[r.offset + i]; if (!row || !row.some((x) => x.cur && !x.cur.empty)) continue; for (let c = 0; c < S.COLS; c++) if (rows[i][c].unk && !row[c].cur) now.push([i, c]); }
      st.hidNow = now; }
    // Slots under the pop-up or pointer that have never been seen: once the list has rested a moment, say so,
    // with a sound, since the player is looking at the game and not at this page.
    if (firm && !o.pages) {
      let hid = 0; const seg = st.map.rows, now = performance.now();
      for (let i = 0; i < S.ROWS; i++) {
        const row = seg[r.offset + i]; if (!row || !row.some((x) => x.cur && !x.cur.empty)) continue;   // rows with no item showing are the empty tail
        for (let c = 0; c < S.COLS; c++) if (rows[i][c].unk && !row[c].cur) hid++;
      }
      const key = st.map.at + ":" + r.offset + ":" + hid;
      if (!hid) st.hid = null;
      else if (!st.hid || st.hid.key !== key) st.hid = { key, t: now, told: false };
      else if (!st.hid.told && now - st.hid.t > 600) {
        st.hid.told = true; beep("hide"); speak("Move the pointer off the items");
        say("The pop-up is hiding " + hid + (hid === 1 ? " slot" : " slots") + " here. Slide the pointer off the items for a second.");
      }
    }
    if (r.fresh) { beep("bad"); say("You scrolled faster than I could follow, so there's a gap. Scroll back through the rows you skipped and I'll join them up."); st.dirty = true; return true; }
    if (r.added || r.joined) {
      st.dirty = true;
      const now = performance.now(); if (now - (st.lastBeep || 0) > 150) { st.lastBeep = now; beep("row"); }
    }
    if (r.joined && !st.map.gaps) say("Joined up. " + st.map.filled() + " rows mapped so far. Keep scrolling to the end.");
    else if (!tips.length && !st.map.gaps && !(st.hid && st.hid.told) && (!st.named.length || r.added)) say("Inventory found: " + st.map.filled() + " rows mapped so far. Keep scrolling to the end.");
    return true;
  }
  // The quick path, for the frames between full looks: only the inventory's corner of the picture is read,
  // and only if it changed, so following a fast scroll costs little.
  const qc = document.createElement("canvas"), qx = qc.getContext("2d", { willReadFrequently: true });
  function fast(source, w, h) {
    const g = st.grid, s = st.s; if (!g || !s) return;
    const x1 = Math.max(0, Math.floor(g.x0 - 10 * s)), y1 = Math.max(0, Math.floor(g.y0 - 50 * s)), x2 = Math.min(w, Math.ceil(g.x0 + 310 * s)), y2 = Math.min(h, Math.ceil(g.y0 + 390 * s));
    const cw = x2 - x1, ch = y2 - y1; if (cw < 215 * s || ch < 265 * s) return;
    if (qc.width !== cw || qc.height !== ch) { qc.width = cw; qc.height = ch; }
    qx.drawImage(source, x1, y1, cw, ch, 0, 0, cw, ch);
    const img = qx.getImageData(0, 0, cw, ch), d = img.data, R = S.gridRect({ x0: g.x0 - x1, y0: g.y0 - y1, s });
    let sum = 0;
    for (let y = Math.max(0, Math.floor(R.y - 4 * s)), ye = Math.min(ch, R.y + R.h + 4 * s); y < ye; y += 3) for (let x = Math.max(0, Math.floor(R.x - 4 * s)), xe = Math.min(cw, R.x + R.w + 4 * s), k = (y * cw + x) * 4; x < xe; x += 3, k += 12) sum = (sum * 31 + d[k] + (d[k + 1] << 8) + (d[k + 2] << 16)) | 0;
    if (sum === st.lastSum) return;                               // nothing over the inventory changed
    st.lastSum = sum;
    const grid = S.findGrid(img);
    if (!grid || Math.abs(grid.x0 + x1 - g.x0) > 2 || Math.abs(grid.y0 + y1 - g.y0) > 2) return;   // the window moved or closed: the next full look sorts it out
    // tooltips move only when the pointer does, so the ones found by the last full look still say what is covered
    mapStep(img, grid, st.lastTips.map((t) => ({ left: t.left - x1, top: t.top - y1 })), {}, x1, y1);
  }
  async function onFrame(img, o) {
    const grid = S.findGrid(img);
    if (grid && !grid.covered) { st.grid = grid; st.s = grid.s; st.sawOpenGrid = true; }
    else if (grid && !st.sawOpenGrid) st.s = grid.s;
    st.lastTips = [];
    if (!st.s) { say("Looking for your item inventory. Open it on the Deco tab."); return; }
    const tips = S.findTips(img, st.s);
    st.lastTips = tips;
    // Map first: every slot that is not under a tooltip or the pointer adds to the picture of the inventory.
    if (!mapStep(img, grid, tips, o, 0, 0) && !tips.length && !st.map.rows.length) say("Looking for your item inventory. Open it on the Deco tab.");
    if (!tips.length) { st.hover = null; return; }

    const tip = tips[0];                         // the left-most tooltip is the hovered item; any other is what you have equipped
    const crop = S.tipCrop(img, tip, st.s), fp = S.tipFp(crop, 0, 0).fp;
    const h = st.hover, same = h && Math.abs(h.x - tip.box.x) <= 3 && Math.abs(h.y - tip.box.y) <= 3 && S.dist(h.fp, fp) < 5;
    if (same) h.n++; else st.hover = { x: tip.box.x, y: tip.box.y, fp, n: 1, done: false };
    const cur = st.hover;
    if (cur.done || (!o.force && cur.n < 2)) return;   // wait for two matching frames so a half-drawn tooltip is never read
    cur.done = true;
    const badge = S.tipFp(crop, 0, 0).badge || "other";
    const known = st.named.find((n) => S.tipDist(n.crop, crop) < TIP_SAME);
    if (known) { known.untr[badge] = tip.untradable; beep("again"); say("Already have " + known.name + ". Nothing changed."); st.dirty = true; return; }
    let name = "";
    try {
      const w = await reader(); let text = "", conf = 100;
      for (const r of tip.names) { const x = await w.recognize(toCanvas(S.nameImage(img, r, Math.max(3, Math.round(6 / st.s))))); text += " " + x.data.text.trim(); conf = Math.min(conf, x.data.confidence); }   // a long name wraps onto more lines
      if (conf >= 55) name = S.snapName(S.cleanName(text), knownNames());
    } catch (e) { say("The text reader didn't load. Check your connection and reload the page."); cur.done = false; return; }
    if (name.length < 2) { beep("bad"); say("Couldn't read that name. Move off the item and hover it again."); cur.done = false; cur.n = 0; return; }
    st.named.push({ name, crop, untr: { [badge]: tip.untradable } });
    beep("fresh"); speak(name); say("Read " + name + (tip.untradable ? " (worn, can't be sold)." : "."));
    st.dirty = true;
  }

  /* ---------- results ---------- */
  function results(opts) {
    const groups = st.map.groups();
    const rows = groups.map((g) => ({ g, name: null, slug: null, hint: null, d: Infinity, src: null, redUntradable: false }));
    const budget = { n: opts && opts.all ? 1e9 : 3 }; st.pending = 0;
    for (const r of rows) { const m = r.g.red ? dbName(r.g, budget) : null; if (m && m.sure) { r.name = m.name; r.slug = m.slug; r.src = "dictionary"; } else if (m && m.twin) r.hint = m.name + " or " + m.twin; }
    for (const r of rows) { let best = null; for (const bk of st.book) { const d = S.dist(bk.fp, r.g.fp); if (d <= S.SAME && (!best || d < best.d)) best = { d, bk }; } if (best) { r.name = best.bk.name; r.slug = null; r.src = "book"; } }
    const loose = [];
    for (const n of st.named) {
      if (groups.length && (!n.m || n.mv !== st.map.ver)) { n.m = S.matchTip(n.crop, groups); n.mv = st.map.ver; }   // matching is slow: redo only when the map changes
      const m = groups.length ? n.m : null;
      if (!m || !m.clear) { loose.push(n); continue; }
      const r = rows[m.i];
      if (m.d < r.d) { r.name = n.name; r.slug = null; r.d = m.d; r.src = "hover"; r.redUntradable = n.untr.red === true; }
    }
    for (const mn of st.manual) { let best = null; rows.forEach((r) => { const d = S.dist(mn.fp, r.g.fp); if (d <= S.SAME && (!best || d < best.d)) best = { r, d }; }); if (best) { best.r.name = mn.name || null; best.r.slug = null; best.r.src = "typed"; } }
    return { rows, loose, red: rows.reduce((a, r) => a + r.g.red, 0), purple: rows.reduce((a, r) => a + r.g.purple, 0) };
  }
  function renderScan() {
    const list = $("#scanList");
    if (list.contains(document.activeElement) && document.activeElement.tagName === "INPUT") return;   // don't redraw under the cursor
    st.dirty = false;
    const res = (st.res = results()), sellRows = res.rows.filter((r) => r.g.red > 0), named = sellRows.filter((r) => r.name).length;
    const blk = st.map.rows.length ? st.map.blocked() : [];
    $("#scanCounts").textContent = st.map.rows.length
      ? st.map.filled() + " rows mapped · " + res.red + " sellable items in " + sellRows.length + " kinds · " + named + " of " + sellRows.length + " named" + (res.purple ? " · " + res.purple + " worn left out" : "") + (st.map.gaps ? " · gap in the scan, so these counts may be off: scroll back through the rows you skipped" : "") + (blk.length ? " · " + blk.length + (blk.length === 1 ? " slot" : " slots") + " not read yet (shown below)" : st.map.gaps ? "" : " · every slot in these rows read") + (st.pending ? " · naming " + st.pending + " more…" : "")
      : st.named.length ? st.named.length + " names read. Scroll through the inventory with no item hovered so the items can be counted." : "";
    const box = $("#scanBlocked");
    box.hidden = !blk.length; box.replaceChildren();
    if (blk.length) {
      box.append(el("div", { class: "scan-blocked-h", text: "Not read yet: " + blk.length + (blk.length === 1 ? " slot" : " slots") }),
        el("div", { class: "scan-blocked-p", text: (blk.length === 1 ? "This slot is" : "These slots are") + " not in the list below. Either something was over " + (blk.length === 1 ? "it" : "them") + " every time " + (blk.length === 1 ? "it" : "they") + " came into view, or " + (blk.length === 1 ? "it" : "they") + " went past too fast to be sure of. The pictures show what the scanner saw. Scroll back over " + (blk.length === 1 ? "it" : "them") + " slowly with the pointer off the items; " + (blk.length === 1 ? "it leaves" : "each one leaves") + " this box once it is read." }));
      const strip = el("div", { class: "scan-blocked-row" });
      for (const b of blk.slice(0, 40)) strip.append(el("figure", { class: "scan-blocked-i" }, b.thumb ? el("img", { class: "ico", src: thumbUrl(b.thumb), alt: "" }) : el("span", { class: "ico none", text: "?" }),
        el("figcaption", { text: (st.map.gaps ? "" : "Row " + (b.row + 1) + ", ") + "slot " + (b.col + 1) })));
      box.append(strip);
      if (blk.length > 40) box.append(el("div", { class: "scan-blocked-p", text: "And " + (blk.length - 40) + " more." }));
    }
    list.replaceChildren();
    const order = sellRows.slice().sort((a, b) => (a.name ? 1 : 0) - (b.name ? 1 : 0) || a.g.slots[0][0] - b.g.slots[0][0] || a.g.slots[0][1] - b.g.slots[0][1]);
    for (const r of order) {
      const input = el("input", { class: "in", value: r.name || "", placeholder: r.hint ? r.hint + ": these look the same, hover it to settle" : res.loose.length ? "Not named yet: pick one of the names read below, or hover it again" : "Not named yet: hover it in game, or type its name", "aria-label": "Item name", list: "scanLoose" });
      input.addEventListener("change", () => { const v = input.value.trim(); input.blur(); const m = st.manual.find((x) => S.dist(x.fp, r.g.fp) <= S.SAME); if (m) m.name = v; else st.manual.push({ fp: r.g.fp, name: v }); st.dirty = true; renderScan(); });
      list.append(el("div", { class: "scan-item" + (r.name ? "" : " todo") }, el("img", { class: "ico", src: thumbUrl(r.g.thumb), alt: "" }), input,
        el("span", { class: "q", text: "×" + r.g.red }), el("span", { class: "sub", text: (r.src === "dictionary" ? "auto " : "") + (r.redUntradable ? "reads as untradable" : "") + (r.g.purple ? (r.redUntradable ? " · " : "") + "+" + r.g.purple + " worn" : "") })));
    }
    const dl = $("#scanLoose"); dl.replaceChildren(); for (const n of res.loose) dl.append(el("option", { value: n.name }));
    if (res.loose.length) list.append(el("div", { class: "scan-note", text: "Names read, but I couldn't tell which inventory icon each belongs to: " + res.loose.map((n) => n.name).join(", ") + ". If some rows were never shown with nothing hovered, scroll through them now. Otherwise click an unnamed row above and pick its name from the list." }));
    if (!order.length && !res.loose.length) list.append(el("div", { class: "scan-note", text: "Nothing scanned yet." }));
    const b = $("#scanApply"); b.disabled = !sellRows.length; b.textContent = "Sync portfolio to this scan"; st.armed = 0;
    if (st.pending && !st.pendTimer) st.pendTimer = setTimeout(() => { st.pendTimer = 0; renderScan(); }, 40);   // more dictionary look-ups to do
  }
  function applyScan() {
    const res = results({ all: true }), out = [], by = new Map();
    for (const r of res.rows) {
      if (!r.g.red || r.redUntradable) continue;
      const icon = thumbUrl(r.g.thumb);
      if (!r.name) { out.push({ id: uid(), slug: null, name: "Unnamed item", qty: r.g.red, ok: false, icon }); continue; }
      const hit = r.slug && catalog[r.slug] ? r.slug : Object.keys(catalog).find((s) => catalog[s].n.toLowerCase() === r.name.toLowerCase()), slug = hit || slugify(r.name);
      if (by.has(slug)) { by.get(slug).qty += r.g.red; continue; }
      const old = pf.holdings.find((h) => h.slug === slug), row = { id: old ? old.id : uid(), slug, name: hit ? catalog[hit].n : r.name, qty: r.g.red, ok: true, icon };
      by.set(slug, row); out.push(row);
    }
    st.undo = clone(pf.holdings);
    pf.holdings = out; sel = null; changed();
    const unnamed = out.filter((h) => h.ok === false).length, units = out.reduce((a, h) => a + h.qty, 0);
    $("#scanMsg").textContent = "Portfolio now matches the scan: " + units + " sellable items in " + out.length + " rows." + (res.purple ? " " + res.purple + " worn items left out." : "") + (unnamed ? " " + unnamed + " rows have no name yet; hover them and sync again." : "");
    $("#scanUndo").hidden = false;
    loadBook();
  }

  /* ---------- preview ---------- */
  function drawPreview() {
    const cv = $("#scanPreview"), f = st.frame; if (!f) return;
    const s = st.s || 1; let x1 = 0, y1 = 0, x2 = f.width, y2 = f.height;
    if (st.grid) {
      x1 = st.grid.x0 - 8 * s; y1 = st.grid.y0 - 46 * s; x2 = st.grid.x0 + 211 * s; y2 = st.grid.y0 + 240 * s;
      for (const t of st.lastTips.slice(0, 1)) { x1 = Math.min(x1, t.left - 2 * s); y1 = Math.min(y1, t.top - 4 * s); x2 = Math.max(x2, t.left + 240 * s); y2 = Math.max(y2, t.box.y + t.box.h + 8 * s); }
      x1 = Math.max(0, x1); y1 = Math.max(0, y1); x2 = Math.min(f.width, x2); y2 = Math.min(f.height, y2);
    }
    const w = x2 - x1, h = y2 - y1, k = Math.min(520 / w, 420 / h, 1), dpr = Math.min(2, window.devicePixelRatio || 1);
    cv.width = Math.round(w * k * dpr); cv.height = Math.round(h * k * dpr); cv.style.width = Math.round(w * k) + "px"; cv.style.height = Math.round(h * k) + "px";
    const c = cv.getContext("2d"), z = k * dpr; c.imageSmoothingEnabled = true;
    // Dimmed on purpose: if this page is inside the shared picture, the scanner must not read its own preview.
    c.globalAlpha = 1; c.fillStyle = "#3a3a3a"; c.fillRect(0, 0, cv.width, cv.height);
    c.globalAlpha = 0.5; c.drawImage(fc, x1, y1, w, h, 0, 0, cv.width, cv.height); c.globalAlpha = 1;
    c.lineWidth = 2 * dpr;
    if (st.grid && st.hidNow && st.hidNow.length) {
      c.strokeStyle = "#ffb000"; c.setLineDash([4 * dpr, 3 * dpr]);
      for (const [i, col] of st.hidNow) { const q = S.slotRect(st.grid, i, col); c.strokeRect((q.x - 1.5 * s - x1) * z, (q.y - 1.5 * s - y1) * z, (q.w + 3 * s) * z, (q.h + 3 * s) * z); }
      c.setLineDash([]);
    }
    st.lastTips.forEach((t, i) => { c.strokeStyle = i === 0 ? "#2fae68" : "rgba(160,160,160,.5)"; for (const r of t.names) c.strokeRect((r.x - x1) * z, (r.y - y1) * z, r.w * z, r.h * z); if (i === 0) c.strokeRect((t.box.x - x1) * z, (t.box.y - y1) * z, t.box.w * z, t.box.h * z); });
  }

  /* ---------- frame sources ---------- */
  async function handle(source, w, h, o) {
    if (fc.width !== w || fc.height !== h) { fc.width = w; fc.height = h; }
    fx.drawImage(source, 0, 0, w, h);
    const img = fx.getImageData(0, 0, w, h);
    st.frame = { width: w, height: h };
    await onFrame(img, o || {});
    drawPreview();
    if (st.dirty) { st.lastChange = Date.now(); renderScan(); }
    // Safety: a share left running does heavy work for nothing. Stop after ten minutes with nothing new.
    if (st.on && Date.now() - (st.lastChange || 0) > 10 * 60 * 1000) { stop(); say("Sharing stopped after 10 minutes with nothing new. Click Share MapleStory window to carry on."); }
  }
  async function start() {
    if (st.on) return;
    openPanel();
    if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) { say("This browser can't share a screen (phones and tablets can't). Open this page in Chrome or Edge on a computer, or use screenshots."); return; }
    let stream;
    try { stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 30, max: 30 } }, audio: false }); }
    catch (e) { say(e && e.name === "NotAllowedError" ? "Sharing was cancelled or blocked. Click Share MapleStory window to try again." : "The browser couldn't start sharing (" + (e && e.name || "error") + "). Try again, or use screenshots."); return; }
    try { st.ac = st.ac || new (window.AudioContext || window.webkitAudioContext)(); } catch (e) {}
    st.on = true; st.lastChange = Date.now(); st.stream = stream; st.track = stream.getVideoTracks()[0];
    st.track.addEventListener("ended", stop);
    openPanel(); say("Sharing started. Looking for your item inventory…");
    reader().catch(() => {});                      // warm up the text reader
    if (window.MediaStreamTrackProcessor) {        // keeps running while the game is in front of the browser
      const rd = new MediaStreamTrackProcessor({ track: st.track }).readable.getReader();
      (async () => {
        while (st.on) {
          let r; try { r = await rd.read(); } catch (e) { break; }
          if (r.done) break;
          const f = r.value, now = performance.now(), w = f.displayWidth, h = f.displayHeight;
          if (!st.busy && now - st.lastTick >= 160) {             // a full look: find the inventory, read tooltips
            st.lastTick = now; st.busy = true;
            handle(f, w, h).catch((e) => console.error(e)).finally(() => { f.close(); st.busy = false; });
            continue;
          }
          try { if (now - (st.lastFast || 0) >= 20) { st.lastFast = now; fast(f, w, h); if (st.dirty && !st.busy) renderScan(); } } catch (e) { console.error(e); }
          f.close();
        }
        try { rd.cancel(); } catch (e) {}
      })();
    } else {
      const v = (st.video = document.createElement("video")); v.muted = true; v.srcObject = stream; await v.play();
      const tick = new Worker(URL.createObjectURL(new Blob(["setInterval(()=>postMessage(0),33)"], { type: "text/javascript" })));
      st.timer = tick;
      tick.onmessage = () => {
        if (!st.on || !v.videoWidth) return;
        const now = performance.now();
        if (!st.busy && now - st.lastTick >= 160) { st.lastTick = now; st.busy = true; handle(v, v.videoWidth, v.videoHeight).catch((e) => console.error(e)).finally(() => { st.busy = false; }); }
        else try { fast(v, v.videoWidth, v.videoHeight); if (st.dirty && !st.busy) renderScan(); } catch (e) { console.error(e); }
      };
    }
    setButtons();
  }
  function stop() {
    if (!st.on) return;
    st.on = false;
    try { st.stream.getTracks().forEach((t) => t.stop()); } catch (e) {}
    if (st.timer) { st.timer.terminate(); st.timer = null; }
    if (st.video) { st.video.srcObject = null; st.video = null; }
    say("Sharing stopped. Review the list, then sync.");
    setButtons(); renderScan();
  }
  function reset() {
    st.map = new S.InvMap(); st.named = []; st.manual = []; st.dbCache = []; st.hover = null; st.lastRows = null; st.lastSum = null; st.grid = null; st.hidNow = []; st.sawOpenGrid = false; st.dirty = true;
    $("#scanMsg").textContent = ""; say(st.on ? "Scan cleared. Looking for your item inventory…" : "Scan cleared."); renderScan();
  }
  async function fromFiles(files) {
    const list = [...files].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    if (!list.length) return;
    openPanel(); st.busy = true;
    let n = 0;
    try {
      for (const f of list) {
        say("Reading screenshot " + (++n) + " of " + list.length + "…");
        const bm = await createImageBitmap(f);
        await handle(bm, bm.width, bm.height, { force: true, pages: true });
        bm.close && bm.close();
      }
      say("Read " + list.length + " screenshots. Review the list, then sync.");
    } catch (e) { console.error(e); say("One of those files couldn't be read as a picture."); }
    st.busy = false; renderScan();
  }
  function openPanel() { const p = $("#scanPanel"); if (p.hidden) { p.hidden = false; p.scrollIntoView({ behavior: "smooth", block: "start" }); } setButtons(); renderScan(); loadBook().then(renderScan); loadIcons().then(renderScan); }
  function setButtons() {
    $("#scanStop").hidden = !st.on; $("#scanAgain").hidden = st.on;
    for (const id of ["#scanBtn", "#scanTop"]) { const b = $(id); b.disabled = st.on; b.textContent = st.on ? "Sharing…" : id === "#scanTop" ? "Scan inventory" : "Share MapleStory window"; }
    if (!st.on && !$("#scanStatus").textContent) say("Click Share MapleStory window to begin, or use screenshots.");
  }

  /* ---------- wiring ---------- */
  $("#scanBtn").addEventListener("click", start);
  $("#scanAgain").addEventListener("click", start);
  $("#scanTop").addEventListener("click", start);
  $("#scanStop").addEventListener("click", stop);
  $("#scanReset").addEventListener("click", reset);
  $("#scanFiles").addEventListener("change", (e) => { const f = e.target.files; fromFiles(f).finally(() => { e.target.value = ""; }); });
  $("#scanApply").addEventListener("click", () => {
    const b = $("#scanApply");
    if (Date.now() - st.armed > 5000) { st.armed = Date.now(); const rs = (st.res || results()).rows.filter((r) => r.g.red > 0 && !r.redUntradable), un = rs.filter((r) => !r.name).length; b.textContent = (st.map.gaps ? "There's a gap in the scan, so items may be missing or counted twice. " : "") + (st.map.unseen() ? st.map.unseen() + " slots were not read and are left out. " : "") + (un ? un + " kinds have no name yet and will show as Unnamed. " : "") + "Replace " + pf.holdings.length + " portfolio rows with " + rs.length + " scanned? Click again"; setTimeout(() => { if (st.armed && Date.now() - st.armed >= 5000) { b.textContent = "Sync portfolio to this scan"; st.armed = 0; } }, 5100); return; }
    st.armed = 0; b.textContent = "Sync portfolio to this scan"; applyScan();
  });
  $("#scanUndo").addEventListener("click", () => { if (!st.undo) return; pf.holdings = st.undo; st.undo = null; sel = null; changed(); $("#scanUndo").hidden = true; $("#scanMsg").textContent = "Put your portfolio back the way it was before the sync."; });
  $("#scanCopy").addEventListener("click", async () => {
    const res = st.res || results(), f1 = (x) => (x == null || !isFinite(x) ? null : +x.toFixed(1));
    const text = JSON.stringify({ scale: f1(st.s * 100) / 100, frame: st.frame, grid: st.grid && [Math.round(st.grid.x0), Math.round(st.grid.y0)], rows: st.map.rows.length, stretches: st.map.segs.map((g) => g.rows.length), blocked: st.map.blocked().map((b) => [b.seg, b.row, b.col]), filled: st.map.filled(), kinds: res.rows.length, named: st.named.length,
      unmatched: res.loose.map((n) => ({ name: n.name, d: n.m && f1(n.m.d), second: n.m && f1(n.m.second), shift: n.m && [n.m.dx, n.m.dy], nearest: n.m && res.rows[n.m.i] ? res.rows[n.m.i].g.slots[0] : null })) });
    try { await navigator.clipboard.writeText(text); $("#scanMsg").textContent = "Copied the scan details. Paste them into your Claude chat."; } catch (e) { $("#scanMsg").textContent = text; }
  });
  window.KSBScanUI = { st, onFrame, results, applyScan, loadBook };
})();
