/* Kerning Street Bets: inventory scanner, pixel analysis.
   Pure functions over {data: Uint8ClampedArray RGBA, width, height}. No DOM, so the same file runs in
   the page and in the Node tests. All layout constants are in game pixels and scaled by `s`, the number
   of screen pixels per game pixel, which is measured from the red line under the inventory tabs. */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.KSBScan = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const COLS = 5, ROWS = 6;
  const LINE_G = 203;                 // red line length in game px
  const SLOT_X = 5.3, SLOT_Y = 7.4;   // first slot, relative to the red line's left end and bottom row
  const PITCH_X = 36, PITCH_Y = 34, SLOT = 32;
  const N = 16;                       // fingerprint is N x N cells, 2 game px each
  const BADGE0 = 9;                   // cells with x >= BADGE0 and y >= BADGE0 hold the C or A badge
  const SLOT_BG = [222, 217, 207];
  const TIP_BG = [197, 196, 208];

  /* ---------- sampling ---------- */
  // Area-average the source rectangle (fractional coordinates) into nx x ny RGB cells.
  function sample(img, x, y, w, h, nx, ny) {
    const out = new Float32Array(nx * ny * 3), W = img.width, H = img.height, d = img.data;
    const cw = w / nx, ch = h / ny;
    for (let j = 0; j < ny; j++) {
      const ya = y + j * ch, yb = ya + ch;
      for (let i = 0; i < nx; i++) {
        const xa = x + i * cw, xb = xa + cw;
        let r = 0, g = 0, b = 0, wt = 0;
        for (let py = Math.floor(ya); py < yb; py++) {
          if (py < 0 || py >= H) continue;
          const wy = Math.min(yb, py + 1) - Math.max(ya, py);
          if (wy <= 0) continue;
          for (let px = Math.floor(xa); px < xb; px++) {
            if (px < 0 || px >= W) continue;
            const wx = Math.min(xb, px + 1) - Math.max(xa, px);
            if (wx <= 0) continue;
            const k = (py * W + px) * 4, ww = wx * wy;
            r += d[k] * ww; g += d[k + 1] * ww; b += d[k + 2] * ww; wt += ww;
          }
        }
        const o = (j * nx + i) * 3;
        if (wt > 0) { out[o] = r / wt; out[o + 1] = g / wt; out[o + 2] = b / wt; }
      }
    }
    return out;
  }

  /* ---------- inventory grid ---------- */
  // The red line under the tabs: a long, thin, perfectly straight run of saturated red.
  function findGrid(img) {
    const W = img.width, H = img.height, d = img.data;
    const isRed = (k) => d[k] > 170 && d[k + 1] < 70 && d[k + 2] < 70;
    let best = null, loose = null;   // loose: the line is there but the slots are covered (a tooltip is over them)
    for (let y = 0; y < H; y++) {
      let x = 0;
      while (x < W) {
        if (!isRed((y * W + x) * 4)) { x += 8; continue; }
        let a = x; while (a > 0 && isRed((y * W + a - 1) * 4)) a--;
        let b = x; while (b < W - 1 && isRed((y * W + b + 1) * 4)) b++;
        const L = b - a + 1;
        if (L >= 100 && (!best || L > best.L || !loose || L > loose.L)) {
          let t = y; while (t > 0 && isRed(((t - 1) * W + a) * 4) && isRed(((t - 1) * W + b) * 4)) t--;
          let u = y; while (u < H - 1 && isRed(((u + 1) * W + a) * 4) && isRed(((u + 1) * W + b) * 4)) u++;
          const thick = u - t + 1, s = L / LINE_G;
          if (thick >= 1 && thick <= Math.max(3, 4 * s) && L / thick > 40) {
            if (gridLooksRight(img, a, u, s)) { if (!best || L > best.L) best = { L, x0: a, y0: u, s }; }
            else if (!loose || L > loose.L) loose = { L, x0: a, y0: u, s };
          }
        }
        x = b + 8;
      }
    }
    if (best) return { x0: best.x0, y0: best.y0, s: best.s, covered: false };
    return loose ? { x0: loose.x0, y0: loose.y0, s: loose.s, covered: true } : null;
  }
  // The vertical gutters between slot columns are near-white all the way down the grid.
  function gridLooksRight(img, x0, y0, s) {
    const W = img.width, H = img.height, d = img.data;
    if (y0 + (SLOT_Y + ROWS * PITCH_Y) * s >= H || x0 + LINE_G * s > W + 2) return false;
    let ok = 0, n = 0;
    for (let c = 1; c < COLS; c++) {
      const gx = Math.round(x0 + (SLOT_X + c * PITCH_X - 2) * s);
      for (let r = 0; r < ROWS; r++) {
        const gy = Math.round(y0 + (SLOT_Y + r * PITCH_Y + 16) * s), k = (gy * W + gx) * 4;
        n++; if (d[k] > 225 && d[k + 1] > 225 && d[k + 2] > 225) ok++;
      }
    }
    return ok >= n * 0.6;
  }
  function slotRect(grid, r, c) {
    return { x: grid.x0 + (SLOT_X + c * PITCH_X) * grid.s, y: grid.y0 + (SLOT_Y + r * PITCH_Y) * grid.s, w: SLOT * grid.s, h: SLOT * grid.s };
  }
  function gridRect(grid) {
    const a = slotRect(grid, 0, 0), b = slotRect(grid, ROWS - 1, COLS - 1);
    return { x: a.x, y: a.y, w: b.x + b.w - a.x, h: b.y + b.h - a.y };
  }

  /* ---------- fingerprints ---------- */
  const inBadge = (i) => { const x = i % N, y = (i / N) | 0; return x >= BADGE0 && y >= BADGE0; };
  // Mean absolute channel difference; the badge corner is left out so worn and unworn copies match.
  function dist(a, b) {
    let t = 0, n = 0;
    for (let i = 0; i < N * N; i++) {
      if (inBadge(i)) continue;
      const o = i * 3; t += Math.abs(a[o] - b[o]) + Math.abs(a[o + 1] - b[o + 1]) + Math.abs(a[o + 2] - b[o + 2]); n += 3;
    }
    return t / n;
  }
  function relBg(fp, bg) {
    const o = new Float32Array(fp.length);
    for (let i = 0; i < fp.length; i += 3) { o[i] = fp[i] - bg[0]; o[i + 1] = fp[i + 1] - bg[1]; o[i + 2] = fp[i + 2] - bg[2]; }
    return o;
  }
  // "red" = unworn and tradable, "purple" = worn, null = no badge found.
  function badgeOf(fp) {
    let red = 0, pur = 0;
    for (let i = 0; i < N * N; i++) {
      if (!inBadge(i)) continue;
      const o = i * 3, r = fp[o], g = fp[o + 1], b = fp[o + 2];
      if (r > 150 && g < 110 && b < 110 && r - Math.max(g, b) > 70) red++;
      else if (b > 150 && b - g > 25 && b - r > 15) pur++;
    }
    return red >= 6 && red > pur ? "red" : pur >= 5 ? "purple" : null;
  }
  function isEmptySlot(fp) {
    let t = 0;
    for (let i = 0; i < fp.length; i += 3) t += Math.abs(fp[i] - SLOT_BG[0]) + Math.abs(fp[i + 1] - SLOT_BG[1]) + Math.abs(fp[i + 2] - SLOT_BG[2]);
    return t / fp.length < 9;
  }
  function readSlots(img, grid) {
    const rows = [];
    for (let r = 0; r < ROWS; r++) {
      const row = [];
      for (let c = 0; c < COLS; c++) {
        const q = slotRect(grid, r, c), raw = sample(img, q.x, q.y, q.w, q.h, N, N);
        const empty = isEmptySlot(raw);
        row.push({ empty, badge: empty ? null : badgeOf(raw), fp: relBg(raw, SLOT_BG), thumb: empty ? null : sample(img, q.x, q.y, q.w, q.h, 32, 32) });
      }
      rows.push(row);
    }
    return rows;
  }

  // Rebuild a slot fingerprint from a saved 32 x 32 RGBA thumbnail, so names carry over to the next scan.
  function thumbFp(rgba) {
    const raw = new Float32Array(N * N * 3);
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) for (let ch = 0; ch < 3; ch++) {
      let t = 0; for (let a = 0; a < 2; a++) for (let b = 0; b < 2; b++) t += rgba[((y * 2 + a) * 32 + x * 2 + b) * 4 + ch];
      raw[(y * N + x) * 3 + ch] = t / 4;
    }
    return relBg(raw, SLOT_BG);
  }

  /* ---------- tooltips ---------- */
  // Each tooltip's name line starts with a small cyan dot followed by bold white text.
  function findTips(img, s) {
    const W = img.width, H = img.height, d = img.data, seen = new Uint8Array(W * H), tips = [];
    const cyan = (k) => d[k + 2] > 230 && Math.abs(d[k] - 85) < 30 && Math.abs(d[k + 1] - 204) < 30;
    const lo = Math.max(3, 3.3 * s), hi = Math.max(6, 6.2 * s), stack = [], dots = [];
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const p = y * W + x;
      if (seen[p] || !cyan(p * 4)) continue;
      let x1 = x, x2 = x, y1 = y, y2 = y, area = 0; stack.length = 0; stack.push(p); seen[p] = 1;
      while (stack.length && area < 2000) {
        const q = stack.pop(), qx = q % W, qy = (q / W) | 0; area++;
        if (qx < x1) x1 = qx; if (qx > x2) x2 = qx; if (qy < y1) y1 = qy; if (qy > y2) y2 = qy;
        for (const n of [q - 1, q + 1, q - W, q + W]) {
          if (n < 0 || n >= W * H || seen[n]) continue;
          if ((n === q - 1 && qx === 0) || (n === q + 1 && qx === W - 1)) continue;
          if (cyan(n * 4)) { seen[n] = 1; stack.push(n); }
        }
      }
      const w = x2 - x1 + 1, h = y2 - y1 + 1;
      if (w < lo || h < lo || w > hi || h > hi || Math.abs(w - h) > Math.max(2, s) || area < 0.45 * w * h) continue;
      dots.push({ x: x1, y: y1, w, h });
    }
    for (const d of dots) {
      let stop = W;                                   // the next tooltip's dot on the same line ends this name
      for (const o of dots) if (o !== d && o.x > d.x + d.w && Math.abs(o.y - d.y) < 9 * s && o.x - 2 * s < stop) stop = Math.round(o.x - 2 * s);
      const tip = nameLine(img, s, d.x, d.y, d.w, d.h, stop);
      if (tip) tips.push(tip);
    }
    tips.sort((a, b) => a.dot.x - b.dot.x);
    return tips;
  }
  function nameLine(img, s, x, y, w, h, stop) {
    const W = img.width, H = img.height, d = img.data, cy = y + h / 2;
    const y1 = Math.max(0, Math.round(cy - 6.5 * s)), y2 = Math.min(H, Math.round(cy + 9 * s));
    const white = (px, py) => { const k = (py * W + px) * 4; return d[k] >= 200 && d[k + 1] >= 200 && d[k + 2] >= 200; };
    const dark = (px, py) => { if (px < 0 || py < 0 || px >= W || py >= H) return true; const k = (Math.round(py) * W + Math.round(px)) * 4; return d[k] + d[k + 1] + d[k + 2] < 480; };
    // the dot sits on the dark tooltip panel: dark to its left, above and below
    if (!dark(x - 2 * s, cy) || !dark(x + w / 2, y - 2 * s) || !dark(x + w / 2, y + h + 2 * s)) return null;
    const xs = Math.round(x + w + 1.5 * s), maxGap = 12 * s;
    let last = -1, gap = 0, count = 0, darkN = 0, darkAt = 0, countAt = 0;
    const lim = Math.min(W, stop || W);
    for (let px = xs; px < lim && gap < maxGap; px++) {
      let any = false;
      let col = 0;
      for (let py = y1; py < y2; py++) { if (white(px, py)) { any = true; count++; col++; } else if (dark(px, py)) darkN++; }
      if (col >= (y2 - y1) * 0.9) { count -= col; break; }
      if (any) { last = px; gap = 0; darkAt = darkN; countAt = count; } else gap++;
    }
    if (last < 0 || last - xs < 10 * s || count < 25 * s * s) return null;
    const area = (last - xs + 1) * (y2 - y1);                    // sparse white text on a mostly dark band
    if (countAt > area * 0.5 || darkAt < area * 0.4) return null;
    const first = (() => { for (let px = xs; px <= last; px++) for (let py = y1; py < y2; py++) if (white(px, py)) return px; return xs; })();
    if (first - xs > 6 * s) return null;                       // the text must start right after the dot
    // Between the name and the pale icon square there can be extra lines: the rest of a long name that
    // wrapped, and an orange "Untradable". Find where the square really starts and classify each line.
    const LINE = 14.4, BOX0 = 15.2;
    const box = { x: x + 1 * s, y: cy + BOX0 * s, w: 67.2 * s, h: 67.2 * s };
    const paleAt = (px, py) => { if (px < 0 || py < 0 || px >= W || py >= H) return false; const k = (Math.round(py) * W + Math.round(px)) * 4; return Math.abs(d[k] - TIP_BG[0]) < 26 && Math.abs(d[k + 1] - TIP_BG[1]) < 26 && Math.abs(d[k + 2] - TIP_BG[2]) < 26; };
    const rowPale = (py) => { let n = 0; for (let i = 0; i < 12; i++) if (paleAt(box.x + box.w * (0.05 + 0.9 * i / 11), py)) n++; return n / 12; };
    let top = null;
    for (let py = Math.round(cy + 11 * s); py < cy + (BOX0 + LINE * 3.3) * s && py < H - 2; py++) if (rowPale(py) >= 0.45 && rowPale(py - 2 * s) <= 0.2) { top = py; break; }   // an icon can cover half of the square's top edge
    if (top == null) { if (box.y + box.h * 0.5 < H) return null; }     // no icon square under the name: not a tooltip (unless it runs off the picture)
    else box.y = top;
    const extra = top == null ? 0 : Math.max(0, Math.round((top - (cy + BOX0 * s)) / (LINE * s)));
    let untradable = false, name2 = null;
    for (let k = 0; k < extra; k++) {
      const ya = Math.round(cy + (9 + LINE * k) * s), yb = Math.min(H, Math.round(cy + (22.5 + LINE * k) * s)), xa = Math.max(0, Math.round(x - 2 * s)), xb = Math.min(lim, Math.round(x + 232 * s));
      let orange = 0, wn = 0, wx1 = -1, wx2 = -1;
      let gapN = 0, done = false;
      for (let px = xa; px < xb; px++) {
        let col = 0, org = 0;
        for (let py = ya; py < yb; py++) { const q = (py * W + px) * 4; if (d[q] > 190 && Math.abs(d[q + 1] - 150) < 35 && d[q + 2] < 60) org++; else if (d[q] >= 200 && d[q + 1] >= 200 && d[q + 2] >= 200) col++; }
        orange += org;
        if (done) continue;
        if (col >= (yb - ya) * 0.9) { if (wx1 >= 0) done = true; continue; }      // border line, not text
        if (col) { if (wx1 < 0) wx1 = px; wx2 = px; wn += col; gapN = 0; } else if (wx1 >= 0 && ++gapN > maxGap) done = true;
      }
      if (orange > 18 * s * s) untradable = true;
      else if (wn > 20 * s * s && !name2) name2 = { x: wx1 - 2, y: ya, w: wx2 - wx1 + 5, h: yb - ya };
    }
    return { dot: { x, y, w, h, cy }, name: { x: first - 2, y: y1, w: last - first + 5, h: y2 - y1 }, name2, untradable, box, cut: box.y + box.h > H || box.x + box.w > W };
  }
  // The tooltip shows the item's icon at twice the size. Keep a small copy of that box so the icon can be
  // matched against inventory slots later, whenever the map is ready.
  function tipCrop(img, tip, s) {
    const m = Math.ceil(11 * s), b = tip.box, x = Math.max(0, Math.floor(b.x) - m), y = Math.max(0, Math.floor(b.y) - m);
    const w = Math.min(img.width - x, Math.ceil(b.w) + 2 * m), h = Math.min(img.height - y, Math.ceil(b.h) + 2 * m);
    const data = new Uint8ClampedArray(w * h * 4);
    for (let r = 0; r < h; r++) data.set(img.data.subarray(((y + r) * img.width + x) * 4, ((y + r) * img.width + x + w) * 4), r * w * 4);
    return { img: { data, width: w, height: h }, ox: b.x - x, oy: b.y - y, s };
  }
  function tipFp(crop, dx, dy) {
    const s = crop.s, raw = sample(crop.img, crop.ox + (1.6 + (dx || 0)) * s, crop.oy + (3.1 + (dy || 0)) * s, 64 * s, 64 * s, N, N);
    return { fp: relBg(raw, TIP_BG), badge: badgeOf(raw) };
  }
  // Greyscale crop of the name, dark text on white, enlarged for the text reader.
  function nameImage(img, tip, scale, second) {
    const r = second ? tip.name2 : tip.name, W = img.width, d = img.data, k = scale || 3, pad = 12;
    const w = Math.max(1, Math.round(r.w)), h = Math.max(1, Math.round(r.h)), ow = w * k + pad * 2, oh = h * k + pad * 2;
    const src = new Float32Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const sx = Math.min(W - 1, Math.max(0, r.x + x)), sy = Math.min(img.height - 1, Math.max(0, r.y + y)), q = (sy * W + sx) * 4;
      const mn = Math.min(d[q], d[q + 1], d[q + 2]);
      src[y * w + x] = 255 - Math.max(0, Math.min(255, (mn - 110) * 255 / 145));
    }
    const out = new Uint8ClampedArray(ow * oh * 4).fill(255);
    for (let y = 0; y < h * k; y++) for (let x = 0; x < w * k; x++) {   // bilinear enlarge
      const fx = Math.max(0, Math.min(w - 1, (x + 0.5) / k - 0.5)), fy = Math.max(0, Math.min(h - 1, (y + 0.5) / k - 0.5));
      const x0 = Math.floor(fx), y0 = Math.floor(fy), x1 = Math.min(w - 1, x0 + 1), y1 = Math.min(h - 1, y0 + 1), ax = fx - x0, ay = fy - y0;
      const v = (src[y0 * w + x0] * (1 - ax) + src[y0 * w + x1] * ax) * (1 - ay) + (src[y1 * w + x0] * (1 - ax) + src[y1 * w + x1] * ax) * ay;
      const o = ((y + pad) * ow + x + pad) * 4; out[o] = out[o + 1] = out[o + 2] = v;
    }
    return { data: out, width: ow, height: oh };
  }

  /* ---------- inventory map ---------- */
  const SAME = 9;       // two slot fingerprints this close are the same icon
  const TIP_MAX = 24;   // a tooltip icon must be at least this close to a slot icon to be that item
  const TIP_RATIO = 1.35; // and the runner-up must be this much further away
  function slotSame(a, b) { return a.empty === b.empty && (a.empty || (a.badge === b.badge && dist(a.fp, b.fp) <= SAME)); }
  function sameView(a, b) {
    if (!a || !b) return false;
    for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) if (!slotSame(a[r][c], b[r][c])) return false;
    return true;
  }
  const bits = (m) => { let n = 0; while (m) { n += m & 1; m >>= 1; } return n; };
  class InvMap {
    constructor() { this.rows = []; this.offset = 0; this.lost = false; this.tick = 0; this.ver = 0; }
    // Place a clean six-row view. `pages` = true means views may arrive a whole page apart (screenshots).
    add(view, pages) {
      this.tick++;
      let best = null;
      if (!this.rows.length) best = { off: 0 };
      else {
        for (let off = -(ROWS - 1); off <= this.rows.length - 1; off++) {
          let hit = 0, near = 0, bad = 0;
          for (let r = 0; r < ROWS; r++) {
            const m = this.rows[off + r]; if (!m) continue;
            let n = 0; for (let c = 0; c < COLS; c++) if (m[c].cur && slotSame(m[c].cur, view[r][c])) n++;
            if (n === COLS) hit++; else if (n === COLS - 1) near++; else bad++;
          }
          // one slot in one row may differ (the mouse pointer can sit over it); anything more is a different place
          if (bad || !hit || near > 1 || (near && hit < 2)) continue;
          const score = hit * 100 + near * 40 - Math.abs(off - this.offset);
          if (!best || score > best.score) best = { off, score };
        }
        if (!best) {
          if (!pages) { this.lost = true; return null; }
          best = { off: this.rows.length };
        }
      }
      this.lost = false;
      let off = best.off, added = 0;
      const blank = () => Array.from({ length: COLS }, () => ({ cur: null, alts: [] }));
      if (off < 0) { const n = -off; this.rows = Array.from({ length: n }, blank).concat(this.rows); added += n; off = 0; }
      if (added) this.ver++;
      for (let r = 0; r < ROWS; r++) {
        if (off + r >= this.rows.length) { this.rows.push(blank()); added++; this.ver++; }
        for (let c = 0; c < COLS; c++) this.put(this.rows[off + r][c], view[r][c], r);
      }
      this.offset = off;
      return { offset: off, added };
    }
    // A slot is seen at up to six screen positions as the list scrolls. The reading seen at the most
    // positions wins, so a pointer parked over one spot cannot overwrite what was there.
    put(cell, slot, r) {
      let v = cell.alts.find((a) => slotSame(a.slot, slot));
      if (v) { v.mask |= 1 << r; v.t = this.tick; v.slot = slot; } else cell.alts.push((v = { slot, mask: 1 << r, t: this.tick }));
      let top = cell.alts[0];
      for (const a of cell.alts) if (bits(a.mask) > bits(top.mask) || (bits(a.mask) === bits(top.mask) && a.t > top.t)) top = a;
      if (!cell.cur || !slotSame(cell.cur, top.slot)) this.ver++;
      cell.cur = top.slot;
    }
    // Rows that hold at least one item.
    filled() { let n = 0; this.rows.forEach((row, i) => { if (row.some((c) => c.cur && !c.cur.empty)) n = i + 1; }); return n; }
    // Group identical icons. Each group counts its unworn (red) and worn (purple) copies.
    groups() {
      const gs = [];
      this.rows.forEach((row, r) => row.forEach((cell, c) => {
        const sl = cell.cur; if (!sl || sl.empty) return;
        let g = null, gd = SAME;
        for (const k of gs) { const dd = dist(k.fp, sl.fp); if (dd <= gd) { g = k; gd = dd; } }
        if (!g) { g = { fp: sl.fp, thumb: sl.thumb, red: 0, purple: 0, other: 0, slots: [] }; gs.push(g); }
        g[sl.badge || "other"]++; g.slots.push([r, c]);
      }));
      return gs;
    }
  }
  // Best group for a saved tooltip icon. The tooltip draws a different cut of the icon than the slot does,
  // offset by a few pixels that vary from item to item, so search a wide range of shifts coarsely and
  // then finely around the best one. Returns clear = false unless one group stands out.
  function matchTip(crop, groups) {
    const per = new Float32Array(groups.length).fill(Infinity); let bd = Infinity, bx = 0, by = 0;
    const tryAt = (dx, dy) => {
      const t = tipFp(crop, dx, dy).fp;
      for (let k = 0; k < groups.length; k++) { const dd = dist(t, groups[k].fp); if (dd < per[k]) per[k] = dd; if (dd < bd) { bd = dd; bx = dx; by = dy; } }
    };
    for (let dy = -7; dy <= 7; dy++) for (let dx = -7; dx <= 7; dx++) tryAt(dx, dy);
    const cx = bx, cy = by;
    for (let dy = -0.5; dy <= 0.5; dy += 0.5) for (let dx = -0.5; dx <= 0.5; dx += 0.5) if (dx || dy) tryAt(cx + dx, cy + dy);
    let d = Infinity, i = -1;
    for (let k = 0; k < per.length; k++) if (per[k] < d) { d = per[k]; i = k; }
    let second = Infinity; for (let k = 0; k < per.length; k++) if (k !== i && per[k] < second) second = per[k];
    return { i, d, second, dx: bx, dy: by, clear: i >= 0 && d <= TIP_MAX && second >= d * TIP_RATIO };
  }
  // Distance between two saved tooltip icons (same item hovered twice gives a small number).
  function tipDist(a, b) {
    const base = tipFp(a, 0, 0).fp; let d = Infinity;
    for (let dy = -1; dy <= 1; dy += 0.5) for (let dx = -1; dx <= 1; dx += 0.5) d = Math.min(d, dist(base, tipFp(b, dx, dy).fp));
    return d;
  }

  /* ---------- names ---------- */
  function cleanName(t) { return String(t || "").replace(/[|_~`^]/g, "").replace(/\s+/g, " ").replace(/^[^A-Za-z0-9(]+|[^A-Za-z0-9)!?.']+$/g, "").trim(); }
  function lev(a, b) {
    const m = a.length, n = b.length; if (!m) return n; if (!n) return m;
    let prev = Array.from({ length: n + 1 }, (_, i) => i);
    for (let i = 1; i <= m; i++) { const cur = [i]; for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)); prev = cur; }
    return prev[n];
  }
  // Snap a read name to a known item name when it is within a couple of characters.
  function snapName(read, known) {
    const a = read.toLowerCase(); let best = null;
    for (const k of known) { const dd = lev(a, k.toLowerCase()); if (!best || dd < best.d) best = { d: dd, k }; }
    if (best && best.d <= Math.max(1, Math.floor(Math.min(a.length, best.k.length) * 0.15))) return best.k;
    return read;
  }

  return { COLS, ROWS, N, SAME, sample, findGrid, slotRect, gridRect, readSlots, thumbFp, dist, badgeOf, findTips, tipCrop, tipFp, tipDist, nameImage, InvMap, sameView, matchTip, cleanName, snapName, lev };
});
