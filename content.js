// In-memory lookups, built once from storage and refreshed on change.
// Each map holds the full normalized title and its looser "base:" form,
// both pointing at the Steam appid (or null for lists from older versions).
let ownedMap = null;
let ownedDlc = new Map(); // exact normalized title -> appid
let wishlistMap = null;
let showPrices = true;
// Games the user chose to hide: { normalizedTitle: displayTitle }.
let ignored = {};
let dimIgnored = false;
// Currency for GOG prices shown without one (e.g. "101.35" on the wishlist
// page, where GOG adds "lei" with CSS): the setting, else the last currency
// seen in a GOG price. Empty when neither is known.
let gogCurrencySetting = "";
let gogCurrencySeen = "";

const STEAM_BADGE_URL = browser.runtime.getURL("steam-badge.svg");

// GOG product tiles: the title element and the tile container around it.
const TITLE_SELECTOR =
  "product-title, .product-tile-vertical__title, .product-row__title";
// "product-tile-extended > a" is the bigger card GOG opens over a hovered
// tile (rendered in a portal at the end of <body>, not inside the tile).
const TILE_SELECTOR =
  ".product-tile, a.product-tile-vertical, .product-row-wrapper, product-tile-extended > a";
const EXTENDED_TILE_SELECTOR = "product-tile-extended > a";
// GOG's own "WISHLISTED" label on a tile, or a row on your GOG wishlist page.
const GOG_WISHLIST_SELECTOR = ".product-label--wishlisted, .product-row.is-wishlisted";
// Areas where tiles are games you already own on GOG (your library page),
// which use the same tile markup but must be left alone.
const SKIP_AREA_SELECTOR = ".account__product-lists";
// Your GOG wishlist page shares that account layout, but lists games you
// don't own on GOG yet, so it is marked like the store.
const ACCOUNT_WISHLIST_SELECTOR = ".account__products--wishlist";

function inSkipArea(el) {
  return !!el.closest(SKIP_AREA_SELECTOR) && !el.closest(ACCOUNT_WISHLIST_SELECTOR);
}

function buildLookup(data) {
  const map = new Map();
  // New format: { title: appid }. Old format: [title, ...].
  const entries = Array.isArray(data)
    ? data.map((name) => [name, null])
    : Object.entries(data || {});
  for (const [name, appid] of entries) {
    // Re-normalize so lists saved by older versions still match.
    const full = normalizeTitle(name);
    if (!full) continue;
    map.set(full, appid);
    const base = "base:" + baseTitle(full);
    if (!map.has(base)) map.set(base, appid);
  }
  return map;
}

// Returns { appid, exact } for a match (appid null for old-format lists;
// exact false when only the edition-stripped title matched), or null.
function lookup(map, full) {
  if (map.has(full)) return { appid: map.get(full), exact: true };
  const base = "base:" + baseTitle(full);
  if (map.has(base)) return { appid: map.get(base), exact: false };
  return null;
}

async function loadLists() {
  const data = await browser.storage.local.get([
    "steamOwned",
    "steamOwnedDlc",
    "steamWishlist",
    "steamOwnedNames",
    "steamWishlistNames",
    "showSteamPrices",
    "dimIgnoredGames",
    "gogCurrency",
    "gogCurrencyDetected",
  ]);
  gogCurrencySetting = data.gogCurrency || "";
  gogCurrencySeen = data.gogCurrencyDetected || "";
  ownedMap = buildLookup(data.steamOwned || data.steamOwnedNames);
  // Exact titles only: the edition-stripped fallback would turn a DLC like
  // "Foo Deluxe Edition" into "foo" and mark the base game as owned.
  ownedDlc = new Map(
    Object.entries(data.steamOwnedDlc || {}).map(([name, appid]) => [
      normalizeTitle(name),
      appid,
    ]),
  );
  wishlistMap = buildLookup(data.steamWishlist || data.steamWishlistNames);
  showPrices = data.showSteamPrices !== false;
  dimIgnored = data.dimIgnoredGames === true;
  try {
    ignored = await getIgnored();
  } catch (err) {
    console.warn("Library Matcher: could not read ignored games", err);
    ignored = {};
  }
}

const MARK_CLASSES = [
  "slm-owned",
  "slm-wishlist",
  "slm-host",
  "slm-tile",
  "slm-ignored",
  "slm-hidden",
  "slm-extended",
  "slm-compact",
  "slm-row",
];

// Remove everything we added, so a fresh pass reflects the current lists
// (e.g. a game removed from the wishlist loses its mark).
function clearMarks() {
  document.querySelectorAll(".slm-ui").forEach((el) => el.remove());
  document
    .querySelectorAll(MARK_CLASSES.map((c) => "." + c).join(","))
    .forEach((el) => el.classList.remove(...MARK_CLASSES));
  document
    .querySelectorAll("[data-slm-price]")
    .forEach((el) => delete el.dataset.slmPrice);
}

function steamUrl(appid) {
  return `https://store.steampowered.com/app/${appid}/`;
}

// Our elements sit inside GOG's tile link, so handle clicks ourselves
// instead of letting them navigate to the GOG product page.
function makeSteamLink(el, appid) {
  if (!appid) return;
  el.classList.add("slm-link");
  el.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    window.open(steamUrl(appid), "_blank", "noopener");
  });
}

// Overlay host: the cover-art area, so our UI never covers GOG's title or
// price row. Falls back to the tile itself in layouts without a cover wrapper.
function getHost(tile) {
  const host =
    tile.querySelector(
      ".product-tile__image-wrapper, .product-tile-vertical__image, .product-tile-extended__slider-wrapper",
    ) ||
    tile;
  host.classList.add("slm-host");
  return host;
}

function steamIcon(size) {
  const img = document.createElement("img");
  img.src = STEAM_BADGE_URL;
  img.alt = "";
  img.width = size;
  img.height = size;
  img.className = "slm-icon";
  return img;
}

// Compact list rows (e.g. the bestsellers list) have a cover only ~80px
// wide: badges there show just the icon and a symbol, and the price card
// goes in the row's footer instead of over the cover.
const COMPACT_TILE_SELECTOR = ".product-tile--list";

function isCompact(tile) {
  return tile.matches(COMPACT_TILE_SELECTOR);
}

// Wide list rows (your GOG wishlist page) have a small cover with GOG's
// price button beside it, and GOG clips anything added to the row's own
// lines. So badges and the price card go in our own strip under the title,
// lined up with it. Not inside the title element: its text is what's matched.
const ROW_TILE_SELECTOR = ".product-row-wrapper";

function rowSlot(tile, titleEl) {
  let slot = tile.querySelector(":scope > .slm-row-slot");
  if (!slot) {
    slot = document.createElement("div");
    slot.className = "slm-ui slm-row-slot";
    tile.appendChild(slot);
  }
  const left = titleEl.getBoundingClientRect().left - tile.getBoundingClientRect().left;
  if (left > 0) slot.style.left = `${Math.round(left)}px`;
  return slot;
}

function createBadge(kind, text, tooltip, appid, compact = false) {
  const badge = document.createElement("span");
  badge.className = `slm-ui slm-badge steam-${kind}-badge`;
  if (compact) badge.classList.add("slm-compact");
  badge.title = appid ? `${tooltip} (click to open on Steam)` : tooltip;
  const label = document.createElement("span");
  label.textContent = text;
  badge.append(steamIcon(16), label);
  makeSteamLink(badge, appid);
  return badge;
}

function createOwnedBadge(appid, compact, dlc) {
  return dlc
    ? createBadge("owned", compact ? "✓" : "Owned DLC", "DLC owned on Steam", appid, compact)
    : createBadge("owned", compact ? "✓" : "Owned", "Owned on Steam", appid, compact);
}

function createWishlistBadge(appid, compact) {
  return createBadge(
    "wishlist",
    compact ? "♥" : "♥ Wishlist",
    "On your Steam wishlist",
    appid,
    compact,
  );
}

// ---------- Price comparison ----------

// Parses "117,65 lei", "$11.99", "1.234,56 €" into a number, or null.
function parsePrice(text) {
  const m = text.match(/\d[\d.,\s]*\d|\d/);
  if (!m) return null;
  let num = m[0].replace(/\s/g, "");
  const lastSep = Math.max(num.lastIndexOf(","), num.lastIndexOf("."));
  if (lastSep !== -1 && num.length - lastSep - 1 === 2) {
    // Two digits after the last separator: that's the decimal point.
    num = num.slice(0, lastSep).replace(/[.,]/g, "") + "." + num.slice(lastSep + 1);
  } else {
    num = num.replace(/[.,]/g, "");
  }
  const value = parseFloat(num);
  return Number.isFinite(value) ? value : null;
}

// Currency markers as GOG displays them. Prefixed dollars come before "$".
// Ambiguous ones (e.g. "kr") are left out: no comparison is better than a wrong one.
const CURRENCY_HINTS = [
  [/\blei\b|\bron\b/i, "RON"],
  [/zł|\bpln\b/i, "PLN"],
  [/kč|\bczk\b/i, "CZK"],
  [/€|\beur\b/i, "EUR"],
  [/£|\bgbp\b/i, "GBP"],
  [/R\$|\bbrl\b/i, "BRL"],
  [/C\$|CA\$|\bcad\b/i, "CAD"],
  [/A\$|AU\$|\baud\b/i, "AUD"],
  [/\bchf\b/i, "CHF"],
  [/₺|\btry\b/i, "TRY"],
  [/\$|\busd\b/i, "USD"],
];

function detectCurrency(text) {
  for (const [re, code] of CURRENCY_HINTS) if (re.test(text)) return code;
  return null;
}

// GOG tiles render <price-value> with a struck .base-value and the current
// .final-value (e.g. "19,85 lei"). If that markup isn't there, fall back to
// the last price-looking text that isn't struck through, a discount
// percentage, or part of the title.
function findGogPrice(tile, titleEl) {
  const finalEl = tile.querySelector(
    "price-value .final-value, [selenium-id='productPriceValue'] .final-value",
  );
  if (finalEl) {
    const text = finalEl.textContent;
    const value = parsePrice(text);
    if (value !== null)
      return { value, currency: detectCurrency(text), text: text.trim() };
    return null; // e.g. "Free" or "Owned": nothing to compare
  }

  let found = null;
  tile.querySelectorAll("*").forEach((el) => {
    if (el.children.length || el.closest(".slm-ui") || titleEl.contains(el)) return;
    const text = el.textContent.trim();
    if (!text || text.includes("%") || !/\d[.,]\d{2}(?!\d)/.test(text)) return;
    if (el.closest("s, del, strike")) return;
    if (getComputedStyle(el).textDecorationLine.includes("line-through")) return;
    const value = parsePrice(text);
    if (value === null) return;
    // The currency may sit in a sibling element, so also check the parent.
    const currency =
      detectCurrency(text) || detectCurrency(el.parentElement?.textContent || "");
    found = { value, currency, text };
  });
  return found;
}

// Remember the currency of a price GOG did label, for pages that don't.
function rememberGogCurrency(code) {
  if (!code || code === gogCurrencySeen) return;
  gogCurrencySeen = code;
  browser.storage.local.set({ gogCurrencyDetected: code }).catch(() => {});
}

function formatMoney(cents, currency) {
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency }).format(
      cents / 100,
    );
  } catch {
    return `${(cents / 100).toFixed(2)} ${currency}`;
  }
}

// Formats a value the way GOG wrote its own price, e.g. sample "19,85 lei"
// and 80.19 give "80,19 lei", so converted amounts read like GOG's.
function formatLike(sample, value) {
  const m = sample.match(/\d[\d.,\s ]*\d|\d/);
  if (!m) return null;
  const decimal = /,\d{2}$/.test(m[0]) ? "," : ".";
  const group = decimal === "," ? "." : ",";
  const [int, frac] = value.toFixed(2).split(".");
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, group);
  return sample.replace(m[0], `${grouped}${decimal}${frac}`).trim();
}

async function addSteamPrice(tile, titleEl, title, match) {
  if (tile.dataset.slmPrice === title) return;
  tile.dataset.slmPrice = title;

  const gogPrice = findGogPrice(tile, titleEl);
  if (gogPrice) {
    if (gogPrice.currency) {
      rememberGogCurrency(gogPrice.currency);
    } else {
      // The price on the page wins; the setting only fills in a missing one.
      gogPrice.currency = gogCurrencySetting || gogCurrencySeen || null;
      gogPrice.unlabelled = true;
    }
  }

  let hit;
  try {
    hit = await browser.runtime.sendMessage({
      action: "steam_price",
      title,
      gogCurrency: gogPrice?.currency || null,
      appid: match.appid,
    });
  } catch {
    return;
  }
  // The tile may have been reused for another game, or marked owned, meanwhile.
  if (
    tile.dataset.slmPrice !== title ||
    tile.classList.contains("slm-owned") ||
    tile.classList.contains("slm-ignored")
  )
    return;
  if (!hit || !hit.price) return;
  // With a known appid, "exact" depends on how the GOG title matched the wishlist.
  const exact = match.appid ? match.exact : hit.exact;
  const steamName = hit.name || title;

  const card = document.createElement("div");
  card.className = "slm-ui slm-price-card";

  // Row 1: Steam logo, Steam price, Steam's own discount, converted amount.
  const row = document.createElement("div");
  row.className = "slm-price-row";
  const price = document.createElement("span");
  price.className = "slm-price";
  price.textContent = formatMoney(hit.price.final, hit.price.currency);
  row.append(steamIcon(14), price);

  if (hit.price.initial > hit.price.final) {
    const pct = Math.round((1 - hit.price.final / hit.price.initial) * 100);
    const disc = document.createElement("span");
    disc.className = "slm-discount";
    disc.textContent = `-${pct}%`;
    row.appendChild(disc);
  }

  const hasConversion =
    hit.converted != null && hit.convertedCurrency !== hit.price.currency;
  if (hasConversion) {
    const conv = document.createElement("span");
    conv.className = "slm-converted";
    conv.textContent =
      "≈ " +
      ((gogPrice?.text &&
        !gogPrice.unlabelled &&
        formatLike(gogPrice.text, hit.converted / 100)) ||
        formatMoney(hit.converted, hit.convertedCurrency));
    row.appendChild(conv);
  }
  card.appendChild(row);

  // Row 2: the verdict, only when comparing like with like.
  const verdict = document.createElement("div");
  verdict.className = "slm-verdict";
  let tooltip = `${steamName} on Steam`;

  if (!exact) {
    verdict.textContent = "Different edition on Steam";
    verdict.classList.add("slm-verdict--na");
    tooltip =
      "Steam price for the edition on your wishlist. It differs from this GOG edition, so the prices aren't directly comparable.";
  } else if (gogPrice && hit.converted != null) {
    const steamValue = hit.converted / 100;
    const diff = (steamValue - gogPrice.value) / Math.max(steamValue, gogPrice.value);
    const pct = Math.round(Math.abs(diff) * 100);
    // Within 1% counts as the same price (conversion rounding).
    if (pct < 1) {
      verdict.textContent = "Same price on both";
      verdict.classList.add("slm-verdict--same");
    } else if (diff < 0) {
      verdict.textContent = `Steam is ${pct}% cheaper`;
      verdict.classList.add("slm-verdict--steam");
    } else {
      verdict.textContent = `GOG is ${pct}% cheaper`;
      verdict.classList.add("slm-verdict--gog");
    }
  }
  if (verdict.textContent) card.appendChild(verdict);

  if (hasConversion) tooltip += "\nConverted at today's ECB exchange rate.";
  card.title = tooltip;

  makeSteamLink(card, match.appid || hit.appid);
  tile.querySelector(".slm-price-card")?.remove();
  // Compact rows: between GOG's wishlist heart and its price.
  const footer = isCompact(tile) && tile.querySelector(".product-tile__footer");
  if (tile.matches(ROW_TILE_SELECTOR)) {
    card.classList.add("slm-row");
    rowSlot(tile, titleEl).appendChild(card);
  } else if (footer) {
    card.classList.add("slm-compact");
    footer.insertBefore(card, footer.querySelector(".product-tile__price-info"));
  } else {
    getHost(tile).appendChild(card);
  }
}

// ---------- Ignore list ----------

function createIgnoreButton(key, title, isIgnored, extended = false) {
  const btn = document.createElement("span");
  btn.className = "slm-ui slm-ignore-btn";
  // The hover card has room for a label; the small tiles get just the ✕.
  btn.textContent = isIgnored ? "↺ Unignore" : extended ? "✕ Ignore" : "✕";
  btn.title = isIgnored
    ? `Stop ignoring "${title}"`
    : `Ignore "${title}" (hide it from GOG pages)`;
  btn.addEventListener("click", (e) => {
    // The button sits inside GOG's tile link.
    e.preventDefault();
    e.stopPropagation();
    toggleIgnored(key, title, !isIgnored);
  });
  return btn;
}

function toggleIgnored(key, title, on) {
  // The storage listener below re-renders every tile.
  return setIgnored(key, title, on).catch((err) => {
    // Most likely Firefox's sync storage quota (about 500 entries).
    console.warn("Library Matcher: could not update ignored games", err);
    alert(`Library Matcher couldn't update the ignore list:\n${err.message}`);
  });
}

// ---------- Right-click menu ----------
// GOG opens a bigger hover card over a tile, covering the ✕ button, so the
// background script also offers "Ignore" in the right-click menu. These find
// the game under the element that was right-clicked.

function titleIn(el) {
  const titleEl = el.matches(TITLE_SELECTOR) ? el : el.querySelector(TITLE_SELECTOR);
  return titleEl?.textContent.trim() || null;
}

function findGameTitle(target) {
  if (!target || inSkipArea(target)) return null;

  // 1. Inside a regular tile.
  const tile = target.closest(TILE_SELECTOR);
  if (tile) return titleIn(tile);

  // 2. A link to a game page (e.g. GOG's hover card): use the title of a
  //    tile that links to the same page.
  const href = target.closest("a[href]")?.href;
  if (href && /\/game\//.test(href)) {
    for (const t of document.querySelectorAll(TILE_SELECTOR)) {
      const link = t.matches("a[href]") ? t : t.querySelector("a[href]");
      if (link?.href === href && !inSkipArea(t)) return titleIn(t);
    }
  }

  // 3. The nearest container holding exactly one game title.
  for (let el = target, i = 0; el && el !== document.body && i < 8; el = el.parentElement, i++) {
    const titles = el.querySelectorAll(TITLE_SELECTOR);
    if (titles.length === 1) return titles[0].textContent.trim() || null;
    if (titles.length > 1) break;
  }
  return null;
}

// The game is worked out when the right-click happens: by the time a menu
// item is clicked, GOG has usually closed its hover card (the pointer left
// it for the menu) and removed the clicked element from the page.
let lastRightClickTitle = null;
document.addEventListener(
  "contextmenu",
  (e) => {
    lastRightClickTitle = findGameTitle(e.target);
  },
  true,
);

function menuTarget(targetElementId) {
  let raw = lastRightClickTitle;
  if (!raw) {
    const el = browser.menus.getTargetElement(targetElementId);
    raw = el?.isConnected ? findGameTitle(el) : null;
  }
  const key = raw && normalizeTitle(raw);
  if (!key) return null;
  return { key, title: raw, ignored: key in ignored };
}

browser.runtime.onMessage.addListener((message) => {
  if (message.action === "slm_menu_target") {
    return Promise.resolve(menuTarget(message.targetElementId));
  }
  if (message.action === "slm_menu_toggle") {
    const t = menuTarget(message.targetElementId);
    if (t) toggleIgnored(t.key, t.title, !t.ignored);
  }
});

// A tile is often wrapped in single-child elements (e.g. a <product-tile>
// grid cell); hide the outermost one so no empty grid slot is left behind.
function hideTile(tile) {
  let el = tile;
  for (let i = 0; i < 3; i++) {
    const parent = el.parentElement;
    if (!parent || parent === document.body || parent.childElementCount !== 1) break;
    el = parent;
  }
  el.classList.add("slm-hidden");
}

// ---------- Main pass ----------

async function markOwnedGames() {
  if (!ownedMap || !wishlistMap) await loadLists();

  document.querySelectorAll(TITLE_SELECTOR).forEach((titleEl) => {
    const tile = titleEl.closest(TILE_SELECTOR);
    if (!tile || inSkipArea(tile)) return;

    const rawTitle = titleEl.textContent.trim();
    const gogTitle = normalizeTitle(rawTitle);
    if (!gogTitle) return;

    if (gogTitle in ignored) {
      if (tile.classList.contains("slm-ignored")) return;
      tile.querySelectorAll(".slm-ui").forEach((el) => el.remove());
      tile.classList.remove("slm-owned", "slm-wishlist");
      tile.classList.add("slm-ignored", "slm-tile");
      if (dimIgnored) tile.appendChild(createIgnoreButton(gogTitle, rawTitle, true));
      else hideTile(tile);
      return;
    }
    if (!tile.querySelector(".slm-ignore-btn")) {
      const extended = tile.matches(EXTENDED_TILE_SELECTOR);
      tile.classList.add("slm-tile");
      if (extended) tile.classList.add("slm-extended");
      tile.appendChild(createIgnoreButton(gogTitle, rawTitle, false, extended));
    }

    const compact = isCompact(tile);
    if (compact) tile.classList.add("slm-compact");
    const row = tile.matches(ROW_TILE_SELECTOR);
    if (row) tile.classList.add("slm-row");
    // Where the corner badge goes: under the title on wide rows, else the cover.
    const placeBadge = (badge) => {
      if (row) {
        badge.classList.add("slm-row");
        rowSlot(tile, titleEl).prepend(badge);
      } else {
        getHost(tile).appendChild(badge);
      }
    };

    const ownedGame = lookup(ownedMap, gogTitle);
    const owned =
      ownedGame ||
      (ownedDlc.has(gogTitle) && { appid: ownedDlc.get(gogTitle), dlc: true });
    if (owned) {
      if (tile.querySelector(".steam-owned-badge")) return;
      tile.classList.remove("slm-wishlist");
      tile
        .querySelectorAll(".steam-wishlist-badge, .slm-price-card")
        .forEach((el) => el.remove());
      tile.classList.add("slm-owned");
      const badge = createOwnedBadge(owned.appid, compact, owned.dlc);
      // Compact and wide rows: the CSS keeps the badge undimmed there.
      if (compact || row) placeBadge(badge);
      else tile.appendChild(badge);
      return;
    }

    // Steam prices are only shown for wishlisted games: on the Steam wishlist
    // (known appid) or on the GOG wishlist (found on Steam by title).
    const wish = lookup(wishlistMap, gogTitle);
    const gogWishlisted = !!tile.querySelector(GOG_WISHLIST_SELECTOR);
    if (!wish && !gogWishlisted) return;

    if (wish && !tile.querySelector(".steam-wishlist-badge")) {
      tile.classList.add("slm-wishlist");
      placeBadge(createWishlistBadge(wish.appid, compact));
    }
    if (showPrices) {
      addSteamPrice(tile, titleEl, rawTitle, wish || { appid: null, exact: true });
    }
  });
}

let debounceTimer = null;
const DEBOUNCE_MS = 300; // wait 300ms after last mutation

// GOG's hover card should get its badges as it opens, not 300ms later.
const HOVER_CARD_DEBOUNCE_MS = 30;

function addsHoverCard(mutations) {
  return mutations.some((m) =>
    Array.from(m.addedNodes).some(
      (n) =>
        n.nodeType === Node.ELEMENT_NODE &&
        (n.matches("product-tile-extended, product-tile-extended *") ||
          n.querySelector("product-tile-extended")),
    ),
  );
}

function debouncedMarkOwned(mutations = []) {
  if (debounceTimer) clearTimeout(debounceTimer);
  const delay = addsHoverCard(mutations) ? HOVER_CARD_DEBOUNCE_MS : DEBOUNCE_MS;
  debounceTimer = setTimeout(markOwnedGames, delay);
}

// Watch for dynamic store updates (scrolling/filtering)
window.addEventListener("load", () => {
  markOwnedGames();
  const observer = new MutationObserver(debouncedMarkOwned);
  observer.observe(document.body, { childList: true, subtree: true });
});

// Pick up fresh lists or settings after a sync without a page reload.
const WATCHED_KEYS = [
  "steamOwned",
  "steamOwnedDlc",
  "steamWishlist",
  "steamOwnedNames",
  "steamWishlistNames",
  "showSteamPrices",
  "steamCountry",
  "dimIgnoredGames",
  "gogCurrency",
];
browser.storage.onChanged.addListener((changes, area) => {
  // Ignore-list changes arrive via sync, including from other devices.
  const relevant =
    (area === "local" && WATCHED_KEYS.some((k) => k in changes)) ||
    ignoreListChanged(changes, area);
  if (relevant) {
    loadLists().then(() => {
      clearMarks();
      markOwnedGames();
    });
  }
});
