// Storage layout (browser.storage.local):
//   steamId, apiKey                    apiKey optional; without one, steamId
//                                      is detected from the Steam store
//                                      session (see getCredentials)
//   steamOwned, steamWishlist          { normalizedTitle: appid }
//   steamOwnedDlc                      same, owned DLC (only known without an
//                                      API key: GetOwnedGames has no DLC)
//   steamWishlistItems                 [{ appid, name }] in wishlist order
//   steamOwnedSyncedAt, steamWishlistSyncedAt   ms timestamps of last success
//   lastSyncError                      message from the last failed auto sync
//   showSteamPrices, steamCountry      price comparison settings
//   gogCurrency                        currency code for GOG prices shown
//                                      without one ("" = auto)
//   gogCurrencyDetected                last currency seen in a GOG price
//   steamPriceCache                    { "cc|title": { ts, hit } }
//   steamAppInfo                       { appid: { year, companies } }, Steam
//                                      release year (0 = none) and developers
//                                      + publishers; see differentGames()
//   gogTitleInfo                       { titleKey: { year, companies } | null },
//                                      the same for GOG games, by title
//   exchangeRates                      { base: { ts, rates } }, ECB rates
//   gogSearchCache                     { "country|currency|title": { ts, hit } },
//                                      wishlist.js's GOG matches
//   (CACHE_KEYS lists the caches Settings can clear.)
//   dimIgnoredGames                   dim ignored tiles instead of hiding them
// browser.storage.sync (Firefox Sync, see ignore.js):
//   "ignore:<normalizedTitle>"         display title of each ignored game
// Older versions stored steamOwnedNames / steamWishlistNames arrays; those are
// removed on the next sync and content.js still reads them until then.

const SYNC_ALARM = "auto-sync";
const SYNC_CHECK_MINUTES = 60; // how often the alarm fires
const SYNC_MAX_AGE_MS = 24 * 60 * 60 * 1000; // resync lists older than this

const NOT_SIGNED_IN =
  "Not signed in to the Steam store in Firefox. Sign in at store.steampowered.com, then sync again.";

// SteamID of the account signed in to the Steam store in this Firefox
// profile, or null. Our host permission makes the request carry the store's
// cookies. Every store page embeds data-userinfo for Steam's own scripts,
// with the SteamID when signed in; /about/ is one of the lightest. (The
// store's webapi_token would also give the SteamID, but we'd rather not
// touch an account token just for that.)
async function getStoreSteamId() {
  try {
    const res = await fetch("https://store.steampowered.com/about/", {
      credentials: "include",
      cache: "no-store",
    });
    if (!res.ok) return null;
    const doc = new DOMParser().parseFromString(await res.text(), "text/html");
    const raw = doc.querySelector("[data-userinfo]")?.dataset.userinfo;
    const steamid = raw ? JSON.parse(raw).steamid : null;
    return /^\d{17}$/.test(steamid || "") ? steamid : null;
  } catch {
    return null;
  }
}

// With an API key the SteamID comes from Settings. Without one it comes from
// the Steam store session (and is saved, so the popup and auto sync know
// setup is done); a saved SteamID still covers a public wishlist when the
// session is gone.
async function getCredentials() {
  const { steamId, apiKey } = await browser.storage.local.get([
    "steamId",
    "apiKey",
  ]);
  if (apiKey) {
    if (!steamId)
      throw new Error("An API key needs your SteamID64 too. Open Settings.");
    return { steamId, apiKey };
  }
  const detected = await getStoreSteamId();
  if (detected) {
    if (detected !== steamId)
      await browser.storage.local.set({ steamId: detected });
    return { steamId: detected, apiKey: "" };
  }
  if (steamId) return { steamId, apiKey: "" };
  throw new Error(NOT_SIGNED_IN);
}

function describeHttpError(status) {
  // Keyless calls answer 400 for a malformed SteamID.
  if (status === 400) return "Steam didn't accept the SteamID. Check Settings.";
  if (status === 401 || status === 403)
    return "Steam rejected the API key or SteamID. Check Settings.";
  if (status === 429) return "Steam rate limit hit. Try again in a minute.";
  return `Steam API error (HTTP ${status}).`;
}

function addApp(map, name, appid) {
  const key = normalizeTitle(name || "");
  if (key) map[key] = appid;
}

// Steam's EAppType values we care about.
const APP_GAME = 1;
const APP_SOFTWARE = 2;
const APP_DLC = 32;

// Resolves app IDs to { name, type }, 100 per request (GetApps works without
// a key). A few batches at a time, since a big library is thousands of apps.
// Any failed batch rejects, so a partial list never overwrites the saved one.
async function fetchApps(appIds, apiKey) {
  const chunkSize = 100;
  const chunks = [];
  for (let i = 0; i < appIds.length; i += chunkSize)
    chunks.push(appIds.slice(i, i + chunkSize));

  const apps = {}; // appid -> { name, type }
  const fetchChunk = async (ids) => {
    const params = new URLSearchParams();
    if (apiKey) params.set("key", apiKey);
    ids.forEach((id, index) => params.append(`appids[${index}]`, id));
    const res = await fetch(
      `https://api.steampowered.com/ICommunityService/GetApps/v1/?${params}`,
    );
    if (!res.ok) throw new Error(describeHttpError(res.status));
    const data = await res.json();
    (data.response?.apps || []).forEach((app) => {
      if (app.name) apps[app.appid] = { name: app.name, type: app.app_type };
    });
  };
  const worker = async () => {
    while (chunks.length) await fetchChunk(chunks.shift());
  };
  await Promise.all(Array.from({ length: 4 }, worker));
  return apps;
}

async function fetchOwnedWithKey(steamId, apiKey) {
  const url = `https://api.steampowered.com/IPlayerService/GetOwnedGames/v1/?key=${apiKey}&steamid=${steamId}&include_appinfo=true&include_played_free_games=true&format=json`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(describeHttpError(response.status));

  const data = await response.json();
  if (!data.response || !data.response.games)
    throw new Error(
      "No games returned. Is your game details privacy set to public?",
    );
  // GetOwnedGames has no DLC.
  return { games: data.response.games, dlc: [] };
}

// Without a key, GetOwnedGames answers 401 and Steam's community games page
// redirects anonymous visitors to sign-in, even for public profiles. The
// store's userdata endpoint lists owned apps for whoever is signed in to the
// Steam store in this Firefox profile (the host permission sends its cookies).
async function fetchOwnedWithoutKey() {
  const response = await fetch(
    "https://store.steampowered.com/dynamicstore/userdata/",
    { credentials: "include", cache: "no-store" },
  );
  if (!response.ok) throw new Error(describeHttpError(response.status));
  const data = await response.json();
  const appIds = data.rgOwnedApps || [];
  // Signed out, Steam still answers 200, just with empty lists.
  if (!appIds.length) throw new Error(NOT_SIGNED_IN);
  // rgOwnedApps is every app in the user's licenses, including soundtracks,
  // tools and demos. Games and software match what GetOwnedGames returns;
  // DLC is kept apart so GOG's DLC tiles can be marked too.
  const apps = await fetchApps(appIds, "");
  const games = [];
  const dlc = [];
  for (const appid of appIds) {
    const app = apps[appid];
    if (!app) continue;
    if (app.type === APP_GAME || app.type === APP_SOFTWARE)
      games.push({ appid, name: app.name });
    else if (app.type === APP_DLC) dlc.push({ appid, name: app.name });
  }
  return { games, dlc };
}

// Resolves to { games, dlc } counts.
async function syncSteamLibrary() {
  const { steamId, apiKey } = await getCredentials();
  const { games, dlc } = apiKey
    ? await fetchOwnedWithKey(steamId, apiKey)
    : await fetchOwnedWithoutKey();

  const owned = {};
  games.forEach((game) => addApp(owned, game.name, game.appid));
  const ownedDlc = {};
  dlc.forEach((d) => addApp(ownedDlc, d.name, d.appid));

  await browser.storage.local.set({
    steamOwned: owned,
    steamOwnedDlc: ownedDlc,
    steamOwnedSyncedAt: Date.now(),
  });
  await browser.storage.local.remove("steamOwnedNames");
  return {
    games: Object.keys(owned).length,
    dlc: Object.keys(ownedDlc).length,
  };
}

async function syncWishlist() {
  const { steamId, apiKey } = await getCredentials();

  // 1. Fetch the wishlist's app IDs. A public wishlist needs no key.
  const params = new URLSearchParams({ steamid: steamId });
  if (apiKey) params.set("key", apiKey);
  const wishlistResponse = await fetch(
    `https://api.steampowered.com/IWishlistService/GetWishlist/v1/?${params}`,
  );
  if (!wishlistResponse.ok)
    throw new Error(describeHttpError(wishlistResponse.status));

  const wishlistData = await wishlistResponse.json();
  const appIds = (wishlistData.response?.items || []).map((i) => i.appid);

  // 2. Resolve names (original Steam titles, also shown on the wishlist page).
  const apps = await fetchApps(appIds, apiKey);
  const names = Object.fromEntries(
    Object.entries(apps).map(([appid, app]) => [appid, app.name]),
  );
  const wishlist = {};
  appIds.forEach((appid) => addApp(wishlist, names[appid], appid));

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
  if (!data.steamId) return;

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
// A GOG title with a year ("DOOM (2016)") is also tried without it, but such a
// result only counts when its Steam release year agrees: Steam's "DOOM" is
// the 2016 game, not GOG's "DOOM (1993)". Steam can also have several games
// of one name ("Screamer" from 1995 and from 2026); differentGames() picks
// the one GOG sells.
async function searchSteamStore(title, cc) {
  const normalized = normalizeTitle(title);
  const { title: undated, year } = splitYear(title);
  const terms = [title];
  if (baseTitle(normalized) !== normalized) terms.push(baseTitle(normalized));
  if (year) terms.push(undated);
  // Compared as titleKey, so "DOOM II" matches "Doom 2".
  const wanted = titleKey(normalized);
  const wantedBase = baseTitle(wanted);
  const wantedUndated = year ? titleKey(normalizeTitle(undated)) : null;

  let gogInfo;
  const getGog = () => (gogInfo ||= getGogInfo([title]).then((r) => r[wanted]));
  // First candidate that isn't a different game of the same name.
  const pick = async (items, fits = () => true) => {
    if (!items.length) return null;
    const [gog, steam] = await Promise.all([
      getGog(),
      getSteamInfo(items.map((i) => i.id)),
    ]);
    return (
      items.find((i) => fits(steam[i.id]) && !differentGames(gog, steam[i.id])) ||
      null
    );
  };

  const exact = [];
  const base = [];
  const dated = { exact: [], base: [] }; // undated-name candidates
  const seen = new Set();
  for (const term of terms) {
    const items = (await storeSearch(term, cc)).filter((i) => !seen.has(i.id));
    items.forEach((i) => seen.add(i.id));
    const key = (i) => titleKey(normalizeTitle(i.name));
    const found = items.filter((i) => key(i) === wanted);
    if (found.length) {
      exact.push(...found);
      const hit = await pick(exact);
      if (hit) return toHit(hit, true);
    }
    base.push(...items.filter((i) => baseTitle(key(i)) === wantedBase));
    if (!year) continue;
    for (const i of items) {
      const name = key(i);
      if (name === wantedUndated) dated.exact.push(i);
      else if (baseTitle(name) === baseTitle(wantedUndated)) dated.base.push(i);
    }
  }
  const fitsYear = (info) => sameYear(info?.year, year);
  const datedExact = await pick(dated.exact, fitsYear);
  if (datedExact) return toHit(datedExact, true);
  const baseHit = (await pick(base)) || (await pick(dated.base, fitsYear));
  return baseHit ? toHit(baseHit, false) : null;
}

// ---------- Game details for telling same-named games apart ----------

// Permanent caches in storage.local, keyed by Steam appid or GOG title key:
// release years and companies don't change, so each game is looked up once.
// Writes are serialized so parallel lookups don't overwrite each other.
let infoWrite = Promise.resolve();

async function cachedInfo(storageKey, keys, fetchMissing) {
  const { [storageKey]: cache = {} } = await browser.storage.local.get(storageKey);
  const missing = [...new Set(keys.map(String))].filter((k) => !(k in cache));
  const fetched = missing.length ? await fetchMissing(missing) : {};
  if (Object.keys(fetched).length) {
    infoWrite = infoWrite.then(async () => {
      const { [storageKey]: latest = {} } = await browser.storage.local.get(storageKey);
      await browser.storage.local.set({ [storageKey]: { ...latest, ...fetched } });
    });
    await infoWrite;
  }
  const all = { ...cache, ...fetched };
  return Object.fromEntries(keys.filter((k) => k in all).map((k) => [k, all[k]]));
}

// Steam apps: { year, companies }, year 0 when Steam has no date (unreleased).
// The original release date wins over the Steam one, so a 1993 classic
// re-released on Steam in 2007 counts as 1993.
async function fetchSteamInfo(appids) {
  const input = {
    ids: appids.map((appid) => ({ appid: Number(appid) })),
    context: { language: "english", country_code: "US" },
    data_request: { include_release: true, include_basic_info: true },
  };
  const params = new URLSearchParams({ input_json: JSON.stringify(input) });
  const res = await fetch(
    `https://api.steampowered.com/IStoreBrowseService/GetItems/v1/?${params}`,
  );
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  const info = {};
  for (const item of data.response?.store_items || []) {
    if (!item.appid) continue;
    const secs =
      Number(item.release?.original_release_date) ||
      Number(item.release?.steam_release_date);
    const basic = item.basic_info || {};
    info[item.appid] = {
      year: secs ? new Date(secs * 1000).getUTCFullYear() : 0,
      companies: [...(basic.developers || []), ...(basic.publishers || [])]
        .map((c) => c.name)
        .filter(Boolean),
    };
  }
  return info;
}

// Resolves to { appid: { year, companies } } (missing on failure).
function getSteamInfo(appids) {
  return cachedInfo("steamAppInfo", appids, async (missing) => {
    const info = {};
    for (let i = 0; i < missing.length; i += 100) {
      try {
        Object.assign(info, await fetchSteamInfo(missing.slice(i, i + 100)));
      } catch (err) {
        console.warn("Steam app details failed:", err);
      }
    }
    return info;
  });
}

// GOG games by title: { year, companies }, null when GOG's catalog has no
// game of exactly that title. Tiles don't carry product IDs and the catalog
// can't look up several slugs at once, so it's one search per title.
async function fetchGogInfo(title) {
  const params = new URLSearchParams({
    limit: "10",
    query: `like:${title.replace(/[™®©℠]/g, "").trim()}`,
    order: "desc:score",
    productType: "in:game,pack",
    countryCode: "US",
    currencyCode: "USD",
    locale: "en-US",
  });
  const res = await fetch(`https://catalog.gog.com/v1/catalog?${params}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  const wanted = titleKey(normalizeTitle(title));
  const product = (data.products || []).find(
    (p) => titleKey(normalizeTitle(p.title)) === wanted,
  );
  return product ? gogProductInfo(product) : null;
}

// Resolves to { titleKey: info | null } for raw GOG titles (missing on failure).
async function getGogInfo(titles) {
  const byKey = new Map(titles.map((t) => [titleKey(normalizeTitle(t)), t]));
  return cachedInfo("gogTitleInfo", [...byKey.keys()], async (missing) => {
    const info = {};
    const queue = [...missing];
    const worker = async () => {
      while (queue.length) {
        const key = queue.shift();
        try {
          info[key] = await fetchGogInfo(byKey.get(key));
        } catch (err) {
          console.warn("GOG catalog lookup failed:", err);
        }
      }
    };
    await Promise.all(Array.from({ length: 3 }, worker));
    return info;
  });
}

// Settings' "Clear cached data": every lookup cache, not the synced lists.
const CACHE_KEYS = [
  "steamPriceCache",
  "steamAppInfo",
  "gogTitleInfo",
  "gogSearchCache",
  "exchangeRates",
];

async function clearCaches() {
  clearTimeout(priceCacheSaveTimer); // a pending save would bring prices back
  priceCache = null;
  await infoWrite;
  await browser.storage.local.remove(CACHE_KEYS);
}

// 0.4.1 cached release years alone; steamAppInfo replaces it.
browser.storage.local.remove("steamReleaseYears");

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
  if (message.action === "steam_session") return getStoreSteamId();
  if (message.action === "steam_price")
    return lookupSteamPriceIn(message.title, message.gogCurrency, message.appid);
  if (message.action === "steam_info") return getSteamInfo(message.appids || []);
  if (message.action === "gog_info") return getGogInfo(message.titles || []);
  if (message.action === "clear_cache") return clearCaches();
});
