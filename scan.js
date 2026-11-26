/* Kerning Street Bets: inventory scanner, page side.
   Watches a shared MapleStory window (or a set of screenshots). Frames with no tooltip build a map of the
   inventory; frames with a tooltip give the hovered item's name. Names are tied to icons, and quantities are
   counted from the map, so hovering the same item twice, or its second copy, changes nothing.
   Everything runs in this tab. No picture leaves the browser. */
(function () {
  "use strict";
  const S = window.KSBScan;
  const st = { on: false, stream: null, track: null, video: null, timer: null, s: null, grid: null, sawOpenGrid: false, map: new S.InvMap(), named: [], manual: [], book: [], hover: null, lastRows: null, busy: false, ocr: null, ocrLoading: null, dirty: true, undo: null, ac: null, lastTick: 0, lastTips: [], frame: null, res: null, armed: 0 };
  const TIP_SAME = 14;   // two tooltip icons this close are the same item
  const here = (p) => new URL(p, document.baseURI).href;
  const fc = document.createElement("canvas"), fx = fc.getContext("2d", { willReadFrequently: true });

  /* ---------- small helpers ---------- */
  const say = (t) => { const n = $("#scanStatus"); if (n.textContent !== t) n.textContent = t; };
  function beep(kind) {
    if (!$("#scanSound").checked || !st.ac) return;
    const plan = { fresh: [[660, 0, 0.09], [990, 0.1, 0.14]], again: [[300, 0, 0.14]], row: [[1200, 0, 0.03]], bad: [[180, 0, 0.22]] }[kind] || [];
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

  /* ---------- one frame ---------- */
  async function onFrame(img, o) {
    const grid = S.findGrid(img);
    if (grid && !grid.covered) { st.grid = grid; st.s = grid.s; st.sawOpenGrid = true; }
    else if (grid && !st.sawOpenGrid) st.s = grid.s;
    st.lastTips = [];
    if (!st.s) { say("Looking for your item inventory. Open it on the Deco tab."); return; }
    const tips = S.findTips(img, st.s);
    st.lastTips = tips;
    if (tips.length) {
      const tip = tips[0];                       // the left-most tooltip is the hovered item; any other is what you have equipped
      if (tip.cut) { say("That tooltip runs off the edge of the shared picture. Move the inventory window up or left a little."); return; }
      const crop = S.tipCrop(img, tip, st.s), fp = S.tipFp(crop, 0, 0).fp;
      const h = st.hover, same = h && Math.abs(h.x - tip.dot.x) <= 3 && Math.abs(h.y - tip.dot.y) <= 3 && S.dist(h.fp, fp) < 5;
      if (same) h.n++; else st.hover = { x: tip.dot.x, y: tip.dot.y, fp, n: 1, done: false };
      const cur = st.hover;
      if (cur.done || (!o.force && cur.n < 2)) return;   // wait for two matching frames so a half-drawn tooltip is never read
      cur.done = true;
      const badge = S.tipFp(crop, 0, 0).badge || "other";
      const known = st.named.find((n) => S.tipDist(n.crop, crop) < TIP_SAME);
      if (known) { known.untr[badge] = tip.untradable; beep("again"); say("Already have " + known.name + ". Nothing changed."); st.dirty = true; return; }
      let name = "";
      try {
        const w = await reader(), r = await w.recognize(toCanvas(S.nameImage(img, tip, 3)));
        if (r.data.confidence >= 55) name = S.snapName(S.cleanName(r.data.text), knownNames());
      } catch (e) { say("The text reader didn't load. Check your connection and reload the page."); cur.done = false; return; }
      if (name.length < 2) { beep("bad"); say("Couldn't read that name. Move off the item and hover it again."); cur.done = false; cur.n = 0; return; }
      st.named.push({ name, crop, untr: { [badge]: tip.untradable } });
      beep("fresh"); speak(name); say("Read " + name + (tip.untradable ? " (worn, can't be sold)." : "."));
      st.dirty = true;
      return;
    }
    st.hover = null;
    if (!grid || grid.covered) { if (!st.map.rows.length) say("Looking for your item inventory. Open it on the Deco tab."); return; }
    const rows = S.readSlots(img, grid);
    if (!o.force && !S.sameView(rows, st.lastRows)) { st.lastRows = rows; return; }  // wait until the list has stopped moving
    st.lastRows = rows;
    const wasLost = st.map.lost, r = st.map.add(rows, !!o.pages);
    if (!r) { if (!wasLost) beep("bad"); say("You scrolled further than I could follow. Scroll back toward rows I've seen, one notch at a time."); return; }
    if (r.added) { beep("row"); st.dirty = true; }
    if (!st.named.length || r.added || wasLost) say("Inventory found: " + st.map.filled() + " rows mapped so far. Keep scrolling to the end, then hover each different item once.");
  }

  /* ---------- results ---------- */
  function results() {
    const groups = st.map.groups();
    const rows = groups.map((g) => ({ g, name: null, d: Infinity, src: null, redUntradable: false }));
    for (const r of rows) { let best = null; for (const bk of st.book) { const d = S.dist(bk.fp, r.g.fp); if (d <= S.SAME && (!best || d < best.d)) best = { d, bk }; } if (best) { r.name = best.bk.name; r.src = "book"; } }
    const loose = [];
    for (const n of st.named) {
      const m = groups.length ? S.matchTip(n.crop, groups) : null;
      if (!m || !m.clear) { loose.push(n); continue; }
      const r = rows[m.i];
      if (m.d < r.d) { r.name = n.name; r.d = m.d; r.src = "hover"; r.redUntradable = n.untr.red === true; }
    }
    for (const mn of st.manual) { let best = null; rows.forEach((r) => { const d = S.dist(mn.fp, r.g.fp); if (d <= S.SAME && (!best || d < best.d)) best = { r, d }; }); if (best) best.r.name = mn.name || null; }
    return { rows, loose, red: rows.reduce((a, r) => a + r.g.red, 0), purple: rows.reduce((a, r) => a + r.g.purple, 0) };
  }
  function renderScan() {
    const list = $("#scanList");
    if (list.contains(document.activeElement) && document.activeElement.tagName === "INPUT") return;   // don't redraw under the cursor
    st.dirty = false;
    const res = (st.res = results()), sellRows = res.rows.filter((r) => r.g.red > 0), named = sellRows.filter((r) => r.name).length;
    $("#scanCounts").textContent = st.map.rows.length
      ? st.map.filled() + " rows mapped · " + res.red + " sellable items in " + sellRows.length + " kinds · " + named + " of " + sellRows.length + " named" + (res.purple ? " · " + res.purple + " worn left out" : "")
      : st.named.length ? st.named.length + " names read. Scroll through the inventory with no item hovered so the items can be counted." : "";
    list.replaceChildren();
    const order = sellRows.slice().sort((a, b) => (a.name ? 1 : 0) - (b.name ? 1 : 0) || a.g.slots[0][0] - b.g.slots[0][0] || a.g.slots[0][1] - b.g.slots[0][1]);
    for (const r of order) {
      const input = el("input", { class: "in", value: r.name || "", placeholder: "Not named yet: hover it in game, or type its name", "aria-label": "Item name" });
      input.addEventListener("change", () => { const v = input.value.trim(); input.blur(); const m = st.manual.find((x) => S.dist(x.fp, r.g.fp) <= S.SAME); if (m) m.name = v; else st.manual.push({ fp: r.g.fp, name: v }); st.dirty = true; renderScan(); });
      list.append(el("div", { class: "scan-item" + (r.name ? "" : " todo") }, el("img", { class: "ico", src: thumbUrl(r.g.thumb), alt: "" }), input,
        el("span", { class: "q", text: "×" + r.g.red }), el("span", { class: "sub", text: (r.redUntradable ? "reads as untradable" : "") + (r.g.purple ? (r.redUntradable ? " · " : "") + "+" + r.g.purple + " worn" : "") })));
    }
    if (res.loose.length) list.append(el("div", { class: "scan-note", text: "Read but not yet found in the mapped rows: " + res.loose.map((n) => n.name).join(", ") + ". Scroll through the rest of the inventory with nothing hovered." }));
    if (!order.length && !res.loose.length) list.append(el("div", { class: "scan-note", text: "Nothing scanned yet." }));
    const b = $("#scanApply"); b.disabled = !sellRows.length; b.textContent = "Sync portfolio to this scan"; st.armed = 0;
  }
  function applyScan() {
    const res = results(), out = [], by = new Map();
    for (const r of res.rows) {
      if (!r.g.red || r.redUntradable) continue;
      const icon = thumbUrl(r.g.thumb);
      if (!r.name) { out.push({ id: uid(), slug: null, name: "Unnamed item", qty: r.g.red, ok: false, icon }); continue; }
      const hit = Object.keys(catalog).find((s) => catalog[s].n.toLowerCase() === r.name.toLowerCase()), slug = hit || slugify(r.name);
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
      for (const t of st.lastTips.slice(0, 1)) { x1 = Math.min(x1, t.dot.x - 8 * s); y1 = Math.min(y1, t.name.y - 6 * s); x2 = Math.max(x2, t.box.x + 240 * s); y2 = Math.max(y2, t.box.y + t.box.h + 8 * s); }
      x1 = Math.max(0, x1); y1 = Math.max(0, y1); x2 = Math.min(f.width, x2); y2 = Math.min(f.height, y2);
    }
    const w = x2 - x1, h = y2 - y1, k = Math.min(520 / w, 420 / h, 1), dpr = Math.min(2, window.devicePixelRatio || 1);
    cv.width = Math.round(w * k * dpr); cv.height = Math.round(h * k * dpr); cv.style.width = Math.round(w * k) + "px"; cv.style.height = Math.round(h * k) + "px";
    const c = cv.getContext("2d"), z = k * dpr; c.imageSmoothingEnabled = true;
    // Dimmed on purpose: if this page is inside the shared picture, the scanner must not read its own preview.
    c.globalAlpha = 1; c.fillStyle = "#3a3a3a"; c.fillRect(0, 0, cv.width, cv.height);
    c.globalAlpha = 0.68; c.drawImage(fc, x1, y1, w, h, 0, 0, cv.width, cv.height); c.globalAlpha = 1;
    c.lineWidth = 2 * dpr;
    st.lastTips.forEach((t, i) => { c.strokeStyle = i === 0 ? "#2fae68" : "rgba(160,160,160,.5)"; c.strokeRect((t.name.x - x1) * z, (t.name.y - y1) * z, t.name.w * z, t.name.h * z); if (i === 0) c.strokeRect((t.box.x - x1) * z, (t.box.y - y1) * z, t.box.w * z, t.box.h * z); });
  }

  /* ---------- frame sources ---------- */
  async function handle(source, w, h, o) {
    if (fc.width !== w || fc.height !== h) { fc.width = w; fc.height = h; }
    fx.drawImage(source, 0, 0, w, h);
    const img = fx.getImageData(0, 0, w, h);
    st.frame = { width: w, height: h };
    await onFrame(img, o || {});
    drawPreview();
    if (st.dirty) renderScan();
  }
  async function start() {
    if (st.on) return;
    openPanel();
    if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) { say("This browser can't share a screen (phones and tablets can't). Open this page in Chrome or Edge on a computer, or use screenshots."); return; }
    let stream;
    try { stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 10, max: 15 } }, audio: false }); }
    catch (e) { say(e && e.name === "NotAllowedError" ? "Sharing was cancelled or blocked. Click Share MapleStory window to try again." : "The browser couldn't start sharing (" + (e && e.name || "error") + "). Try again, or use screenshots."); return; }
    try { st.ac = st.ac || new (window.AudioContext || window.webkitAudioContext)(); } catch (e) {}
    st.on = true; st.stream = stream; st.track = stream.getVideoTracks()[0];
    st.track.addEventListener("ended", stop);
    openPanel(); say("Sharing started. Looking for your item inventory…");
    reader().catch(() => {});                      // warm up the text reader
    if (window.MediaStreamTrackProcessor) {        // keeps running while the game is in front of the browser
      const rd = new MediaStreamTrackProcessor({ track: st.track }).readable.getReader();
      (async () => {
        while (st.on) {
          let r; try { r = await rd.read(); } catch (e) { break; }
          if (r.done) break;
          const f = r.value, now = performance.now();
          if (st.busy || now - st.lastTick < 160) { f.close(); continue; }
          st.lastTick = now; st.busy = true;
          try { const w = f.displayWidth, h = f.displayHeight; if (fc.width !== w || fc.height !== h) { fc.width = w; fc.height = h; } await handle(f, w, h); }
          catch (e) { console.error(e); } finally { f.close(); st.busy = false; }
        }
        try { rd.cancel(); } catch (e) {}
      })();
    } else {
      const v = (st.video = document.createElement("video")); v.muted = true; v.srcObject = stream; await v.play();
      const tick = new Worker(URL.createObjectURL(new Blob(["setInterval(()=>postMessage(0),180)"], { type: "text/javascript" })));
      st.timer = tick;
      tick.onmessage = async () => { if (!st.on || st.busy || !v.videoWidth) return; st.busy = true; try { await handle(v, v.videoWidth, v.videoHeight); } catch (e) { console.error(e); } finally { st.busy = false; } };
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
    st.map = new S.InvMap(); st.named = []; st.manual = []; st.hover = null; st.lastRows = null; st.grid = null; st.sawOpenGrid = false; st.dirty = true;
    $("#scanMsg").textContent = ""; say(st.on ? "Started over. Looking for your item inventory…" : "Started over."); renderScan();
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
  function openPanel() { const p = $("#scanPanel"); if (p.hidden) { p.hidden = false; p.scrollIntoView({ behavior: "smooth", block: "start" }); } setButtons(); renderScan(); loadBook().then(renderScan); }
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
    if (Date.now() - st.armed > 5000) { st.armed = Date.now(); const rs = (st.res || results()).rows.filter((r) => r.g.red > 0 && !r.redUntradable), un = rs.filter((r) => !r.name).length; b.textContent = (un ? un + " kinds have no name yet and will show as Unnamed. " : "") + "Replace " + pf.holdings.length + " portfolio rows with " + rs.length + " scanned? Click again"; setTimeout(() => { if (st.armed && Date.now() - st.armed >= 5000) { b.textContent = "Sync portfolio to this scan"; st.armed = 0; } }, 5100); return; }
    st.armed = 0; b.textContent = "Sync portfolio to this scan"; applyScan();
  });
  $("#scanUndo").addEventListener("click", () => { if (!st.undo) return; pf.holdings = st.undo; st.undo = null; sel = null; changed(); $("#scanUndo").hidden = true; $("#scanMsg").textContent = "Put your portfolio back the way it was before the sync."; });
  window.KSBScanUI = { st, onFrame, results, applyScan, loadBook };
})();
