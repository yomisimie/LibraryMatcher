// Storage layout (browser.storage.local):
//   steamId, apiKey                    credentials from the options page
//   steamOwned, steamWishlist          { normalizedTitle: appid }
//   steamWishlistItems                 [{ appid, name }] in wishlist order
//   steamOwnedSyncedAt, steamWishlistSyncedAt   ms timestamps of last success
//   lastSyncError                      message from the last failed auto sync
//   showSteamPrices, steamCountry      price comparison settings
//   steamPriceCache                    { "cc|title": { ts, hit } }
//   dimIgnoredGames                    dim ignored tiles instead of hiding them
// browser.storage.sync (Firefox Sync, see ignore.js):
//   "ignore:<normalizedTitle>"         display title of each ignored game
// Older versions stored steamOwnedNames / steamWishlistNames arrays; those are
// removed on the next sync and content.js still reads them until then.

const SYNC_ALARM = "auto-sync";
const SYNC_CHECK_MINUTES = 60; // how often the alarm fires
const SYNC_MAX_AGE_MS = 24 * 60 * 60 * 1000; // resync lists older than this

async function getCredentials() {
  const { steamId, apiKey } = await browser.storage.local.get([
    "steamId",
    "apiKey",
  ]);
  if (!steamId || !apiKey)
    throw new Error("Missing SteamID or API key. Open Settings.");
  return { steamId, apiKey };
}

function describeHttpError(status) {
  if (status === 401 || status === 403)
    return "Steam rejected the API key or SteamID. Check Settings.";
  if (status === 429) return "Steam rate limit hit. Try again in a minute.";
  return `Steam API error (HTTP ${status}).`;
}

function addApp(map, name, appid) {
  const key = normalizeTitle(name || "");
  if (key) map[key] = appid;
}

async function syncSteamLibrary() {
  const { steamId, apiKey } = await getCredentials();
  const url = `https://api.steampowered.com/IPlayerService/GetOwnedGames/v1/?key=${apiKey}&steamid=${steamId}&include_appinfo=true&include_played_free_games=true&format=json`;

  const response = await fetch(url);
  if (!response.ok) throw new Error(describeHttpError(response.status));

  const data = await response.json();
  if (!data.response || !data.response.games)
    throw new Error(
      "No games returned. Is your game details privacy set to public?",
    );

  const owned = {};
  data.response.games.forEach((game) => addApp(owned, game.name, game.appid));

  await browser.storage.local.set({
    steamOwned: owned,
    steamOwnedSyncedAt: Date.now(),
  });
  await browser.storage.local.remove("steamOwnedNames");
  return Object.keys(owned).length;
}

async function syncWishlist() {
  const { steamId, apiKey } = await getCredentials();

  // 1. Fetch the wishlist's app IDs
  const wishlistUrl = `https://api.steampowered.com/IWishlistService/GetWishlist/v1/?steamid=${steamId}&key=${apiKey}`;
  const wishlistResponse = await fetch(wishlistUrl);
  if (!wishlistResponse.ok)
    throw new Error(describeHttpError(wishlistResponse.status));

  const wishlistData = await wishlistResponse.json();
  const appIds = (wishlistData.response?.items || []).map((i) => i.appid);

  // 2. Resolve names in batches of 100. Any failed batch rejects the whole
  // sync, so a partial list never overwrites the previously saved one.
  const wishlist = {};
  const names = {}; // appid -> original Steam title, for the wishlist page
  const chunkSize = 100;
  const batches = [];
  for (let i = 0; i < appIds.length; i += chunkSize) {
    const params = new URLSearchParams({ key: apiKey });
    appIds
      .slice(i, i + chunkSize)
      .forEach((id, index) => params.append(`appids[${index}]`, id));

    batches.push(
      fetch(
        `https://api.steampowered.com/ICommunityService/GetApps/v1/?${params}`,
      )
        .then((res) => {
          if (!res.ok) throw new Error(describeHttpError(res.status));
          return res.json();
        })
        .then((appsData) => {
          (appsData.response?.apps || []).forEach((app) => {
            addApp(wishlist, app.name, app.appid);
            if (app.name) names[app.appid] = app.name;
          });
        }),
    );
  }
  await Promise.all(batches);

  // Wishlist order (Steam returns it by priority) with display names.
  const items = appIds
    .filter((id) => names[id])
    .map((appid) => ({ appid, name: names[appid] }));

  await browser.storage.local.set({
    steamWishlist: wishlist,
    steamWishlistItems: items,
    steamWishlistSyncedAt: Date.now(),
  });
  await browser.storage.local.remove("steamWishlistNames");
  return Object.keys(wishlist).length;
}

// ---------- Automatic sync ----------

// Syncs whichever list is older than SYNC_MAX_AGE_MS. Runs shortly after the
// browser starts and then hourly, so a missed day is caught up quickly.
async function autoSyncIfStale() {
  const data = await browser.storage.local.get([
    "steamId",
    "apiKey",
    "steamOwnedSyncedAt",
    "steamWishlistSyncedAt",
  ]);
  if (!data.steamId || !data.apiKey) return;

  const now = Date.now();
  const errors = [];
  let attempted = false;

  if (!data.steamOwnedSyncedAt || now - data.steamOwnedSyncedAt > SYNC_MAX_AGE_MS) {
    attempted = true;
    await syncSteamLibrary().catch((e) => errors.push(`Library: ${e.message}`));
  }
  if (!data.steamWishlistSyncedAt || now - data.steamWishlistSyncedAt > SYNC_MAX_AGE_MS) {
    attempted = true;
    await syncWishlist().catch((e) => errors.push(`Wishlist: ${e.message}`));
  }
  if (attempted) {
    await browser.storage.local.set({
      lastSyncError: errors.length ? errors.join(" ") : null,
    });
  }
}

// Alarms don't survive a browser restart, so (re)create one whenever the
// background script loads, without resetting a timer that already exists.
browser.alarms.get(SYNC_ALARM).then((alarm) => {
  if (!alarm) {
    browser.alarms.create(SYNC_ALARM, {
      delayInMinutes: 1,
      periodInMinutes: SYNC_CHECK_MINUTES,
    });
  }
});

browser.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === SYNC_ALARM) autoSyncIfStale();
});

// ---------- Steam price lookup ----------

const PRICE_TTL_MS = 12 * 60 * 60 * 1000;
const PRICE_CACHE_MAX = 3000;
const PRICE_CONCURRENCY = 2;

let priceCache = null;
let priceCacheSaveTimer = null;
const inFlight = new Map();
const queue = [];
let active = 0;
let pausedUntil = 0;

async function loadPriceCache() {
  if (!priceCache) {
    const { steamPriceCache } = await browser.storage.local.get(
      "steamPriceCache",
    );
    priceCache = steamPriceCache || {};
  }
  return priceCache;
}

function schedulePriceCacheSave() {
  clearTimeout(priceCacheSaveTimer);
  priceCacheSaveTimer = setTimeout(() => {
    const now = Date.now();
    const fresh = Object.entries(priceCache)
      .filter(([, v]) => now - v.ts < PRICE_TTL_MS)
      .sort((a, b) => b[1].ts - a[1].ts)
      .slice(0, PRICE_CACHE_MAX);
    priceCache = Object.fromEntries(fresh);
    browser.storage.local.set({ steamPriceCache: priceCache });
  }, 2000);
}

// Small queue so a page full of tiles doesn't fire dozens of requests at once.
function enqueue(task) {
  return new Promise((resolve, reject) => {
    queue.push({ task, resolve, reject });
    pump();
  });
}

function pump() {
  while (active < PRICE_CONCURRENCY && queue.length) {
    const wait = pausedUntil - Date.now();
    if (wait > 0) {
      setTimeout(pump, wait);
      return;
    }
    const { task, resolve, reject } = queue.shift();
    active++;
    task()
      .then(resolve, reject)
      .finally(() => {
        active--;
        pump();
      });
  }
}

// Store region implied by the currency GOG shows. EUR spans many countries,
// but they share Steam's euro pricing, so any eurozone code works.
const CURRENCY_COUNTRY = {
  RON: "RO", PLN: "PL", CZK: "CZ", EUR: "DE", GBP: "GB", BRL: "BR",
  CAD: "CA", AUD: "AU", CHF: "CH", TRY: "TR", USD: "US",
};

// Settings override > GOG's currency > browser region > US.
async function getCountry(gogCurrency) {
  const { steamCountry } = await browser.storage.local.get("steamCountry");
  if (steamCountry) return steamCountry.toUpperCase();
  if (CURRENCY_COUNTRY[gogCurrency]) return CURRENCY_COUNTRY[gogCurrency];
  const region = (navigator.language || "").split("-")[1];
  return (region || "US").toUpperCase();
}

async function storeSearch(term, cc) {
  const url = `https://store.steampowered.com/api/storesearch/?term=${encodeURIComponent(term)}&l=english&cc=${cc}`;
  const res = await fetch(url);
  if (res.status === 429) {
    pausedUntil = Date.now() + 60 * 1000;
    throw new Error("rate limited");
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  return (data.items || []).filter((i) => i.type === "app");
}

function toHit(item, exact) {
  return {
    appid: item.id,
    name: item.name,
    // false when only the base title matched (e.g. GOG sells an Ultimate
    // edition and Steam the base game), so prices aren't directly comparable.
    exact,
    price: item.price
      ? {
          currency: item.price.currency,
          initial: item.price.initial,
          final: item.price.final,
        }
      : null,
  };
}

// Steam's search often finds nothing for full edition names, so retry with
// the base title. Only results whose name really is this game are accepted.
async function searchSteamStore(title, cc) {
  const wanted = normalizeTitle(title);
  const wantedBase = baseTitle(wanted);
  const terms = [title];
  if (wantedBase !== wanted) terms.push(wantedBase);

  let baseMatch = null;
  for (const term of terms) {
    const items = await storeSearch(term, cc);
    const exact = items.find((i) => normalizeTitle(i.name) === wanted);
    if (exact) return toHit(exact, true);
    baseMatch ||= items.find(
      (i) => baseTitle(normalizeTitle(i.name)) === wantedBase,
    );
  }
  return baseMatch ? toHit(baseMatch, false) : null;
}

// ---------- Currency conversion (ECB rates via frankfurter.dev) ----------

const RATE_TTL_MS = 24 * 60 * 60 * 1000;
const rateRequests = new Map();

async function getRates(base) {
  const { exchangeRates = {} } = await browser.storage.local.get(
    "exchangeRates",
  );
  const cached = exchangeRates[base];
  if (cached && Date.now() - cached.ts < RATE_TTL_MS) return cached.rates;

  if (!rateRequests.has(base)) {
    const p = fetch(`https://api.frankfurter.dev/v1/latest?from=${base}`)
      .then((res) => (res.ok ? res.json() : Promise.reject(res.status)))
      .then(async (data) => {
        const { exchangeRates: latest = {} } = await browser.storage.local.get(
          "exchangeRates",
        );
        latest[base] = { ts: Date.now(), rates: data.rates };
        await browser.storage.local.set({ exchangeRates: latest });
        return data.rates;
      })
      .catch(() => null)
      .finally(() => rateRequests.delete(base));
    rateRequests.set(base, p);
  }
  return rateRequests.get(base);
}

// Converts an amount in cents; returns null if the pair isn't supported.
async function convertCents(cents, from, to) {
  if (from === to) return cents;
  const rates = await getRates(from);
  const rate = rates?.[to];
  return rate ? Math.round(cents * rate) : null;
}

// Price for a known appid (wishlisted games), no name matching needed.
async function fetchAppPrice(appid, cc) {
  const url = `https://store.steampowered.com/api/appdetails?appids=${appid}&cc=${cc}&filters=price_overview`;
  const res = await fetch(url);
  if (res.status === 429) {
    pausedUntil = Date.now() + 60 * 1000;
    throw new Error("rate limited");
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  const p = data[appid]?.data?.price_overview;
  return {
    appid,
    name: null,
    exact: true,
    price: p ? { currency: p.currency, initial: p.initial, final: p.final } : null,
  };
}

async function lookupSteamPriceIn(title, gogCurrency, appid) {
  const hit = await lookupSteamPrice(title, appid, gogCurrency);
  if (!hit?.price || !gogCurrency) return hit;
  const converted = await convertCents(
    hit.price.final,
    hit.price.currency,
    gogCurrency,
  );
  return { ...hit, converted, convertedCurrency: gogCurrency };
}

async function lookupSteamPrice(title, appid, gogCurrency) {
  const cc = await getCountry(gogCurrency);
  const key = appid ? `${cc}|app:${appid}` : `${cc}|${normalizeTitle(title)}`;
  const cache = await loadPriceCache();
  const cached = cache[key];
  if (cached && Date.now() - cached.ts < PRICE_TTL_MS) return cached.hit;

  if (!inFlight.has(key)) {
    const p = enqueue(() =>
      appid ? fetchAppPrice(appid, cc) : searchSteamStore(title, cc),
    )
      .then((hit) => {
        cache[key] = { ts: Date.now(), hit };
        schedulePriceCacheSave();
        return hit;
      })
      .catch(() => null) // network/rate-limit errors aren't cached
      .finally(() => inFlight.delete(key));
    inFlight.set(key, p);
  }
  return inFlight.get(key);
}

// ---------- Ignored games ----------

// Before Firefox Sync support the ignore list was one local "ignoredGames"
// object; move it into per-game sync keys (see ignore.js) and drop it.
async function migrateIgnoredGames() {
  const { ignoredGames } = await browser.storage.local.get("ignoredGames");
  if (!ignoredGames) return;
  const entries = Object.entries(ignoredGames);
  if (entries.length) {
    await browser.storage.sync.set(
      Object.fromEntries(entries.map(([k, v]) => ["ignore:" + k, v])),
    );
  }
  await browser.storage.local.remove("ignoredGames");
}
migrateIgnoredGames().catch((err) => console.error("Ignore list migration failed:", err));

// Right-click "Ignore" item on GOG pages: GOG's hover card covers the tile's
// ✕ button. The content script works out which game was right-clicked.
const IGNORE_MENU = "slm-ignore";

async function createMenus() {
  await browser.menus.removeAll();
  browser.menus.create({
    id: IGNORE_MENU,
    title: "Ignore this game on GOG",
    contexts: ["link", "image", "page"],
    documentUrlPatterns: ["https://*.gog.com/*"],
  });
}
// Menus persist with the event page, so creating them on install and browser
// start is enough.
browser.runtime.onInstalled.addListener(createMenus);
browser.runtime.onStartup.addListener(createMenus);

// Menu labels treat "&" as an access key marker.
const menuLabel = (title) =>
  (title.length > 50 ? title.slice(0, 49) + "…" : title).replace(/&/g, "&&");

let menuShownId = 0;
browser.menus.onShown.addListener(async (info, tab) => {
  // Not info.menuIds: it leaves out our item while it's hidden, so a hidden
  // item would never come back. pageUrl is readable thanks to the GOG host
  // permission.
  if (!tab?.id || !/^https:\/\/([^/]+\.)?gog\.com\//.test(info.pageUrl || "")) return;
  const shownId = ++menuShownId;
  let target = null;
  try {
    target = await browser.tabs.sendMessage(
      tab.id,
      { action: "slm_menu_target", targetElementId: info.targetElementId },
      { frameId: info.frameId },
    );
  } catch {
    // No content script in this frame (e.g. a GOG page loaded before install).
  }
  if (shownId !== menuShownId) return; // the menu was closed and reopened meanwhile
  await browser.menus.update(IGNORE_MENU, {
    visible: !!target,
    title: target
      ? `${target.ignored ? "Unignore" : "Ignore"} "${menuLabel(target.title)}"`
      : "Ignore this game on GOG",
  });
  browser.menus.refresh();
});

browser.menus.onHidden.addListener(() => {
  menuShownId++;
});

browser.menus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== IGNORE_MENU || !tab?.id) return;
  browser.tabs
    .sendMessage(
      tab.id,
      { action: "slm_menu_toggle", targetElementId: info.targetElementId },
      { frameId: info.frameId },
    )
    .catch((err) => console.warn("Ignore from menu failed:", err));
});

// ---------- Messaging ----------

// Open the setup tab automatically upon first installation
browser.runtime.onInstalled.addListener((details) => {
  if (details.reason === "install") {
    browser.runtime.openOptionsPage();
  }
});

function respond(promise) {
  return promise
    .then(async (count) => {
      await browser.storage.local.set({ lastSyncError: null });
      return { success: true, count };
    })
    .catch((err) => {
      console.error("Sync error:", err);
      return { success: false, message: err.message };
    });
}

// Returning a promise keeps the message channel open for the async reply.
browser.runtime.onMessage.addListener((message) => {
  if (message.action === "force_sync") return respond(syncSteamLibrary());
  if (message.action === "sync_wishlist") return respond(syncWishlist());
  if (message.action === "steam_price")
    return lookupSteamPriceIn(message.title, message.gogCurrency, message.appid);
});
