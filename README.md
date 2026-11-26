# Kerning Street Bets

A portfolio tracker for MapleStory Classic World cash items: what you hold, what it is worth, and when to sell.

- `index.html` is the whole app. It is served by GitHub Pages.
- `data/prices.json` holds the latest price and a short history per item. `data/catalog.json` holds item names, crates, and the sell plan for each.
- `scripts/refresh-prices.mjs` refreshes prices from a public tracker on a schedule (`.github/workflows/prices.yml`) and writes `data/refresh-log.json` so each run can be checked.
- Prices marked with a `t` field were read by hand from Cozy Market and are kept for 18 hours before the tracker may replace them.

Your portfolio is stored in your browser, not in this repository. Use Export in the app to back it up.

Fan project. Not affiliated with Nexon, Cozy Market, or any tracker.
