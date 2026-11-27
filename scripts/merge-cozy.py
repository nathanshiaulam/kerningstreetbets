#!/usr/bin/env python3
"""Merge a hand-read set of Cozy Market crate lists into data/prices.json and data/catalog.json.

Usage: python3 scripts/merge-cozy.py <folder>
The folder holds one text file per crate (nov18, blackfriday, nov4, halloween, launch, founders, aurora),
one item per line as  Name|7-day trend %|usual price|listed|sold  (trend "—" when Cozy shows none).
Prints what moved against the prices saved before.
"""
import json, re, sys, datetime, os
CRATES = {"blackfriday": "BLACK FRIDAY", "nov18": "TANIA", "nov4": "NOV 4", "halloween": "HALLOWEEN",
          "launch": "LAUNCH", "founders": "FOUNDER'S", "aurora": "AURORA"}
def num(s):
    m = re.match(r"^([\d.]+)([km]?)$", s)
    return int(round(float(m.group(1)) * {"k": 1e3, "m": 1e6, "": 1}[m.group(2)]))
def main(folder):
    C = json.load(open("data/catalog.json")); P = json.load(open("data/prices.json"))
    items, pr = C["items"], P["items"]
    slugify = lambda s: re.sub(r"^-|-$", "", re.sub(r"[^a-z0-9]+", "-", s.lower()))
    byname = {v["n"].lower(): k for k, v in items.items()}
    now = datetime.datetime.now(datetime.timezone.utc)
    stamp, tag = now.strftime("%Y-%m-%dT%H:%M:00Z"), now.strftime("%y%m%d")
    seen, added, moves = set(), [], []
    for key, lab in CRATES.items():
        path = os.path.join(folder, key + ".txt")
        if not os.path.exists(path): print("missing", path); continue
        for line in open(path):
            line = line.rstrip("\n")
            if not line: continue
            name, tr, price, listed, sold = line.split("|")
            slug = byname.get(name.lower()) or slugify(name)
            if slug in seen: continue
            seen.add(slug)
            e = items.get(slug)
            if not e: e = items[slug] = {"n": name}; byname[name.lower()] = slug; added.append(name)
            e["c"] = lab; e["e"] = C["crates"][lab]["end"]
            p = num(price); q = pr.setdefault(slug, {}); old = q.get("p")
            # Cozy's list rounds prices of 1m and up to one decimal. A finer price already read from the
            # item's own page is kept while it still rounds to what the list shows.
            if price.endswith("m") and old and q.get("t") and round(old / 1e5) == round(p / 1e5): p = old
            pts = dict(x.split(":") for x in q.get("h", "").split()) if q.get("h") else {}
            pts[tag] = str(p); q["h"] = " ".join(f"{d}:{v}" for d, v in sorted(pts.items())[-45:])
            if old and q.get("t"): moves.append((p / old - 1, name, old, p, lab))
            q["p"] = p; q["t"] = stamp; q["l"] = int(listed); q["sd"] = int(sold)
            if tr != "—": q["tr"] = round(float(tr) / 100, 3)
    P["asOf"] = stamp
    P["source"] = "Cozy Market usual prices for crate items, read " + now.strftime("%Y-%m-%d %H:%M") + " UTC; tracker sale medians otherwise"
    json.dump(C, open("data/catalog.json", "w"), separators=(",", ":")); json.dump(P, open("data/prices.json", "w"), separators=(",", ":"))
    moves.sort()
    fmt = lambda m: f"{m[1]} [{m[4]}] {m[2]/1000:g}k -> {m[3]/1000:g}k ({m[0]*100:+.0f}%)"
    print("read", len(seen), "items at", stamp, "| new to catalog:", added)
    print("unchanged", sum(1 for m in moves if abs(m[0]) < 0.005), "of", len(moves), "| down", sum(1 for m in moves if m[0] <= -0.005), "| up", sum(1 for m in moves if m[0] >= 0.005))
    print("DOWN:"); [print("  " + fmt(m)) for m in moves[:22]]
    print("UP:"); [print("  " + fmt(m)) for m in moves[::-1][:14] if m[0] > 0.005]
    for lab in CRATES.values():
        ms = [m for m in moves if m[4] == lab]
        if ms: print(f"{lab}: {sum(m[2] for m in ms)/1000:,.0f}k -> {sum(m[3] for m in ms)/1000:,.0f}k across {len(ms)} items ({(sum(m[3] for m in ms)/sum(m[2] for m in ms)-1)*100:+.1f}%)")
if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else ".")
