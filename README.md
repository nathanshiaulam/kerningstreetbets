# Kerning Street Bets

A portfolio tracker for MapleStory Classic World cash items: what you hold, what it is worth, and when to sell.

- `index.html` is the portfolio app. It is served by GitHub Pages.
- `data/prices.json` holds the latest price and a short history per item. `data/catalog.json` holds item names, crates, and the sell plan for each.
- `scripts/refresh-prices.mjs` refreshes prices from a public tracker on a schedule (`.github/workflows/prices.yml`) and writes `data/refresh-log.json` so each run can be checked.
- Prices marked with a `t` field were read by hand from Cozy Market and are kept for 18 hours before the tracker may replace them.

## Inventory scanner

`scan-core.js` and `scan.js` read a shared MapleStory window (or uploaded screenshots) in the browser. Nothing is uploaded.

- Frames with no tooltip build a map of the inventory: the grid is found from the red line under the tabs, each slot is fingerprinted, and scrolled views are stitched by their overlapping rows.
- Frames with a tooltip give a name: the left-most tooltip is the hovered item, its name line is read with Tesseract, and its icon is matched to the slots in the map.
- Quantities come from the map, not from hovers, so hovering an item twice, or hovering its second copy, changes nothing. Only unworn items (red badge) are counted.
- Synced rows keep their icon, and that icon names the same item on the next scan without a hover.

`fonts/` holds Sedgwick Ave Display, Big Shoulders Stencil and Figtree (SIL Open Font License 1.1), served with the site. The brick wall, taped bills and stickers are drawn in CSS; the site uses no game artwork.

`vendor/tesseract/` holds Tesseract.js 7.0.0, its LSTM WebAssembly cores and the English model, all Apache-2.0 (licences alongside).

Your portfolio is stored in your browser, not in this repository. Use Export in the app to back it up.

Fan project. Not affiliated with Nexon, Cozy Market, or any tracker.
