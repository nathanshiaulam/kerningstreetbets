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
- A slot counts as seen only when the white lines around it are visible, so a slot partly under a tooltip or the pointer is left as "not seen clearly" instead of being misread.
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

Holdings tagged TRASH are crate items from the common drop tier that sit within 10% of their crate's floor, with no hand-set plan and no rise over the week. The common tier is the crate's most common published drop rate, plus the next rate down while the tier holds fewer than ten items; it is only worked out when at least 90% of the crate's items have a rate saved (`r` in the catalog). A crate without its rates falls back to price alone, leaves out its least-listed tenth, and tags items TRASH? instead. Rates saved so far: Black Friday, Founder's and Aurora in full (each adds to 100%); the other crates only for a few items.
