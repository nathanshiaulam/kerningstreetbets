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
  // Read the 30 visible slots. A slot under a tooltip, or under the pointer that sits just above the
  // hovered tooltip's corner, is marked unknown (unk) so it is never mistaken for an item.
  // `lenient` (single screenshots, where each slot is seen only once) accepts a slot with two whole sides.
  // `wide` is the short list from wideIcons(); without it every upright line must be whole.
  function readSlots(img, grid, tips, lenient, wide) {
    const rows = [], s = grid.s, W = img.width, H = img.height, d = img.data;
    // A slot is boxed in by white lines. If any side's line is hidden for more than a sliver, something
    // (a tooltip, the pointer) is over the slot and its picture can't be trusted. The line is looked for
    // in a small window, so being a pixel off doesn't matter.
    const lit = (x, y) => { x = Math.round(x); y = Math.round(y); if (x < 0 || y < 0 || x >= W || y >= H) return false; const k = (y * W + x) * 4; return d[k] >= 232 && d[k + 1] >= 232 && d[k + 2] >= 232; };
    const OFFS = [0, -0.5, 0.5, -1, 1], ALONG = [0.12, 0.31, 0.5, 0.69, 0.88];
    const side = (q, horiz, at) => { let n = 0; for (const t of ALONG) for (const o of OFFS) if (horiz ? lit(q.x + q.w * t, at + o * s) : lit(at + o * s, q.y + q.h * t)) { n++; break; } return n; };
    // Read all four lines of every slot first: [left, right, above, below], each 0 to 5 points found.
    const sides = [];
    for (let r = 0; r < ROWS; r++) { sides.push([]); for (let c = 0; c < COLS; c++) { const q = slotRect(grid, r, c); sides[r].push([side(q, false, q.x - 2.3 * s), side(q, false, q.x + q.w + 1.7 * s), side(q, true, q.y - 2.9 * s), side(q, true, q.y + q.h - 0.9 * s)]); } }
    // A tall icon can poke over the line above it and hide up to three of the five points there, so the
    // lines above and below need only two. An upright line must be nearly whole, with one exception: the
    // few icons wider than the slot and its margins (Tania Sword is 39 px across) cover the line beside
    // them. That line is excused only when the slot on one side of it shows one of those icons, cleanly
    // enough to match the dictionary, so a pointer or a tooltip resting on a line still hides the slot.
    const seenWide = {};
    const holdsWide = (r, c) => {
      if (c < 0 || c >= COLS || !wide || !wide.length) return false;
      const k = r * COLS + c;
      if (!(k in seenWide)) { const q = slotRect(grid, r, c), m = matchIcon(sample(img, q.x, q.y, q.w, q.h, 32, 32), wide); seenWide[k] = !!m && m.d <= 26; }
      return seenWide[k];
    };
    const upright = (r, c, right) => sides[r][c][right ? 1 : 0] >= 4 || holdsWide(r, c) || holdsWide(r, right ? c + 1 : c - 1);
    const boxed = (r, c) => {
      const v = sides[r][c];
      return lenient ? (v[0] >= 4) + (v[1] >= 4) + (v[2] >= 4) + (v[3] >= 4) >= 2 : v[2] >= 2 && v[3] >= 2 && upright(r, c, false) && upright(r, c, true);
    };
    const bands = (tips || []).map((t) => ({ y1: t.top - 31 * s, y2: t.top + 1 * s, x1: tips.length > 1 ? -1e9 : t.left - 16 * s, x2: tips.length > 1 ? 1e9 : t.left + 32 * s }));
    for (let r = 0; r < ROWS; r++) {
      const row = [];
      for (let c = 0; c < COLS; c++) {
        const q = slotRect(grid, r, c);
        let unk = !boxed(r, c);
        for (const t of tips || []) if (q.x < t.left + 240 * s && q.x + q.w > t.left - 3 * s && q.y + q.h > t.top - 3 * s) unk = true;   // under a tooltip, or possibly so
        for (const b of bands) if (q.y < b.y2 && q.y + q.h > b.y1 && q.x < b.x2 && q.x + q.w > b.x1) unk = true;
        // An unread slot still keeps its picture as it looked, and how many border points showed (0 to 20), so
        // the page can show the player which slots are blocked.
        if (unk) { const v = sides[r][c]; row.push({ unk: true, peek: sample(img, q.x, q.y, q.w, q.h, 32, 32), clear: v[0] + v[1] + v[2] + v[3] }); continue; }
        const raw = sample(img, q.x, q.y, q.w, q.h, N, N), empty = isEmptySlot(raw);
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
  // Every item tooltip has a pale square holding the icon at twice its size. That square is the anchor:
  // short names start with a bullet and long names wrap and are centred with no bullet, but the square
  // is always there. The lines above it are the name (one or more white lines) and, for a worn item,
  // an orange "Untradable" line directly above the square.
  const BOX = 67.2, LINE = 14.4;
  // The square is slightly see-through, so its colour shifts with what is behind it and with the display's
  // colour settings: accept the whole family of pale blue-greys rather than one colour.
  const isPale = (r, g, b) => r >= 150 && r <= 226 && g >= 150 && g <= 226 && b >= 168 && b <= 238 && b - r >= 4 && b - r <= 40 && Math.abs(r - g) <= 14;
  function findTips(img, s) {
    const W = img.width, H = img.height, d = img.data, B = BOX * s, e = Math.max(2, Math.round(1.5 * s)), t1 = Math.max(1, Math.floor(0.9 * s));   // t1: the thin margin between the square's edge and the icon
    const pale = (x, y) => { if (x < 0 || y < 0 || x >= W || y >= H) return false; const k = ((y | 0) * W + (x | 0)) * 4; return isPale(d[k], d[k + 1], d[k + 2]); };
    const frac = (x1, y1, x2, y2) => { let n = 0, t = 0; const sx = Math.max(1, (x2 - x1) / 24), sy = Math.max(1, (y2 - y1) / 24); for (let y = y1; y < y2; y += sy) for (let x = x1; x < x2; x += sx) { t++; if (pale(x, y)) n++; } return t ? n / t : 0; };
    const boxes = [];
    for (let y = e; y < H - B; y++) for (let x = e; x < W - B; x++) {
      const k = (y * W + x) * 4;
      if (d[k + 2] < 168 || !pale(x, y) || pale(x - e, y) || pale(x, y - e) || !pale(x + 1, y) || !pale(x, y + 1)) continue;   // a top-left corner
      if (boxes.some((b) => Math.abs(b.x - x) < B * 0.6 && Math.abs(b.y - y) < B * 0.6)) continue;
      // The icon can touch any edge, so ask for the three edges together rather than each one fully.
      // The square's exact width depends on the scaling (sharp at whole-number scales, a pixel smaller
      // when edges are blended), so look for its right edge instead of assuming it.
      // Right edge: the last column before the tooltip's dark panel resumes. (At low resolution a bright
      // icon bleeds into the thin margin, so the margin itself cannot be relied on.)
      const darkCol = (cx) => { let n = 0, t = 0; for (let py = y + 2; py < y + B * 0.9; py += Math.max(1, s)) { const q = ((py | 0) * W + cx) * 4; t++; if (d[q] + d[q + 1] + d[q + 2] < 400) n++; } return n / t; };
      let re = -1; for (let cx = Math.round(x + 60 * s); cx <= x + 74 * s && cx + 1 < W; cx++) if (darkCol(cx + 1) >= 0.8 && darkCol(cx) < 0.8) re = cx;
      if (re < x + 62 * s) continue;
      const fl = frac(x, y, x + t1, y + B - 1), ft = frac(x, y, re, y + t1);
      if (fl < 0.3 || ft < 0.3 || fl + ft < 1.0) continue;
      if (frac(x - 2 * e, y, x - e, y + B) > 0.2 || frac(x, y - 2 * e, x + B, y - e) > 0.2) continue;   // dark panel outside
      if (frac(x, y, x + B, y + B) < 0.08) continue;                                                    // a big dark icon can fill most of the square
      boxes.push({ x, y, w: B, h: B });
    }
    const tips = [];
    for (const box of boxes) { const t = readTip(img, s, box); if (t) tips.push(t); }
    tips.sort((a, b) => a.box.x - b.box.x);
    return tips;
  }
  function readTip(img, s, box) {
    const W = img.width, H = img.height, d = img.data, left = box.x - 9 * s;
    const xa = Math.max(0, Math.round(left + 2 * s)), xb = Math.min(W, Math.round(left + 236 * s)), maxGap = 12 * s;
    // A real item tooltip has the row of orange class labels (Beginner, Warrior, ...) under the icon square.
    let lab = 0; const ly1 = Math.round(box.y + box.h + 12 * s), ly2 = Math.round(box.y + box.h + 22 * s);
    if (ly2 >= H) return null;
    for (let py = ly1; py < ly2; py++) for (let px = xa; px < xb; px++) { const q = (py * W + px) * 4; if (d[q] > 180 && d[q + 1] > 60 && d[q + 1] < 180 && d[q + 2] < 80 && d[q] - d[q + 1] > 40) lab++; }
    if (lab < 120 * s) return null;
    const names = []; let untradable = false, used = 0;
    for (let k = 0; k < 4; k++) {
      const ya = Math.round(box.y - (21.7 + LINE * k) * s), yb = Math.round(box.y - (6.2 + LINE * k) * s);
      if (ya < 0) break;
      let orange = 0, wn = 0, x1 = -1, x2 = -1, gap = 0, done = false, darkN = 0, edge = false;
      for (let py = ya; py < yb && !edge; py++) { let n = 0; for (let px = xa; px < xb; px += 2) { const q = (py * W + px) * 4; if (d[q] >= 170 && d[q + 1] >= 170 && d[q + 2] >= 170) n++; } if (n * 2 >= (xb - xa) * 0.6) edge = true; }
      if (edge) break;                                         // a bright line right across: the tooltip's top edge, or we are outside it
      for (let px = xa; px < xb; px++) {
        let col = 0, org = 0;
        for (let py = ya; py < yb; py++) { const q = (py * W + px) * 4; if (d[q] > 190 && Math.abs(d[q + 1] - 150) < 40 && d[q + 2] < 70) org++; else if (d[q] >= 200 && d[q + 1] >= 200 && d[q + 2] >= 200) col++; else if (d[q] + d[q + 1] + d[q + 2] < 480) darkN++; }
        orange += org;
        if (done || col >= (yb - ya) * 0.9) continue;          // a full-height white column is the tooltip's border
        if (col) { if (x1 < 0) x1 = px; x2 = px; wn += col; gap = 0; } else if (x1 >= 0 && ++gap > maxGap) done = true;
      }
      if (orange > 18 * s * s) { if (names.length) break; untradable = true; used++; continue; }   // orange above the name belongs to something else
      // A name line is white text on the tooltip's dark panel: sparse, dark between the letters, with a
      // clear margin above and below. Whatever lies above the tooltip (slots, scenery) fails this.
      if (!(wn > 20 * s * s && x2 - x1 > 10 * s)) break;
      let w2 = 0, dk = 0, tot = 0, edgeW = 0; const mt = Math.round(ya + (yb - ya) * 0.1), mb = Math.round(yb - (yb - ya) * 0.06);
      for (let py = ya; py < yb; py++) for (let px = x1; px <= x2; px++) {
        const q = (py * W + px) * 4, wh = d[q] >= 200 && d[q + 1] >= 200 && d[q + 2] >= 200; tot++;
        if (wh) { w2++; if (py < mt || py >= mb) edgeW++; } else if (d[q] + d[q + 1] + d[q + 2] < 480) dk++;
      }
      if (w2 > tot * 0.45 || dk < (tot - w2) * 0.85 || edgeW > w2 * 0.06) break;
      names.unshift({ x: x1 - 2, y: ya, w: x2 - x1 + 5, h: yb - ya }); used++;
      // A one-line name starts with a cyan bullet. Seeing it means this is the top line of the name.
      let cy = 0; for (let py = ya; py < yb; py++) for (let px = Math.max(0, Math.round(x1 - 10 * s)); px < x1; px++) { const q = (py * W + px) * 4; if (d[q + 2] > 200 && d[q + 1] > 150 && d[q] < 150 && d[q + 2] - d[q] > 80) cy++; }
      if (cy > 6 * s * s) break;
      continue;
      break;
    }
    if (!names.length) return null;
    return { box, names, untradable, left, top: box.y - (21.7 + LINE * (used - 1)) * s - 7 * s, cut: false };
  }
  // The tooltip shows the item's icon at twice the size. Keep a small copy of that box so the icon can be
  // matched against inventory slots later, whenever the map is ready.
  function tipCrop(img, tip, s) {
    const m = Math.ceil(11 * s), b = tip.box, x = Math.max(0, Math.floor(b.x) - m), y = Math.max(0, Math.floor(b.y) - m);
    const w = Math.min(img.width - x, Math.ceil(b.w) + 2 * m), h = Math.min(img.height - y, Math.ceil(b.h) + 2 * m);
    const data = new Uint8ClampedArray(w * h * 4);
    for (let r = 0; r < h; r++) data.set(img.data.subarray(((y + r) * img.width + x) * 4, ((y + r) * img.width + x + w) * 4), r * w * 4);
    const rs = [], gs = [], bs = [];                      // the square's own colour, from its top and left margins
    for (let i = 2; i < b.w - 2; i++) for (const [px, py] of [[Math.round(b.x + i), Math.round(b.y)], [Math.round(b.x), Math.round(b.y + i)]]) {
      if (px >= img.width || py >= img.height) continue; const k = (py * img.width + px) * 4;
      if (isPale(img.data[k], img.data[k + 1], img.data[k + 2])) { rs.push(img.data[k]); gs.push(img.data[k + 1]); bs.push(img.data[k + 2]); }
    }
    const med = (a) => a.sort((p, q) => p - q)[a.length >> 1];
    return { img: { data, width: w, height: h }, ox: b.x - x, oy: b.y - y, s, bg: rs.length > 8 ? [med(rs), med(gs), med(bs)] : TIP_BG };
  }
  function tipFp(crop, dx, dy) {
    const s = crop.s, raw = sample(crop.img, crop.ox + (1.6 + (dx || 0)) * s, crop.oy + (3.1 + (dy || 0)) * s, 64 * s, 64 * s, N, N);
    return { fp: relBg(raw, crop.bg || TIP_BG), badge: badgeOf(raw) };
  }
  // Greyscale crop of the name, dark text on white, enlarged for the text reader.
  function nameImage(img, r, scale) {
    const W = img.width, d = img.data, k = scale || 3, pad = 12;
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
    for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) { const x = a[r][c], y = b[r][c]; if (!!x.unk !== !!y.unk || (!x.unk && !slotSame(x, y))) return false; }
    return true;
  }
  const bits = (m) => { let n = 0; while (m) { n += m & 1; m >>= 1; } return n; };
  // How well a run of rows lines up with mapped rows at a given offset. `get(r)` returns a row of slots or null.
  function lineUp(rows, get, len, off) {
    let same = 0, emp = 0, diff = 0, weak = 0;
    for (let r = 0; r < len; r++) {
      const m = rows[off + r], v = get(r); if (!m || !v) continue;
      for (let c = 0; c < COLS; c++) {
        const x = v[c]; if (!x || x.unk) continue;
        const a = m[c].cur, t = a ? null : m[c].once;
        if (a) { if (a.empty && x.empty) emp++; else if (slotSame(a, x)) same++; else diff++; }
        else if (t && !t.empty && !x.empty && slotSame(t, x)) weak++;     // seen once only: a hint, never proof
      }
    }
    return { same, emp, diff, weak };
  }
  // Matching items are strong evidence and matching empty slots weak evidence. A few slots may disagree
  // (the pointer over one, a half-covered edge), but only a small share of what was compared.
  const EMPTY_W = 0.34, NEED = 3;
  const fits = (k) => k.same + k.emp * EMPTY_W >= NEED && k.diff <= 1 + Math.floor((k.same + k.emp + k.diff) * 0.12);
  // A cell's `cur` is a reading that can be trusted: seen in a view that held still, or seen at two screen
  // positions as the list moved. `once` is a reading seen in passing. Views are placed by trusted readings
  // only, so one bad frame (caught half-way through a redraw) can neither add an item nor shift the map. The
  // price is speed: scrolled faster than about two rows per frame, the map loses its place and says so.
  const blankRow = () => Array.from({ length: COLS }, () => ({ cur: null, once: null, alts: [] }));
  class InvMap {
    // The inventory is kept as one or more stretches of rows. Normally there is one. When the list jumps
    // further than a view can be matched (fast scrolling), the new place starts its own stretch, and
    // stretches join up as soon as scrolling shows how they overlap.
    constructor() { this.segs = [{ rows: [], offset: 0 }]; this.at = 0; this.tick = 0; this.ver = 0; this.blank = false; }
    get rows() { return this.segs[this.at].rows; }
    get offset() { return this.segs[this.at].offset; }
    get lost() { return this.segs.length > 1; }
    get gaps() { return this.segs.length - 1; }
    find(seg, view) {
      let best = null;
      const boot = !seg.rows.some((row) => row.some((c) => c.cur));   // nothing trusted yet: readings seen once have to do
      for (let off = -(ROWS - 1); off <= seg.rows.length - 1; off++) {
        const k = lineUp(seg.rows, (r) => view[r], ROWS, off);
        // Where the list was last seen, readings seen once count too: that is a view holding still, which
        // is how the first rows of a scan become trusted.
        const kk = off === seg.offset || boot ? { same: k.same + k.weak, emp: k.emp, diff: k.diff, weak: 0 } : k;
        if (!fits(kk)) continue;
        if (!kk.same && !(this.blank && Math.abs(off - seg.offset) <= ROWS)) continue;   // empty slots alone only count when the list was just seen scrolling through empty rows
        const score = k.same + k.emp * EMPTY_W + k.weak * 0.2 - 2.5 * k.diff - Math.abs(off - seg.offset) * 0.01;
        if (!best || score > best.score) best = { off, score };
      }
      return best;
    }
    // Place a six-row view, which may have unknown slots. `firm` = the view has been seen twice running, so
    // it is real and not a frame caught mid-change; only a firm view may start a new stretch. `pages` = views
    // arrive in order and may be a whole page apart (screenshots). Returns null when the view cannot be
    // placed, {skip:true} when there is nothing in it to place.
    add(view, pages, firm) {
      this.tick++;
      let seen = 0, items = 0; for (const row of view) for (const sl of row) if (!sl.unk) { seen++; if (!sl.empty) items++; }
      if (seen < 8) return { skip: true };
      if (!items) { this.blank = true; return { skip: true }; }        // all empty: nothing to place, but remember it
      let seg = this.segs[this.at], best = null, fresh = false;
      if (!seg.rows.length) best = { off: 0 };
      else {
        best = this.find(seg, view);
        if (!best) for (let i = 0; i < this.segs.length && !best; i++) if (i !== this.at) { best = this.find(this.segs[i], view); if (best) { this.at = i; seg = this.segs[i]; } }
        if (!best) {
          if (pages) best = { off: seg.rows.length };
          else if (firm && items >= 3) { seg = { rows: [], offset: 0 }; this.segs.push(seg); this.at = this.segs.length - 1; best = { off: 0 }; fresh = true; }
          else return null;
        }
      }
      this.blank = false;
      let off = best.off, added = 0;
      if (off < 0) { const n = -off; seg.rows = Array.from({ length: n }, blankRow).concat(seg.rows); added += n; off = 0; }
      if (added) this.ver++;
      for (let r = 0; r < ROWS; r++) {
        if (off + r >= seg.rows.length) { seg.rows.push(blankRow()); added++; this.ver++; }
        for (let c = 0; c < COLS; c++) { if (!view[r][c].unk) this.put(seg.rows[off + r][c], view[r][c], r, !!(firm || pages)); else this.peek(seg.rows[off + r][c], view[r][c]); }
      }
      seg.offset = off;
      const joined = this.segs.length > 1 ? this.join() : 0;
      return { offset: this.segs[this.at].offset, added, fresh, joined };
    }
    // Join the current stretch with any other stretch it now overlaps. Needs at least two matching items.
    join() {
      let n = 0;
      for (let again = true; again;) {
        again = false;
        const a = this.segs[this.at];
        for (let i = 0; i < this.segs.length; i++) {
          if (i === this.at) continue;
          const b = this.segs[i]; let best = null, ties = 0;
          for (let off = -(b.rows.length - 1); off <= a.rows.length - 1; off++) {
            const k = lineUp(a.rows, (r) => b.rows[r].map((cell) => cell.cur || { unk: true }), b.rows.length, off);
            if (k.same < 2 || !fits(k)) continue;
            const score = k.same + k.emp * EMPTY_W - 2.5 * k.diff;
            if (!best || score > best.score + 0.5) { best = { off, score }; ties = 0; } else if (score > best.score - 0.5) ties++;
          }
          if (!best || ties) continue;
          let off = best.off;
          if (off < 0) { a.rows = Array.from({ length: -off }, blankRow).concat(a.rows); a.offset -= off; off = 0; }
          for (let r = 0; r < b.rows.length; r++) {
            if (off + r >= a.rows.length) a.rows.push(blankRow());
            for (let c = 0; c < COLS; c++) { for (const alt of b.rows[r][c].alts) this.merge(a.rows[off + r][c], alt); const pk = b.rows[r][c].peek, to = a.rows[off + r][c]; if (pk && (!to.peek || pk.clear > to.peek.clear)) to.peek = pk; }
          }
          this.segs.splice(i, 1); if (i < this.at) this.at--;
          this.ver++; n++; again = true; break;
        }
      }
      return n;
    }
    // A slot that could not be read leaves its picture on a cell that has never been read. The view where
    // most of the slot's border showed is kept, since that one shows the most of the item.
    peek(cell, slot) {
      if (cell.cur || !slot.peek) return;
      if (!cell.peek) this.ver++; else if (slot.clear < cell.peek.clear) return;
      cell.peek = { thumb: slot.peek, clear: slot.clear };
    }
    // A slot is seen at up to six screen positions as the list scrolls. The reading seen at the most
    // positions wins, so a pointer parked over one spot cannot overwrite what was there.
    put(cell, slot, r, sure) { this.merge(cell, { slot, mask: 1 << r, t: this.tick, n: 1, sure: !!sure }); }
    merge(cell, alt) {
      let v = cell.alts.find((a) => slotSame(a.slot, alt.slot));
      if (v) { v.mask |= alt.mask; v.n += alt.n; v.sure = v.sure || !!alt.sure; if (alt.t >= v.t) { v.t = alt.t; v.slot = alt.slot; } } else cell.alts.push((v = { slot: alt.slot, mask: alt.mask, t: alt.t, n: alt.n, sure: !!alt.sure }));
      const better = (a, b) => bits(a.mask) !== bits(b.mask) ? bits(a.mask) > bits(b.mask) : a.n !== b.n ? a.n > b.n : a.t > b.t;   // more positions, then more sightings, then newer
      let top = null, loose = null;
      for (const a of cell.alts) { if (a.sure || bits(a.mask) >= 2 || a.n >= 4) { if (!top || better(a, top)) top = a; } else if (!loose || better(a, loose)) loose = a; }
      const cur = top ? top.slot : null, once = top ? null : loose ? loose.slot : null;
      if (!!cur !== !!cell.cur || (cur && !slotSame(cell.cur, cur)) || !!once !== !!cell.once) this.ver++;
      cell.cur = cur; cell.once = once;
    }
    // Rows that hold at least one item, and slots inside those rows that were never seen clearly.
    filled() { let t = 0; for (const seg of this.segs) { let a = -1, b = -1; seg.rows.forEach((row, i) => { if (row.some((c) => c.cur && !c.cur.empty)) { if (a < 0) a = i; b = i; } }); if (a >= 0) t += b - a + 1; } return t; }
    unseen() { return this.blocked().length; }
    // Slots with no trusted reading, between the first and last rows that hold one: where each is, why
    // ("covered" by a pop-up or the pointer, or seen "once" in passing), and the picture kept for it.
    blocked() {
      const out = [];
      this.segs.forEach((seg, si) => {
        let a = -1, b = -1; seg.rows.forEach((row, i) => { if (row.some((c) => c.cur && !c.cur.empty)) { if (a < 0) a = i; b = i; } });
        for (let i = a; i >= 0 && i <= b; i++) seg.rows[i].forEach((c, col) => { if (!c.cur) out.push({ seg: si, row: i, col, why: c.once ? "once" : "covered", thumb: c.once && c.once.thumb ? c.once.thumb : c.peek ? c.peek.thumb : null }); });
      });
      return out;
    }
    // Group identical icons. Each group counts its unworn (red) and worn (purple) copies.
    groups() {
      const gs = []; let base = 0;
      for (const seg of this.segs) {
        seg.rows.forEach((row, r) => row.forEach((cell, c) => {
          const sl = cell.cur; if (!sl || sl.empty) return;
          let g = null, gd = SAME;
          for (const k of gs) { const dd = dist(k.fp, sl.fp); if (dd <= gd) { g = k; gd = dd; } }
          if (!g) { g = { fp: sl.fp, thumb: sl.thumb, red: 0, purple: 0, other: 0, slots: [] }; gs.push(g); }
          g[sl.badge || "other"]++; g.slots.push([base + r, c]);
        }));
        base += seg.rows.length;
      }
      return gs;
    }
  }
  // Tooltip icon against slot icon. A cell is either solid icon, where both show the same colour, or
  // see-through, where each shows its own background. Take whichever reading fits better, cell by cell.
  function distTip(t, g, delta) {
    let tot = 0, n = 0;
    for (let i = 0; i < N * N; i++) {
      if (inBadge(i)) continue;
      const o = i * 3, a = t[o] - g[o], b = t[o + 1] - g[o + 1], c = t[o + 2] - g[o + 2];
      tot += Math.min(Math.abs(a) + Math.abs(b) + Math.abs(c), Math.abs(a + delta[0]) + Math.abs(b + delta[1]) + Math.abs(c + delta[2])); n += 3;
    }
    return tot / n;
  }
  // Best group for a saved tooltip icon. The tooltip draws a different cut of the icon than the slot does,
  // offset by a few pixels that vary from item to item, so search a wide range of shifts coarsely and
  // then finely around the best one. Returns clear = false unless one group stands out.
  function matchTip(crop, groups) {
    const per = new Float32Array(groups.length).fill(Infinity); let bd = Infinity, bx = 0, by = 0;
    const bg = crop.bg || TIP_BG, delta = [bg[0] - SLOT_BG[0], bg[1] - SLOT_BG[1], bg[2] - SLOT_BG[2]];
    const tryAt = (dx, dy) => {
      const t = tipFp(crop, dx, dy).fp;
      for (let k = 0; k < groups.length; k++) { const dd = distTip(t, groups[k].fp, delta); if (dd < per[k]) per[k] = dd; if (dd < bd) { bd = dd; bx = dx; by = dy; } }
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

  /* ---------- naming from the icon dictionary ---------- */
  // data/icons.json holds a half-resolution colour signature of every cash item's icon. A slot picture is
  // compared with each signature laid over the slot background, at the few positions an icon of that size
  // can sit (centred, resting near the bottom). The badge and the stack number are left out.
  function prepIcons(json, catalog) {
    const out = [], items = (json && json.items) || {};
    for (const slug in items) {
      const v = items[slug], bin = typeof atob === "function" ? atob(v.d) : Buffer.from(v.d, "base64").toString("binary"), d = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) d[i] = bin.charCodeAt(i);
      let wt = 0; for (let i = 3; i < d.length; i += 4) wt += d[i] > 127 ? 3 : 0.6;
      out.push({ slug, name: catalog && catalog[slug] ? catalog[slug].n : slug, w: v.w, h: v.h, cw: Math.ceil(v.w / 2), ch: Math.ceil(v.h / 2), d, wt });
    }
    return out;
  }
  // The icons wide enough to cover the line between two slots. readSlots uses them to tell such an icon from
  // a pointer or tooltip lying over the line.
  function wideIcons(sigs) { return (sigs || []).filter((g) => g.w >= 38); }
  function iconAt(th, sg, ox, oy, lim) {
    let tot = 0, wt = 0; const cap = lim * sg.wt;       // once the running total passes this, the result cannot beat `lim`
    for (let j = 0; j < sg.ch; j++) { if (tot > cap) return 1e9; for (let i = 0; i < sg.cw; i++) {
      const x = ox + 2 * i, y = oy + 2 * j;
      if (x < 0 || y < 0 || x > 30 || y > 30 || (x >= 18 && y >= 18) || (x <= 9 && y >= 21)) continue;
      const o = (j * sg.cw + i) * 4, a = sg.d[o + 3] / 255, w = a > 0.5 ? 1 : 0.2, q = (y * 32 + x) * 3;
      const r = (th[q] + th[q + 3] + th[q + 96] + th[q + 99]) / 4, g = (th[q + 1] + th[q + 4] + th[q + 97] + th[q + 100]) / 4, b = (th[q + 2] + th[q + 5] + th[q + 98] + th[q + 101]) / 4;
      tot += w * (Math.abs(r - (sg.d[o] + (1 - a) * SLOT_BG[0])) + Math.abs(g - (sg.d[o + 1] + (1 - a) * SLOT_BG[1])) + Math.abs(b - (sg.d[o + 2] + (1 - a) * SLOT_BG[2]))); wt += w * 3;
    } }
    return wt > 40 ? tot / wt : 1e9;
  }
  // Returns the best and second-best dictionary entries for a 32 x 32 slot picture. `sure` means the best
  // is close and clearly ahead; `twin` names a near-identical runner-up (some items share an icon).
  function matchIcon(th, sigs) {
    let b1 = { d: 1e9, i: -1 }, b2 = { d: 1e9, i: -1 };
    for (let k = 0; k < sigs.length; k++) {
      // Most icons rest near the bottom of the slot; short and tall ones sit nearer the middle. Try both and between.
      const sg = sigs[k], cx = Math.round((32 - sg.w) / 2), by = 32 - sg.h - 1, cy = Math.round((32 - sg.h) / 2); let d = 1e9;
      for (let oy = Math.min(by, cy) - 2; oy <= Math.max(by, cy) + 2; oy++) for (let ox = cx - 3; ox <= cx + 3; ox++) { const v = iconAt(th, sg, ox, oy, Math.min(d, b2.d)); if (v < d) d = v; }
      if (d < b1.d) { b2 = b1; b1 = { d, i: k }; } else if (d < b2.d) b2 = { d, i: k };
    }
    if (b1.i < 0) return null;
    const near = b2.i >= 0 && b2.d < Math.max(b1.d * 1.3, b1.d + 6);
    return { slug: sigs[b1.i].slug, name: sigs[b1.i].name, d: b1.d, second: b2.d, sure: b1.d <= 26 && !near, twin: b1.d <= 26 && near ? sigs[b2.i].name : null };
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

  return { COLS, ROWS, N, SAME, sample, findGrid, slotRect, gridRect, readSlots, thumbFp, dist, badgeOf, findTips, tipCrop, tipFp, tipDist, nameImage, InvMap, sameView, matchTip, prepIcons, wideIcons, matchIcon, cleanName, snapName, lev };
});
