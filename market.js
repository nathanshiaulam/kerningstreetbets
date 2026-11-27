/* Kerning Street Bets: market rules.
   Turns crate dates, price history and listing counts into a plan for any item that has no hand-set
   plan, builds the portfolio value series, and ranks the Good buys screens. These are rules of thumb
   drawn from how earlier crates behaved, and every result says so. Loaded before the page script;
   everything here runs later, when the page calls it. */
(function () {
  "use strict";
  const DAY = 864e5;
  const iso = (d) => d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  const addDays = (s, n) => { const d = new Date(s + "T12:00:00"); d.setDate(d.getDate() + n); return iso(d); };
  const daysBetween = (a, b) => Math.round((new Date(b + "T12:00:00") - new Date(a + "T12:00:00")) / DAY);
  const round = (n) => { const k = n >= 1e6 ? 5e4 : n >= 1e5 ? 5e3 : 1e3; return Math.round(n / k) * k; };
  let stats = null, statsFor = null;

  // Per crate: the price most of its common items sit at, and the listing count that marks its scarcest tenth.
  function crateStats() {
    if (stats && statsFor === prices.asOf + Object.keys(catalog).length) return stats;
    const by = {};
    for (const s in catalog) { const c = catalog[s], pr = prices.items[s]; if (!c.c || !pr || !(pr.p > 0)) continue; (by[c.c] = by[c.c] || []).push(pr); }
    stats = {};
    for (const k in by) {
      const ps = by[k].map((x) => x.p).sort((a, b) => a - b), half = ps.slice(0, Math.max(1, ps.length >> 1));
      const ls = by[k].map((x) => x.l).filter((x) => x > 0).sort((a, b) => a - b);
      stats[k] = { floor: half[half.length >> 1], scarce: ls.length >= 10 ? ls[Math.floor(ls.length / 10)] : 0, n: ps.length };
    }
    statsFor = prices.asOf + Object.keys(catalog).length;
    return stats;
  }
  // Change over about a week, from saved history where it reaches back far enough, else Cozy's own 7-day figure.
  function trend7(pr, today) {
    if (!pr) return null;
    const h = parseHist(pr.h);
    if (h.length >= 2) {
      // a week back from the newest saved day (saved days are UTC, so the reader's own date can be a day behind)
      const last = h[h.length - 1], cut = addDays(last[0], -7); let old = h[0];
      for (const x of h) if (x[0] <= cut) old = x;
      if (old !== last && daysBetween(old[0], last[0]) >= 3 && old[1] > 0) return (pr.p || last[1]) / old[1] - 1;
    }
    return typeof pr.tr === "number" ? pr.tr : null;
  }
  // "Trash": a crate item sitting at its crate's floor with nothing pointing up: no hand-set plan, not
  // rising, and not one of the crate's scarcest. These are the cheapest things to use up or trade in.
  function trash(c, pr, today) {
    if (!c || !c.c || !pr || !(pr.p > 0) || c.plan || c.buy || c.sell) return false;
    const st = crateStats()[c.c]; if (!st) return false;
    const tr = trend7(pr, today);
    return pr.p <= st.floor * 1.2 && !(tr > 0.1) && !(st.scarce && pr.l > 0 && pr.l <= st.scarce);
  }
  const pctTxt = (x) => Math.round(Math.abs(x) * 100) + "%";

  // A plan for an item with no hand-set plan. Same shape as a catalog entry, so the page treats both alike.
  function autoPlan(c, pr, today) {
    const out = { auto: true };
    if (!pr || !(pr.p > 0)) return out;
    const p = pr.p, cr = c && c.c ? crates[c.c] : null, st = c && c.c ? crateStats()[c.c] : null;
    if (!cr || !st) { out.note = "Not from a Mystery Fashion Crate, so supply never ends. Sell whenever you want the mesos."; return out; }
    const tr = trend7(pr, today), floor = st.floor, common = p <= floor * 1.3, name = cr.name;
    if (common) { out.note = "A common from the " + name + ". It sits at that crate's floor of about " + kfmt(floor) + ", so there is nothing to wait for."; return out; }
    if (today <= cr.end) {
      const left = daysBetween(today, cr.end);
      if (left > 14) {
        if (tr != null && tr <= -0.1) { out.plan = "sell"; out.note = "The " + name + " stays open until " + shortDate(cr.end) + ", so new copies keep arriving and the price is down " + pctTxt(tr) + " this week. Sell now and look again near the end."; }
        else out.note = "The " + name + " stays open until " + shortDate(cr.end) + ". Supply is still coming, so there is no reason to hold.";
        return out;
      }
      const h = parseHist(pr.h).filter((x) => !cr.start || x[0] >= cr.start), low = Math.min(p, ...h.map((x) => x[1]));
      out.plan = "bounce"; out.sellFrom = cr.end; out.e = cr.end; out.sell = round(low * 1.5);
      out.note = "A rarer item from the " + name + ", which ends " + shortDate(cr.end) + ".";
      return out;
    }
    const since = daysBetween(cr.end, today);
    if (since <= 10 && tr != null && tr <= -0.2) {
      out.plan = "keep"; out.reviewBy = addDays(cr.end, 10); out.floor = round(p * 0.85);
      out.note = "Down " + pctTxt(tr) + " this week, just after the " + name + " ended. Winners from earlier crates dipped 20 to 26% at this point and recovered within about 8 days.";
      return out;
    }
    if (p >= floor * 4 && (tr == null || tr >= -0.1)) {
      out.plan = "keep"; out.reviewBy = addDays(today, 14); out.floor = round(p * 0.8);
      out.note = "Supply ended " + shortDate(cr.end) + " and it holds at " + Math.round(p / floor) + " times its crate's floor" + (tr != null && tr > 0.03 ? ", up " + pctTxt(tr) + " this week." : ".");
      return out;
    }
    if (since > 10 && tr != null && tr <= -0.25) { out.plan = "sell"; out.note = "Still falling " + pctTxt(tr) + " a week, " + since + " days after the " + name + " ended. Nothing suggests a recovery."; return out; }
    out.note = "The " + name + " ended " + shortDate(cr.end) + ". The price is drifting, with no clear reason to wait.";
    return out;
  }
  function planFor(c, pr, today) {
    if (c && (c.plan || c.buy || c.sell)) return c;
    return Object.assign({}, c || {}, autoPlan(c, pr, today));
  }

  // Value of today's holdings on each past day. Days an item has no price yet use its first known price.
  function portfolioSeries(views, days) {
    const items = views.filter((v) => v.p != null).map((v) => ({ q: v.h.qty, h: v.hist.length ? v.hist : [[todayStr(), v.p]], p: v.p }));
    const set = new Set(); for (const it of items) for (const x of it.h) set.add(x[0]);
    const today = todayStr(); set.add(today);
    let dates = [...set].sort(); if (days) { const cut = addDays(today, -days); dates = dates.filter((d) => d >= cut); }
    return dates.map((d) => {
      let t = 0;
      for (const it of items) { let v = it.h[0][1]; for (const x of it.h) { if (x[0] <= d) v = x[1]; else break; } if (d === today) v = it.p; t += v * it.q; }
      return [d, t];
    });
  }

  // Good buys: each screen is one reason the market may be underpricing something.
  function goodBuys(today) {
    const st = crateStats(), out = { zone: [], ending: [], dip: [], climb: [], scarce: [] };
    for (const s in catalog) {
      const c = catalog[s], pr = prices.items[s]; if (!pr || !(pr.p > 0)) continue;
      const p = pr.p, tr = trend7(pr, today), row = { slug: s, c, pr, p, tr };
      if (c.buy && p <= c.buy && c.plan !== "sell") { out.zone.push(Object.assign({ why: "At or under the buy level of " + full(c.buy) + " set for it." + (c.note ? " " + c.note : ""), score: c.buy / p }, row)); continue; }
      if (c.plan === "sell") continue;
      const cr = c.c ? crates[c.c] : null, k = c.c ? st[c.c] : null; if (!cr || !k) continue;
      const mult = p / k.floor, left = daysBetween(today, cr.end);
      if (left >= 0 && left <= 7 && mult >= 1.5 && (tr == null || tr <= 0.05))
        out.ending.push(Object.assign({ why: "Its crate ends " + shortDate(cr.end) + ", so no new copies after that" + (tr != null && tr < -0.05 ? ", and it is down " + pctTxt(tr) + " this week." : ".") + " Earlier crates hit their low mid-window and rose into the end.", score: mult * (1 - (tr || 0)) }, row));
      else if (left < 0 && left >= -10 && tr != null && tr <= -0.2 && mult >= 2)
        out.dip.push(Object.assign({ why: "Down " + pctTxt(tr) + " in the week after its crate ended. Winners from earlier crates dipped 20 to 26% here and recovered in about 8 days. Weak items did not, so judge the look.", score: -tr * mult }, row));
      else if (left < -10 && tr != null && tr >= 0.1 && mult >= 2)
        out.climb.push(Object.assign({ why: "Supply ended " + shortDate(cr.end) + " and it is up " + pctTxt(tr) + " this week. Nothing new can be opened, so each sale thins what is left.", score: tr * Math.log(mult + 1) }, row));
      else if (pr.l > 0 && k.scarce && pr.l <= k.scarce && mult <= 1.3 && left < 0)
        out.scarce.push(Object.assign({ why: "Only " + full(pr.l) + " listings seen, among the fewest in its crate, yet it costs the same as the commons. Either overlooked or unwanted: look at it in game first.", score: k.scarce / pr.l }, row));
    }
    for (const k in out) out[k].sort((a, b) => b.score - a.score);
    return out;
  }
  const SCREENS = [
    ["zone", "In its buy zone", "Items with a hand-set buy level that are trading at or below it."],
    ["ending", "Crate ends within a week", "Rarer items whose supply is about to stop."],
    ["dip", "Dipped right after its crate ended", "The pattern earlier winners showed before recovering."],
    ["climb", "Old crate, still climbing", "No new supply, and buyers are paying more each week."],
    ["scarce", "Scarce but priced like a common", "The least obvious ones. Few copies exist, but nobody has bid them up."],
  ];
  function renderBuys() {
    const root = $("#buysBody"); if (!root) return;
    const g = goodBuys(todayStr()); root.replaceChildren();
    let any = false;
    for (const [key, title, sub] of SCREENS) {
      const rows = g[key].slice(0, 8); if (!rows.length) continue; any = true;
      const sec = el("section", { class: "panel card" }, el("h3", { text: title }), el("p", { text: sub }));
      const list = el("div", { class: "buy-list" });
      for (const r of rows) list.append(el("div", { class: "buy" },
        el("div", { class: "nm" }, el("b", { text: r.c.n }), el("span", null, r.c.c ? el("i", { class: "tag", style: "font-style:normal", text: r.c.c }) : null, r.why)),
        el("div", { class: "num" }, el("b", { text: kfmt(r.p) }), r.tr != null ? el("span", { class: "delta " + (r.tr > 0 ? "up" : r.tr < 0 ? "down" : "flat"), text: (r.tr > 0 ? "▲ " : r.tr < 0 ? "▼ " : "") + pctTxt(r.tr) + " in 7 days" }) : el("span", { class: "delta flat", text: "no trend yet" }))));
      sec.append(list); if (g[key].length > rows.length) sec.append(el("div", { class: "msg", text: (g[key].length - rows.length) + " more match this screen." }));
      root.append(sec);
    }
    if (!any) root.append(el("section", { class: "panel card" }, el("p", { text: "Nothing passes the screens at today's prices." })));
  }

  window.KSBMarket = { planFor, autoPlan, trend7, crateStats, trash, portfolioSeries, goodBuys, renderBuys, addDays };
})();
