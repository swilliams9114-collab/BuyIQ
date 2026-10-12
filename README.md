# BuyIQ

TornPDA-compatible manual shopping helper for player Bazaars and the Item Market.

## Installation

Install `BuyIQ.user.js` through TornPDA's userscript URL importer, or Tampermonkey on desktop.

Open your Torn **profile page**, expand **BuyIQ Settings** directly below **WarIQ Settings**, enter a **Public Access API key**, and save. A green **BQ** button appears only on a player's Bazaar or the Item Market. Settings are a collapsible section on the Torn profile page; they are not an Android app drawer setting. If WarIQ loads afterward, BuyIQ moves below it automatically.

Default: prices at or below **97% of Torn MV**, no cash reserve, no cost cap, quantity cap **10,000**, right edge at **42%** from the top. Weapons/armor are excluded by default because ordinary item MV does not value individual equipment stats or bonuses. Change these settings in your profile.

## Manual flow

1. **BQ** reads the loaded page and obtains the official API item catalog if necessary. It highlights eligible loaded listings and chooses an affordable listing currently on screen. Nothing is purchased.
2. **Open** opens that one item's native purchase control. If the quantity field is already open, this tap fills it instead.
3. **Fill** enters the quantity allowed by stock, cash reserve, cost cap and quantity cap.
4. **Buy** invokes that listing's native Buy control. Torn's confirmation stays intact.
5. **Yes** invokes one verified native confirmation control.
6. Check Torn's result. **Next** clears the submitted transaction; the next **BQ** tap selects another listing. No purchase is automatically retried. Submitted listings stay excluded for the current page session.

**Skip** excludes an unsubmitted listing for this page session. **Rescan / refresh MV** resets the reference so the next BQ tap fetches fresh API data. **Done / check result** lets you leave a review after using Torn's own confirmation, including when another script has removed confirmations. It excludes the previous row without claiming that the purchase succeeded. It does not click or close Torn's confirmation.

The script does not move the page to off-screen items. Scroll/load items yourself, then tap BQ. Item Market must have actual seller listings open; it does not automatically navigate through category results or load every item's sellers.

## Rules and safeguards

- Only trusted, discrete user clicks advance the purchase flow. Synthetic clicks, repeated held-key events and rapid/double-click chains are rejected.
- Every action handler invokes at most **one** native Torn control. No non-API purchase requests are constructed by this script.
- Opening, filling, buying and confirming are not chained in timers or asynchronous callbacks. API completion only selects a candidate.
- Price, item identity, quantity, stock and visible wallet are checked again before invoking purchase controls.
- Unidentified/ambiguous controls, unknown balances, changed listings or invalid API responses stop the flow.
- No automatic navigation, scrolling, page fetching, purchase retry, CAPTCHA bypass or background page collection.
- MV expires after 15 minutes. Refreshes require a manual tap; MV is Torn's published reference, not a guaranteed resale price.
- No affiliation with Torn or staff approval. Rules: https://www.torn.com/rules.php

## Data use

Official Torn API v2 endpoint: `/torn/items`, using a Public Access key. Settings/key stay locally in `localStorage` (unencrypted). Your key goes only to `api.torn.com`. No developer server, analytics or external data sharing. Catalog and shopping state stay in memory, with no accumulating purchase history. Removing local settings does not revoke your Torn API key. Torn API terms: https://www.torn.com/api.html

## Validation and limitations

Current release: **0.1.5**. Recognizes Item Market purchase/cart controls rendered as labeled divs or anchors, including `Buy item` action controls. Selection stays within the chosen seller row; information icons, disabled carts and ambiguous purchase controls are excluded. Opening and submitting still require separate taps.

The Yes step verifies the native confirmation quote instead of requiring the original stock row to remain visible/unchanged. A row-local confirmation must retain the same item, unit price and quantity input; detached confirmations must identify the item, quantity and total. Changed quantities/prices, ambiguous confirmations and insufficient cash still stop submission.

Recognizes mobile Bazaar stock labels such as `(2 in stock)` and unit-price fields containing another script's percentage indicator. Stock still requires a recognized count format, and prices come only from an identified unit-price field.

Includes the 0.1.2 startup fix for TornPDA globally converting smart apostrophes in JavaScript source to straight apostrophes. User-facing strings contain properly escaped straight apostrophes. All DOM fixture tests run the script through the same quote normalization and closure wrapping used by TornPDA before execution.

Uses TornPDA's native active-tab/visibility state instead of depending on Android WebView's focus report. Profile settings can mount without DOM focus, with a fallback when the expected profile wrapper is absent, and move directly below WarIQ when it loads.

Syntax checking and DOM fixture tests cover purchase steps, stale price/quantity/cash guards, click gating, API errors, profile persistence and PDA visibility. DOM tests simulate visibility and trusted event flags. Real-browser tests are supplied but were **not run successfully** in this build environment because the Chromium download failed. Actual TornPDA layout and native purchase controls still need an in-game check. If Torn changes its markup, BuyIQ stops when it cannot identify a control instead of guessing. Other userscripts that alter purchasing can affect the native flow.

Run `npm install`, `npm run check`, and `npm test`. Optional browser fixtures: install Chromium with `npx playwright install chromium`, then run `npm run test:browser`. Tests use mock pages and a mock API key; they never purchase in Torn.

DOM selector references reviewed during development:
- TornPDA: https://github.com/Manuito83/torn-pda
- TornTools: https://github.com/Mephiles/torntools_extension

Independent code licensed MIT.
