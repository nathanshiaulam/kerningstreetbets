# Kerning Street Bets

A portfolio tracker for MapleStory Classic World cash items: what you hold, what it is worth, and when to sell.

- `index.html` is the portfolio app. It is served by GitHub Pages.
- `data/prices.json` holds the latest price and a short history per item. `data/catalog.json` holds item names, crates, and the sell plan for each.
- `scripts/refresh-prices.mjs` refreshes prices from a public tracker on a schedule (`.github/workflows/prices.yml`) and writes `data/refresh-log.json` so each run can be checked.
- Prices marked with a `t` field were read by hand from Cozy Market and are kept for 18 hours before the tracker may replace them.

## Market rules

`market.js` gives every crate item a plan when no hand-set plan exists in the catalog. It uses the crate's end date, about a week of price change, the price most commons in that crate sit at, and listing counts. The same data drives the portfolio value chart and the Good buys page (`#buys`). Hand-set plans in `data/catalog.json` always win, and automatic signals are labelled as automatic.

## Inventory scanner

`scan-core.js` and `scan.js` read a shared MapleStory window (or uploaded screenshots) in the browser. Nothing is uploaded.

- Frames with no tooltip build a map of the inventory: the grid is found from the red line under the tabs, each slot is fingerprinted, and scrolled views are stitched by their overlapping rows.
- Scrolling is followed frame by frame. Between full looks (about six a second) a quick path reads only the inventory's corner of each frame, and only when it changed, so a fast scroll is still seen one or two rows at a time. A view is placed where most of its slots agree with the map; a few may disagree (the pointer over one, a half-covered edge).
- If the list still jumps further than a view can be matched, the new place starts its own stretch of rows. The page says there is a gap, and the stretches join as soon as scrolling back shows how they overlap.
- A slot counts as seen only when the white lines around it are visible, so a slot partly under a tooltip or the pointer is left as "not seen clearly" instead of being misread. The exception is the few icons wider than a slot (Tania Sword, Dark Musician Headphones, Cherub's Bow), which cover the line beside them: that line is excused when the slot on either side of it matches one of those icons in the dictionary.
- An item is counted only once its slot has been seen in a view that held still, or at two screen positions as the list moved. A reading seen a single time in passing is not counted and cannot contradict a later view, and views are placed by trusted readings. So a frame caught half-way through a redraw cannot add items or shift the rows after it; the cost is that a very fast scroll loses its place (low beep, "gap in the scan") or leaves slots under "Not read yet" until they are scrolled over again. Every captured frame is read (30 a second).
- Slots that were never read are shown in a "Not read yet" box above the list, each with its row, its slot and the picture the scanner saw there, and are outlined on the preview while they are in view. The counts line says "every slot in these rows read" when there are none.
- When the list rests with never-seen slots under the item pop-up, the page says so and double-beeps, since the player is looking at the game. The list refreshes whenever any slot changes.
- Frames with a tooltip give a name: the left-most tooltip is the hovered item, its name line is read with Tesseract, and its icon is matched to the slots in the map.
- Quantities come from the map, not from hovers, so hovering an item twice, or hovering its second copy, changes nothing. Only unworn items (red badge) are counted.
- Synced rows keep their icon, and that icon names the same item on the next scan without a hover.

`fonts/` holds Sedgwick Ave Display, Big Shoulders Stencil and Figtree (SIL Open Font License 1.1), served with the site. The brick wall, taped bills and stickers are drawn in CSS; the site uses no game artwork.

`vendor/tesseract/` holds Tesseract.js 7.0.0, its LSTM WebAssembly cores and the English model, all Apache-2.0 (licences alongside).

Your portfolio is stored in your browser, not in this repository. Use Export in the app to back it up.

Fan project. Not affiliated with Nexon, Cozy Market, or any tracker.

## Where an item sits

The Good buys page has a lookup for any cash item (`#buys/<slug>` links straight to one). It shows the item against its own saved history, its crate, and what it sells for. The price job keeps the tracker's record of sales for every item (`q` the middle half of sale prices, `sp` the sale median, `st` the share of listings that sold, `v` sales a day). `sh` is a hand-read comparison of asking prices and sale prices from one Cozy item page, with the time it was read.

The item panel has an **Asking price** block: a slider from 15% under today's price to 30% over, showing the share of recent sales at that price or higher, the time by which half of such listings sell, and the chance of a sale within 1, 3 and 7 days. It is an estimate (`sellModel` in `market.js`) built from two records. The tracker's middle half of sale prices (`q`) sets how fast the share of sales falls as the price rises. Cozy's count of listings seen against sales seen (`l`, `sd`) gives the share of listings that sell at all; a listing at the top of the usual sale range is given that chance per day, and the odds move with price the way sale prices are spread. The two weak points are the assumed asking price of the typical shop and treating one listing Cozy saw as one day on sale, so the waits are rough. The suggested price is the highest with an even chance of selling within 3 days, or within 1 day when the price is falling.

The header shows when Cozy prices were last read (`cozy` in `data/prices.json`, set by `scripts/merge-cozy.py`). Cozy is read through the owner's own browser, on request and by a scheduled wake-up every six hours while that browser is running; nothing in this repo reads Cozy. The tracker job runs every three hours.

Buy levels (`buy` in the catalog) are hand-set for a short watch list and each note says when its level was set. An item at or under its level shows under "In its buy zone"; the rest show under "Above its buy level" with the gap. The levels follow one rule: for a price that is holding, the level is the bottom of the middle half of recent sales (`q`), so a buy there beats three in four recent buyers. For a price that fell 3% or more since the previous day, the level sits two more days of that daily drop below today's price, so an item is never in its zone only because it is falling. Levels go stale within a day or two in a moving market and need resetting after a fresh price read.

Holdings tagged TRASH are crate items to trade in for Aurora Stamps without regret. An item qualifies when it sits within 12% of its crate's floor, has not risen over the week, has no hand-set plan, drops at least as often as an even share of its crate (2% in a 50-piece crate; `r` in the catalog), and is not an accessory (face or eye piece, earrings, ring; `f` in the catalog, from ms-classic.com's crate pages). A crate without its rates falls back to price alone, leaves out its least-listed tenth, and tags items TRASH? instead. All seven crates have their rates saved and each table adds to 100%. Nexon's own rate pages render in the browser and can't be read by a plain fetch, so the tables came from sites that reproduce them: maplestory-classic.com (Founder's, Aurora), meowdb.com (Nov 18, and a partial Nov 4 listing completed by elimination), gms-hub.com (Grand Launch) and mmoexp.com (Halloween).
