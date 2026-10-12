// ==UserScript==
// @name         BuyIQ
// @namespace    samara.BuyIQ
// @version      0.1.5
// @description  Tap-by-tap below-MV shopping helper for Torn Bazaars and Item Market. TornPDA compatible.
// @match        https://www.torn.com/*
// @match        https://torn.com/*
// @grant        GM_xmlhttpRequest
// @connect      api.torn.com
// @run-at       document-end
// @license      MIT
// @homepageURL  https://github.com/swilliams9114-collab/BuyIQ
// @downloadURL  https://raw.githubusercontent.com/swilliams9114-collab/BuyIQ/main/BuyIQ.user.js
// @updateURL    https://raw.githubusercontent.com/swilliams9114-collab/BuyIQ/main/BuyIQ.user.js
// ==/UserScript==

/* Independent implementation. Reads only the foreground, manually loaded page.
 * MV comes from official Torn API v2 /torn/items. Public key is sufficient.
 * Settings/key are stored locally, unencrypted. Key goes only to api.torn.com.
 * Catalog and shopping state stay in memory; no accumulating purchase history.
 * A trusted click may invoke at most one native purchase/open/confirm control.
 * No custom Torn purchase requests, chained clicks, timed clicks, retries,
 * automatic scrolling, navigation, background scraping or CAPTCHA handling.
 * Native Torn controls and confirmations are retained. Test in-game before
 * relying on this first release; Torn can change its page structure.
 */
(function () {
    'use strict';
    const VERSION = '0.1.5', STORE = 'buyiq_settings_v1';
    const DEFAULT = { enabled: true, key: '', discount: 3, reserve: 0, maxQty: 10000,
        maxSpend: 0, position: 'right', y: 42, excludeEquipment: true };
    const SELECT = {
        bazaarRow: '[data-testid="bazaar-items"] [class*="item___"], [data-testid="bazaar-items"] [class*="item__"], [class*="rowItems_"]',
        marketRow: '#item-market-root [class*="rowWrapper__"], #item-market-root [class*="sellerRow__"]',
        price: '[class*="price___"], [class*="price__"]',
        stock: '[class*="amountValue_"], [class*="amount___"], [class*="amount__"], [class*="available__"]',
        input: 'input[class*="buyAmountInput"], .input-money-group input:not([type]), .input-money-group input[type="text"], .input-money-group input[type="number"]'
    };
    let settings;
    try { settings = { ...DEFAULT, ...JSON.parse(localStorage.getItem(STORE) || '{}') }; }
    catch (_) { settings = { ...DEFAULT }; }
    if (!validSettings(settings)) settings = { ...DEFAULT };
    let catalog = new Map(), catalogAt = 0, busy = false, nextAllowed = 0;
    let selected = null, phase = 'scan', quantity = 0, route = location.href;
    let root, action, box, message, info, profile, observer, timer;
    let skipped = new WeakSet(), locked = new WeakSet(), apiRetryAt = 0;
    let pdaState = null, pdaTapFocus = false;
    const isPDA = () => !!(window.flutter_inappwebview || window.__tornpda || /TornPDA/i.test(navigator.userAgent || ''));
    function tabState() {
        const state = pdaState || window.__tornpda?.tab?.state;
        return typeof state?.isActiveTab === 'boolean' && typeof state?.isWebViewVisible === 'boolean' ? state : null;
    }
    const money = n => '$' + n.toLocaleString('en-US');
    const cleanNumber = v => {
        const s = String(v ?? '').trim().replace(/[$,\s]/g, '');
        return /^\d+$/.test(s) && Number.isSafeInteger(Number(s)) ? Number(s) : null;
    };
    function stockNumber(text) {
        const raw = String(text ?? '').trim();
        const plain = cleanNumber(raw);
        if (plain !== null) return plain;
        const count = raw.match(/^\(?\s*([\d,]+)\s*(?:in stock|available|left)\s*\)?$/i)?.[1] ||
            raw.match(/^(?:amount|qty|quantity|stock|available)\s*:?\s*([\d,]+)$/i)?.[1] ||
            raw.match(/^\(?\s*x\s*([\d,]+)\s*\)?$/i)?.[1];
        return cleanNumber(count);
    }
    function validSettings(s) {
        return typeof s.enabled === 'boolean' && typeof s.key === 'string' &&
            (!s.key || /^[a-zA-Z0-9]{16}$/.test(s.key)) &&
            Number.isFinite(s.discount) && s.discount >= 0 && s.discount < 100 &&
            ['reserve', 'maxSpend'].every(k => Number.isSafeInteger(s[k]) && s[k] >= 0) &&
            Number.isInteger(s.maxQty) && s.maxQty >= 1 && s.maxQty <= 10000 &&
            ['left', 'right'].includes(s.position) && Number.isFinite(s.y) && s.y >= 5 && s.y <= 90;
    }
    function pageKind() {
        const url = new URL(location.href), hash = url.hash.toLowerCase();
        if (url.pathname === '/bazaar.php' && url.searchParams.has('userId') &&
            !/^#\/(add|manage|settings)/.test(hash)) return 'bazaar';
        if ((url.pathname === '/page.php' || url.pathname === '/loader.php') &&
            url.searchParams.get('sid')?.toLowerCase() === 'itemmarket' && !/\/add|\/manage|\/sell/.test(hash)) return 'market';
        return null;
    }
    function foreground() {
        if (document.hidden) return false;
        const state = tabState();
        if (state) return state.isActiveTab && state.isWebViewVisible;
        return document.hasFocus() || (isPDA() && pdaTapFocus);
    }
    function visibleUI() {
        if (document.hidden) return false;
        const state = tabState();
        if (state) return state.isActiveTab && state.isWebViewVisible;
        // Legacy Android WebViews may report no focus until a tap. Showing a
        // button is harmless; scanning/purchases still require a trusted tap.
        return isPDA() || document.hasFocus();
    }
    function shown(el) {
        return !!(el?.isConnected && el.getClientRects().length &&
            getComputedStyle(el).visibility !== 'hidden' && !el.closest('[hidden]'));
    }
    function onScreen(el) {
        if (!shown(el)) return false;
        const r = el.getBoundingClientRect();
        return r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth;
    }
    function wallet() {
        const el = document.querySelector('#user-money');
        return el ? cleanNumber(el.getAttribute('data-money')) ?? cleanNumber(el.textContent) : null;
    }
    function itemId(row, kind) {
        const attr = row.getAttribute('data-itemid') || row.getAttribute('data-item');
        if (/^\d+$/.test(attr || '') && catalog.has(Number(attr))) return Number(attr);
        const ids = new Set(Array.from(row.querySelectorAll('img')).map(img =>
            Number((img.getAttribute('src') || '').match(/\/images\/items\/(\d+)(?:\/|\.)/)?.[1])).filter(id => catalog.has(id)));
        if (ids.size === 1) return [...ids][0];
        if (kind === 'market') {
            const id = Number(location.hash.match(/(?:[?&]|^)itemID=(\d+)/i)?.[1] ||
                location.hash.match(/itemID=(\d+)/i)?.[1]);
            if (catalog.has(id)) return id;
            const wrapper = row.closest('[class*="sellerListWrapper__"]');
            const src = wrapper?.previousElementSibling?.querySelector('img.torn-item')?.getAttribute('src');
            const imageId = Number(src?.match(/\/images\/items\/(\d+)(?:\/|\.)/)?.[1]);
            if (catalog.has(imageId)) return imageId;
        }
        return null;
    }
    function readRow(row) {
        if (!shown(row)) return null;
        const kind = pageKind(), id = itemId(row, kind), item = catalog.get(id);
        const priceEl = row.querySelector(SELECT.price), stockEl = row.querySelector(SELECT.stock);
        // Only an explicitly identified unit-price field is accepted.
        const price = cleanNumber(priceEl?.childNodes[0]?.textContent) ?? cleanNumber(priceEl?.textContent) ??
            cleanNumber(priceEl?.textContent?.match(/\$([\d,]+)(?![\d,]|\.\d)/)?.[1]);
        // Mobile Bazaar renders '(2 in stock)', sometimes with the quantity
        // in a nested amountValue span. Neither parentheses nor discount
        // labels in the unit-price field should discard a valid listing.
        const stock = stockNumber(stockEl?.textContent);
        if (!item || !price || stock === null || stock < 1) return null;
        if (row.querySelector('[class*="isBlockedForBuying"]')) return null;
        if (settings.excludeEquipment && /weapon|armor|armour/i.test(item.type)) return null;
        if (!(item.mv > 0 && price <= Math.floor(item.mv * (1 - settings.discount / 100) + 1e-8))) return null;
        return { row, id, name: item.name, mv: item.mv, price, stock, discount: (1 - price / item.mv) * 100 };
    }
    function rows() {
        const kind = pageKind();
        if (!kind) return [];
        let elements = Array.from(document.querySelectorAll(kind === 'bazaar' ? SELECT.bazaarRow : SELECT.marketRow));
        if (kind === 'market') elements = elements.map(el => el.closest('li') || el);
        return [...new Set(elements)].filter(el => !elements.some(other => other !== el && el.contains(other)))
            .map(readRow).filter(Boolean);
    }
    function purchasable(item) {
        const cash = wallet();
        if (cash === null) throw new Error('Cash balance unavailable. No purchase prepared.');
        return Math.min(item.stock, settings.maxQty, Math.max(0, Math.floor((cash - settings.reserve) / item.price)),
            settings.maxSpend ? Math.floor(settings.maxSpend / item.price) : Infinity);
    }
    function refreshHighlights() {
        document.querySelectorAll('.buyiq-match').forEach(el => el.classList.remove('buyiq-match'));
        if (settings.enabled && pageKind() && foreground()) rows().forEach(x => x.row.classList.add('buyiq-match'));
    }
    function reset(text = 'Tap BQ to check loaded listings.') {
        selected = null; quantity = 0; phase = 'scan'; say(text); render();
    }
    function say(text) { if (message && message.textContent !== text) message.textContent = text; }
    function render() {
        if (!root) return;
        root.hidden = !settings.enabled || !pageKind() || !visibleUI();
        root.style[settings.position === 'left' ? 'left' : 'right'] = '2px';
        root.style[settings.position === 'left' ? 'right' : 'left'] = 'auto';
        root.style.top = settings.y + '%';
        box.style.left = settings.position === 'left' ? '0' : 'auto';
        box.style.right = settings.position === 'right' ? '0' : 'auto';
        box.style.top = settings.y > 55 ? 'auto' : '34px';
        box.style.bottom = settings.y > 55 ? '34px' : 'auto';
        const pending = ['review', 'result'].includes(phase);
        root.querySelector('[data-skip]').disabled = busy || pending;
        root.querySelector('[data-rescan]').disabled = busy || pending;
        const finished = root.querySelector('[data-finished]');
        if (finished) finished.hidden = !pending;
        action.disabled = busy;
        const label = { scan: 'BQ', ready: 'Open', fill: 'Fill', buy: 'Buy', review: 'Yes', result: 'Next' }[phase];
        if (action.textContent !== (busy ? '…' : label)) action.textContent = busy ? '…' : label;
        action.setAttribute('aria-label', 'BuyIQ: ' + ({ scan: 'scan current page', ready: 'prepare item', fill: 'fill quantity',
            buy: 'review purchase', review: 'confirm one purchase', result: 'check purchase result' }[phase]));
        const text = selected ? `${selected.name}\n${quantity || '—'} × ${money(selected.price)} · ${money(quantity * selected.price)} total\n${selected.discount.toFixed(1)}% below MV · MV ${money(selected.mv)}` : '';
        if (info.textContent !== text) info.textContent = text;
    }
    async function loadCatalog(force = false) {
        if (!force && catalog.size && Date.now() - catalogAt < 15 * 60000) return;
        if (!settings.key) throw new Error('Save a Public API key in BuyIQ Settings on your Torn profile.');
        if (Date.now() < apiRetryAt) throw new Error('API rate limit: wait two minutes, then tap again.');
        const url = 'https://api.torn.com/v2/torn/items?' + new URLSearchParams({ key: settings.key,
            comment: 'BuyIQ-' + VERSION, timestamp: String(Math.floor(Date.now() / 1000)) });
        let response;
        if (typeof window.PDA_httpGet === 'function') {
            response = await Promise.race([window.PDA_httpGet(url, {}),
                new Promise((_, reject) => setTimeout(() => reject(new Error('Torn API timeout. Tap again to retry.')), 20000))]);
        } else if (typeof GM_xmlhttpRequest === 'function') {
            response = await new Promise((resolve, reject) => GM_xmlhttpRequest({ method: 'GET', url, timeout: 20000,
                onload: resolve, onerror: () => reject(new Error('Torn API connection failed.')),
                ontimeout: () => reject(new Error('Torn API timeout. Tap again to retry.')) }));
        } else throw new Error('Enable TornPDA HTTP permissions or use a userscript manager.');
        if (Number(response?.status) === 429) apiRetryAt = Date.now() + 120000;
        if (Number(response?.status) !== 200) throw new Error('Torn API HTTP error. Tap again later.');
        let data;
        try { data = JSON.parse(response.responseText); } catch (_) { throw new Error('Unexpected Torn API response.'); }
        if (data.error) {
            if ([5, 8].includes(Number(data.error.code))) apiRetryAt = Date.now() + 120000;
            throw new Error('Torn API error ' + Number(data.error.code) + '. Check your Public key or try later.');
        }
        if (!Array.isArray(data.items)) throw new Error('Unexpected item catalog. No purchases enabled.');
        const next = new Map();
        for (const item of data.items) if (Number.isInteger(item.id) && typeof item.name === 'string' &&
            Number.isSafeInteger(item.value?.market_price)) next.set(item.id, { name: item.name, mv: item.value.market_price, type: item.type });
        if (!next.size) throw new Error('No market values received.');
        catalog = next; catalogAt = Date.now();
    }
    function choose() {
        refreshHighlights();
        const matches = rows().filter(x => !skipped.has(x.row) && !locked.has(x.row));
        const item = matches.find(x => onScreen(x.row) && purchasable(x) > 0);
        if (!item) { reset(matches.length ? 'Scroll manually to a highlighted item, then tap BQ. Check your cash reserve.' :
            'No eligible loaded listings. Load or scroll to more items, then tap BQ.'); return; }
        selected = item; quantity = purchasable(item); phase = 'ready';
        say(`${matches.length} eligible loaded listing(s). Tap Open to prepare this item.`); render();
    }
    function current() {
        const item = selected && readRow(selected.row);
        if (!item || item.id !== selected.id || item.price !== selected.price) throw new Error('Listing changed or disappeared. No further action. Tap BQ to rescan.');
        if (!onScreen(item.row)) throw new Error('Scroll manually back to the selected listing before continuing.');
        return item;
    }
    function inputFor(row) { return Array.from(row.querySelectorAll(SELECT.input)).find(shown); }
    function controls(row, type) {
        const all = Array.from(row.querySelectorAll(type === 'confirm' ?
            'button, input[type="submit"], a, [role="button"], span' : 'button, input[type="submit"], a[role="button"]')).filter(el =>
            shown(el) && !el.disabled && el.getAttribute('aria-disabled') !== 'true' && !el.closest('#buyiq, #buyiq-profile'));
        const pattern = type === 'confirm' ? /^(?:yes|accept|confirm|confirm purchase)$/i : /^(?:buy|buy now|purchase)$/i;
        const matching = all.filter(el => pattern.test((el.textContent || el.value || '').trim()) ||
            pattern.test((el.getAttribute('aria-label') || '').trim()) || pattern.test((el.getAttribute('title') || '').trim()));
        return matching.filter(el => !matching.some(parent => parent !== el && parent.contains(el)));
    }
    function oneControl(row, type) {
        let candidates = controls(row, type);
        if (pageKind() === 'market' && ['open', 'buy'].includes(type) && !candidates.length) {
            // Item Market cart controls can be divs/anchors, not text buttons.
            // Require an explicit Buy/Purchase label or purchase-control class
            // within this seller row. Never guess based on button order.
            const cart = Array.from(row.querySelectorAll('button, a, [role="button"], [class*="actionButton"], [class*="buyButton"], [class*="buy___"], [class*="buy__"]'))
                .filter(el => shown(el) && !el.disabled && el.getAttribute('aria-disabled') !== 'true' &&
                    !/disabled|unavailable/i.test(el.className || '') && !el.closest('#buyiq, #buyiq-profile') &&
                    !el.querySelector('input') &&
                    (/^(?:buy|purchase)(?:\s|$)/i.test(el.getAttribute('aria-label') || el.getAttribute('title') || el.textContent.trim()) ||
                    /(?:^|\s)(?:buyButton|buy___|buy__)/.test(el.className || '')));
            candidates = cart.filter(el => !cart.some(parent => parent !== el && parent.contains(el)));
        }
        if (type === 'open' && !candidates.length) candidates = Array.from(row.querySelectorAll(
            'button[class*="activate-buy-button"], button[class*="controlPanelButton"], button[aria-label^="Buy "], button[class*="buyButton"], button[class*="buy___"]'
        )).filter(el => shown(el) && !el.disabled && el.getAttribute('aria-disabled') !== 'true');
        if (candidates.length !== 1) throw new Error('Purchase control could not be identified uniquely. Use Torn\'s normal button; no script click made.');
        return candidates[0];
    }
    function fill(item) {
        const input = inputFor(item.row);
        if (!input) throw new Error('Quantity field is not open yet. Wait for Torn, then tap Fill.');
        quantity = purchasable(item);
        const max = cleanNumber(input.getAttribute('max'));
        if (max) quantity = Math.min(quantity, max);
        if (!quantity) throw new Error('No affordable quantity within your settings.');
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, String(quantity));
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        phase = 'buy'; say('Quantity filled. Next tap opens Torn\'s purchase review.'); render();
    }
    function checkQuantity(item) {
        if (quantity < 1 || quantity > purchasable(item)) throw new Error('Cash or stock changed. No purchase sent. Rescan and prepare again.');
        const input = inputFor(item.row);
        if (input && cleanNumber(input.value) !== quantity) throw new Error('Quantity was changed. No purchase sent. Rescan and prepare again.');
    }
    function confirmControl() {
        const total = quantity * selected.price, cash = wallet();
        if (!Number.isSafeInteger(total) || quantity < 1 || cash === null || cash - settings.reserve < total)
            throw new Error('Cash changed or is unavailable. No confirmation sent.');
        const matchesQuote = (scope, rowBound = false) => {
            const text = scope.textContent.replaceAll(',', '');
            const amounts = [...text.matchAll(/\$(\d+)(?![\d,]|\.\d)/g)].map(m => Number(m[1]));
            const inputs = Array.from(scope.querySelectorAll(SELECT.input));
            if (inputs.length && (inputs.length !== 1 || cleanNumber(inputs[0].value) !== quantity)) return false;
            const quoted = text.match(/(?:buy|purchase)\s+(\d+)\s*(?:x|×)?\s+(.+?)\s+(?:for|at)\s*\$(\d+)(?!\d|\.\d)/i);
            if (quoted && (Number(quoted[1]) !== quantity || Number(quoted[3]) !== total ||
                quoted[2].trim().toLowerCase() !== selected.name.toLowerCase())) return false;
            if (rowBound) {
                // The stock field may now be zero/hidden. It is irrelevant to
                // a native confirmation that already quotes this transaction.
                const priceEl = scope.querySelector(SELECT.price);
                const price = cleanNumber(priceEl?.childNodes[0]?.textContent) ??
                    cleanNumber(priceEl?.textContent?.match(/\$([\d,]+)/)?.[1]);
                if (price !== null && price !== selected.price) return false;
                if (price === selected.price && inputs.length === 1) return true;
            }
            const name = selected.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const quantityText = new RegExp('(?:^|[^\\d])' + quantity + '\\s*(?:x\\s*|(?:units?|items?|of)\\s+)?' + name, 'i');
            const labeledQuantity = new RegExp('(?:quantity|qty|amount)\\s*:?\\s*' + quantity + '(?!\\d)', 'i');
            return text.toLowerCase().includes(selected.name.toLowerCase()) && amounts.includes(total) &&
                (quantityText.test(text) || labeledQuantity.test(text) || inputs.length === 1);
        };
        const scopes = [];
        if (selected.row.isConnected) scopes.push({ el: selected.row, bound: true });
        else {
            const kind = pageKind();
            const live = [...new Set(Array.from(document.querySelectorAll(kind === 'bazaar' ? SELECT.bazaarRow : SELECT.marketRow))
                .map(el => kind === 'market' ? el.closest('li') || el : el))]
                .filter(el => itemId(el, kind) === selected.id && controls(el, 'confirm').length);
            // Bazaar has one row per item. Item Market may have multiple
            // sellers: never choose among ambiguous replacement rows.
            if (live.length === 1) scopes.push({ el: live[0], bound: true });
        }
        document.querySelectorAll('[role="dialog"], [class*="confirmMenu"], [class*="confirmation"], [class*="buyMenu__"]')
            .forEach(el => { if (shown(el) && !el.closest('#buyiq')) scopes.push({ el, bound: false }); });
        // Mobile Bazaar replaces the card with "Buy N x Item for $Total?"
        // and native Yes/No links. Locate that quote even if its React CSS
        // class differs. Only the small ancestor containing the exact quote
        // is considered; never use the page or our own summary as evidence.
        for (const control of controls(document, 'confirm')) {
            let el = control.parentElement;
            for (let depth = 0; el && el !== document.body && depth < 8; depth++, el = el.parentElement) {
                if (el.querySelector('#buyiq')) break;
                const name = selected.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                const quote = new RegExp('(?:buy|purchase)\\s+' + quantity + '\\s*(?:x|×)?\\s*' + name +
                    '\\s+(?:for|at)\\s*\\$' + total + '(?!\\d)', 'i');
                if (quote.test(el.textContent.replaceAll(',', ''))) { scopes.push({ el, bound: false }); break; }
            }
        }
        const buttons = [...new Set(scopes.filter(({ el, bound }) => matchesQuote(el, bound))
            .flatMap(({ el }) => controls(el, 'confirm')))];
        if (buttons.length !== 1) throw new Error('Torn\'s confirmation is not ready or cannot be verified. Wait, or confirm with Torn\'s normal button.');
        return buttons[0];
    }
    function hasCaptcha() {
        return Array.from(document.querySelectorAll('iframe[src*="recaptcha"], iframe[src*="hcaptcha"], [class*="captcha"]')).some(shown);
    }
    function trustedTap(event) {
        if (!event.isTrusted || event.detail > 1 || busy || !settings.enabled || document.hidden || !pageKind() ||
            Date.now() < nextAllowed || hasCaptcha()) return false;
        const state = tabState();
        if (state && (!state.isActiveTab || !state.isWebViewVisible)) return false;
        if (isPDA() && !state) pdaTapFocus = true;
        if (!foreground()) return false;
        nextAllowed = Date.now() + 600;
        return true;
    }
    async function advance(event) {
        if (!trustedTap(event)) return;
        box.hidden = false;
        if (phase === 'scan') {
            busy = true; render(); const at = location.href;
            try { await loadCatalog(); if (at === location.href && foreground() && settings.enabled) choose(); }
            catch (e) { say(e.message); }
            finally { busy = false; render(); }
            return; // API/selection only. Never buy after an asynchronous callback.
        }
        try {
            if (Date.now() - catalogAt > 15 * 60000) throw new Error('MV reference expired. Tap BQ to refresh and rescan.');
            if (phase === 'result') {
                // No retry of a submitted transaction. User reviews Torn's result.
                selected = null; quantity = 0; phase = 'scan';
                say('Check Torn\'s purchase result. Tap BQ to select another listing.'); render(); return;
            }
            if (phase === 'review') {
                // Torn may replace/hide the original row after Buy. Verify the
                // native quote instead of requiring the original stock row.
                const button = confirmControl();
                locked.add(selected.row); phase = 'result';
                say('Confirmation sent once. Check Torn\'s result; tap Next when finished.'); render();
                button.click(); return;
            }
            const item = current();
            if (phase === 'ready') {
                if (inputFor(item.row)) { fill(item); return; }
                const button = oneControl(item.row, 'open');
                phase = 'fill'; say('Item opened. Next tap fills its quantity.'); render();
                button.click(); return; // Exactly one native click for this tap.
            }
            if (phase === 'fill') { fill(item); return; }
            if (phase === 'buy') {
                checkQuantity(item); const button = oneControl(item.row, 'buy');
                phase = 'review'; say('Review Torn\'s confirmation. Tap Yes to submit this single purchase.'); render();
                button.click(); return; // Never auto-click the confirmation.
            }
        } catch (e) {
            if (phase === 'review') { say(e.message); render(); }
            else reset(e.message);
        }
    }
    function mountProfile() {
        if (location.pathname !== '/profiles.php' || document.hidden) return;
        const war = document.getElementById('wartargetiq-profile');
        const anchor = war || document.querySelector('ff-settings-panel') || document.querySelector('.profile-wrapper');
        if (profile?.isConnected) {
            if (war?.parentNode && war.nextElementSibling !== profile)
                war.parentNode.insertBefore(profile, war.nextSibling);
            return;
        }
        profile = document.createElement('details'); profile.id = 'buyiq-profile'; profile.className = 'cont-gray border-round';
        profile.innerHTML = `<summary>BuyIQ Settings · v${VERSION}</summary><div class="bqi-form">
            <label class="bqi-check"><input name="enabled" type="checkbox">Enable BuyIQ</label>
            <label>Minimum discount below MV (%)<input name="discount" type="number" min="0" max="99.99" step="0.1"></label>
            <label>Keep this much cash ($)<input name="reserve" type="number" min="0" step="1"></label>
            <label>Maximum quantity per purchase<input name="maxQty" type="number" min="1" max="10000" step="1"></label>
            <label>Maximum cost per purchase ($, 0 = no cap)<input name="maxSpend" type="number" min="0" step="1"></label>
            <label class="bqi-check"><input name="excludeEquipment" type="checkbox">Exclude weapons and armor</label>
            <small>Equipment stats and bonuses are not priced by ordinary item MV.</small>
            <label>Button edge<select name="position"><option value="right">Right</option><option value="left">Left</option></select></label>
            <label>Button height (% from top)<input name="y" type="number" min="5" max="90"></label>
            <details><summary>API data use</summary><small>Purpose: compare loaded listing prices with Torn\'s MV and prepare manual purchases. A Public Access key is sufficient. The key and settings are saved locally, unencrypted, until removed. Your key is sent only to api.torn.com. No developer server, analytics or data sharing. The catalog stays in memory for up to 15 minutes before another manual refresh; no purchase-history storage. Local key removal does not revoke your Torn key.</small>
            <a href="https://www.torn.com/api.html" target="_blank" rel="noopener noreferrer">Torn API terms</a></details>
            <label>Torn Public API key<input name="key" type="password" autocomplete="off" spellcheck="false"></label>
            <button type="button" data-save>Save settings</button><button type="button" data-remove>Remove key and settings</button>
            <p role="status" data-status></p></div>`;
        const populate = () => Object.keys(DEFAULT).forEach(k => {
            const input = profile.querySelector(`[name="${k}"]`);
            if (input.type === 'checkbox') input.checked = settings[k]; else input.value = settings[k];
        });
        profile.querySelector('[data-save]').addEventListener('click', () => {
            const next = {};
            for (const [k, fallback] of Object.entries(DEFAULT)) {
                const input = profile.querySelector(`[name="${k}"]`);
                next[k] = typeof fallback === 'boolean' ? input.checked : typeof fallback === 'number' ? Number(input.value) : input.value.trim();
            }
            const status = profile.querySelector('[data-status]');
            if (!validSettings(next)) { status.textContent = 'Check your API key and numeric settings.'; return; }
            try { localStorage.setItem(STORE, JSON.stringify(next)); }
            catch (_) { status.textContent = 'Device storage unavailable. Settings were not saved.'; return; }
            settings = next; catalog = new Map(); catalogAt = 0; reset(); refreshHighlights();
            status.textContent = 'Saved. Open a player\'s Bazaar or the Item Market and tap BQ.';
        });
        profile.querySelector('[data-remove]').addEventListener('click', () => {
            try { localStorage.removeItem(STORE); } catch (_) { return; }
            settings = { ...DEFAULT }; catalog = new Map(); catalogAt = 0; populate(); reset();
            profile.querySelector('[data-status]').textContent = 'Saved key and settings removed from this device.';
        });
        populate();
        if (anchor?.parentNode) anchor.parentNode.insertBefore(profile, anchor.nextSibling);
        else (document.querySelector('#mainContainer, #main-container, .content-wrapper') || document.body).appendChild(profile);
    }
    function boot() {
        if (document.getElementById('buyiq')) return;
        const style = document.createElement('style');
        style.textContent = `#buyiq{position:fixed;z-index:999989;font:12px Arial,sans-serif;color:#eee}#buyiq[hidden],#buyiq [hidden]{display:none!important}#buyiq .bqi-action{display:block;box-sizing:border-box;width:28px;height:28px;padding:0;background:#36783e;border:0;border-radius:6px;color:#fff;font:bold 10px Arial,sans-serif;box-shadow:0 2px 8px #0007;touch-action:manipulation;user-select:none;-webkit-user-select:none;-webkit-touch-callout:none}#buyiq button:disabled{opacity:.55}#buyiq .bqi-box{position:absolute;top:34px;width:250px;max-width:calc(100vw - 20px);box-sizing:border-box;background:#242424;border:1px solid #777;border-radius:7px;padding:10px;box-shadow:0 3px 12px #0008}#buyiq .bqi-head{display:flex;align-items:center;justify-content:space-between}#buyiq .bqi-info{white-space:pre-line;line-height:1.5;margin:8px 0}#buyiq .bqi-message{line-height:1.4;overflow-wrap:anywhere}#buyiq .bqi-tools{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}:is(#buyiq,#buyiq-profile) button{background:#3d3d3d;color:#eee;border:1px solid #777;border-radius:4px;min-height:32px;padding:6px 8px;font:12px Arial,sans-serif}#buyiq .bqi-close{min-height:26px}#buyiq-profile{clear:both;margin:12px 0;border:1px solid #777;border-radius:6px;background:var(--default-bg-panel-color,#242424);color:var(--default-color,#eee);font:12px Arial,sans-serif}#buyiq-profile summary{padding:12px;cursor:pointer}#buyiq-profile .bqi-form{padding:0 12px 12px}#buyiq-profile label{display:block;margin:8px 0}#buyiq-profile input:not([type=checkbox]),#buyiq-profile select{display:block;width:100%;box-sizing:border-box;margin-top:4px;min-height:36px;background:#151515;color:#eee;border:1px solid #777;border-radius:4px;padding:6px;font-size:16px}#buyiq-profile .bqi-check{display:flex;align-items:center;gap:8px}#buyiq-profile input[type=checkbox]{width:20px;height:20px}#buyiq-profile small{display:block;line-height:1.5;margin:8px 0}#buyiq-profile a{color:#b0d9b3}#buyiq-profile button{margin:8px 6px 0 0}.buyiq-match{box-shadow:inset 3px 0 #66a55c!important}`;
        document.head.appendChild(style);
        root = document.createElement('div'); root.id = 'buyiq'; root.hidden = true;
        root.innerHTML = '<button type="button" class="bqi-action" aria-label="BuyIQ">BQ</button><div class="bqi-box" hidden><div class="bqi-head"><b>BuyIQ</b><button type="button" class="bqi-close" aria-label="Close BuyIQ">×</button></div><div class="bqi-info"></div><div class="bqi-message" role="status" aria-live="polite"></div><div class="bqi-tools"><button type="button" data-skip>Skip</button><button type="button" data-rescan>Rescan / refresh MV</button></div></div>';
        document.body.appendChild(root);
        action = root.querySelector('.bqi-action'); box = root.querySelector('.bqi-box');
        message = root.querySelector('.bqi-message'); info = root.querySelector('.bqi-info');
        action.addEventListener('click', advance);
        action.addEventListener('keydown', event => { if (event.repeat) event.preventDefault(); });
        root.querySelector('.bqi-close').addEventListener('click', () => { box.hidden = true; });
        root.querySelector('[data-skip]').addEventListener('click', event => {
            if (!trustedTap(event) || phase === 'review' || phase === 'result') return;
            if (selected) skipped.add(selected.row);
            reset('Item skipped. Tap BQ for the next eligible listing.');
        });
        root.querySelector('[data-rescan]').addEventListener('click', event => {
            if (!trustedTap(event) || phase === 'review' || phase === 'result') return;
            catalogAt = 0; skipped = new WeakSet(); reset('Tap BQ to refresh MV and rescan loaded listings.');
        });
        const finished = document.createElement('button'); finished.type = 'button'; finished.dataset.finished = '';
        finished.textContent = 'Done / check result';
        finished.addEventListener('click', event => {
            if (!trustedTap(event) || !['review', 'result'].includes(phase)) return;
            if (selected) locked.add(selected.row);
            reset('Check Torn\'s result. Tap BQ to select another listing; the previous listing stays excluded.');
        });
        root.querySelector('.bqi-tools').appendChild(finished);
        const sync = () => {
            if (document.hidden) { root.hidden = true; return; }
            if (route !== location.href) { route = location.href; box.hidden = true; reset(); }
            mountProfile(); render();
        };
        observer = new MutationObserver(records => {
            if (document.hidden || records.every(r => root.contains(r.target) || profile?.contains(r.target))) return;
            clearTimeout(timer); timer = setTimeout(sync, 100); // UI only; never clicks or requests.
        });
        observer.observe(document.body, { childList: true, subtree: true, characterData: true });
        addEventListener('hashchange', sync); addEventListener('popstate', sync);
        addEventListener('focus', sync);
        addEventListener('blur', () => { pdaTapFocus = false; root.hidden = true;
            if (phase !== 'result') reset('Paused. Tap BQ to rescan when back on this page.'); });
        document.addEventListener('visibilitychange', () => {
            if (document.hidden) { pdaTapFocus = false; root.hidden = true; box.hidden = true;
                if (phase !== 'result') reset('Paused. Tap BQ to rescan when back on this page.'); }
            else sync();
        });
        const applyTabState = state => {
            if (typeof state?.isActiveTab !== 'boolean' || typeof state?.isWebViewVisible !== 'boolean') return;
            pdaState = state;
            if (!state.isActiveTab || !state.isWebViewVisible) {
                pdaTapFocus = false; box.hidden = true;
                if (phase !== 'result') reset('Paused. Tap BQ when this tab is active again.');
            }
            sync();
        };
        addEventListener('tornpda:tabState', event => applyTabState(event.detail));
        let queryingTab = false;
        const queryTabState = () => {
            if (queryingTab || typeof window.flutter_inappwebview?.callHandler !== 'function') return;
            queryingTab = true;
            // Native app metadata only: no Torn page or purchase request.
            Promise.resolve().then(() => window.flutter_inappwebview.callHandler('PDA_getTabState'))
                .then(applyTabState).catch(() => {}).finally(() => { queryingTab = false; });
        };
        addEventListener('flutterInAppWebViewPlatformReady', queryTabState);
        if (window.__PDA_platformReadyPromise?.then) window.__PDA_platformReadyPromise.then(queryTabState).catch(() => {});
        queryTabState();
        reset(); sync();
    }
    if (document.body) boot(); else document.addEventListener('DOMContentLoaded', boot, { once: true });
})();
