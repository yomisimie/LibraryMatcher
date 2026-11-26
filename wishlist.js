// "Steam wishlist on GOG" page: matches the synced Steam wishlist against
// GOG's public catalog, compares prices, and adds games to the GOG wishlist
// using the browser's GOG login.

const GOG_SEARCH_TTL_MS = 6 * 60 * 60 * 1000;
const GOG_CONCURRENCY = 3;

const rowsEl = document.getElementById("rows");
const progressEl = document.getElementById("progress");
const addAllBtn = document.getElementById("addAllBtn");
const refreshBtn = document.getElementById("refreshBtn");

let gogUser = { loggedIn: false, country: "US", currency: "USD", owned: new Set(), wishlist: new Set() };
let rows = [];
let filter = "all";
let searchCache = {};
let cacheDirty = false;

// ---------- GOG API ----------

async function gogJson(url) {
  // credentials: include sends the browser's GOG login cookies.
  const res = await fetch(url, { credentials: "include" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function loadGogUser() {
  try {
    const data = await gogJson("https://embed.gog.com/userData.json");
    gogUser.country = data.country || "US";
    gogUser.currency = data.selectedCurrency?.code || "USD";
    gogUser.loggedIn = !!data.isLoggedIn;
  } catch (err) {
    console.warn("GOG userData failed:", err);
  }
  if (!gogUser.loggedIn) return;

  const [games, wishlist] = await Promise.allSettled([
    gogJson("https://embed.gog.com/user/data/games"),
    gogJson("https://embed.gog.com/user/wishlist.json"),
  ]);
  if (games.status === "fulfilled") {
    gogUser.owned = new Set((games.value.owned || []).map(String));
  }
  if (wishlist.status === "fulfilled") {
    gogUser.wishlist = new Set(
      Object.entries(wishlist.value.wishlist || {})
        .filter(([, on]) => on)
        .map(([id]) => String(id)),
    );
  }
}

async function catalogSearch(term) {
  const params = new URLSearchParams({
    limit: "10",
    query: `like:${term}`,
    order: "desc:score",
    productType: "in:game,pack",
    countryCode: gogUser.country,
    currencyCode: gogUser.currency,
    locale: "en-US",
  });
  const data = await gogJson(`https://catalog.gog.com/v1/catalog?${params}`);
  return data.products || [];
}

// exact: same title. possible: a GOG title that merely starts with the Steam
// title (e.g. a remaster), shown for the user to check, never auto-added.
function toGogHit(p, exact, possible = false) {
  return {
    id: String(p.id),
    title: p.title,
    link: p.storeLink,
    exact,
    possible,
    priceText: p.price?.final || null,
    discount: p.price?.discount || null,
    amount: p.price?.finalMoney ? parseFloat(p.price.finalMoney.amount) : null,
    currency: p.price?.finalMoney?.currency || null,
  };
}

// Same matching rules as the store badges: exact normalized title first,
// then the edition-stripped base title (preferring games over packs).
// getYear resolves to the Steam game's release year; it's only asked for
// when GOG has the title with a year, e.g. "DOOM (2016)" for Steam's "DOOM".
async function pickMatch(products, steamName, getYear) {
  const want = normalizeTitle(steamName);
  const wantBase = baseTitle(want);
  const exact = products.find((p) => normalizeTitle(p.title) === want);
  if (exact) return toGogHit(exact, true);
  // Prefer games over packs, then the shortest (least extra) title.
  const rank = (a, b) =>
    (a.productType === "game" ? 0 : 1) - (b.productType === "game" ? 0 : 1) ||
    a.title.length - b.title.length;

  const dated = products.filter((p) => {
    const { title, year } = splitYear(p.title);
    return year && normalizeTitle(title) === want;
  });
  if (dated.length) {
    const steamYear = await getYear();
    const same = dated.find((p) => sameYear(splitYear(p.title).year, steamYear));
    if (same) return toGogHit(same, true);
  }

  const loose = products
    .filter((p) => baseTitle(normalizeTitle(p.title)) === wantBase)
    .sort(rank);
  if (loose[0]) return toGogHit(loose[0], false);

  const prefixed = products
    .filter((p) => normalizeTitle(p.title).startsWith(want + " "))
    .sort(rank);
  return prefixed[0] ? toGogHit(prefixed[0], false, true) : null;
}

async function findOnGog(steamName, appid) {
  const key = `${gogUser.country}|${gogUser.currency}|${normalizeTitle(steamName)}`;
  const cached = searchCache[key];
  if (cached && Date.now() - cached.ts < GOG_SEARCH_TTL_MS) return cached.hit;

  const clean = steamName.replace(/[™®©℠]/g, "").trim();
  const terms = [clean];
  const base = baseTitle(normalizeTitle(steamName));
  if (base !== normalizeTitle(steamName)) terms.push(base);

  let yearRequest = null;
  const getYear = () =>
    (yearRequest ||= browser.runtime
      .sendMessage({ action: "release_years", appids: [appid] })
      .then((years) => years?.[appid] || null)
      .catch(() => null));

  let best = null;
  for (const term of terms) {
    const hit = await pickMatch(await catalogSearch(term), steamName, getYear);
    if (hit?.exact) {
      best = hit;
      break;
    }
    best ||= hit;
  }
  searchCache[key] = { ts: Date.now(), hit: best };
  cacheDirty = true;
  return best;
}

async function addToGogWishlist(id) {
  const res = await fetch(`https://embed.gog.com/user/wishlist/add/${id}`, {
    credentials: "include",
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  // The response is the updated wishlist; confirm the game is in it if present.
  const data = await res.json().catch(() => null);
  if (data?.wishlist && !data.wishlist[id]) throw new Error("not added");
}

// ---------- Formatting ----------

function formatMoney(cents, currency) {
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency }).format(cents / 100);
  } catch {
    return `${(cents / 100).toFixed(2)} ${currency}`;
  }
}

// Formats a value like a GOG price string, e.g. ("19,85 lei", 80.19) -> "80,19 lei".
function formatLike(sample, value) {
  const m = sample.match(/\d[\d.,\s ]*\d|\d/);
  if (!m) return null;
  const decimal = /,\d{2}$/.test(m[0]) ? "," : ".";
  const group = decimal === "," ? "." : ",";
  const [int, frac] = value.toFixed(2).split(".");
  return sample
    .replace(m[0], `${int.replace(/\B(?=(\d{3})+(?!\d))/g, group)}${decimal}${frac}`)
    .trim();
}

// ---------- Row state ----------

function categoryOf(row) {
  const done = row.gog && (gogUser.owned.has(row.gog.id) || gogUser.wishlist.has(row.gog.id));
  return {
    ongog: !!row.gog,
    notongog: row.state === "notfound",
    done: !!done,
    addable: !!row.gog && !done && gogUser.loggedIn,
  };
}

function isVisible(row) {
  if (filter === "all") return true;
  return categoryOf(row)[filter];
}

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  Object.assign(node, props);
  node.append(...children.filter((c) => c != null));
  return node;
}

function renderRow(row) {
  const tr = row.tr || (row.tr = document.createElement("tr"));
  tr.replaceChildren();
  const cat = categoryOf(row);
  tr.className = cat.done ? "dim" : "";
  tr.hidden = !isVisible(row);

  // Steam title
  tr.appendChild(
    el(
      "td",
      { className: "title" },
      el("a", {
        href: `https://store.steampowered.com/app/${row.appid}/`,
        target: "_blank",
        rel: "noopener",
        textContent: row.name,
      }),
    ),
  );

  // GOG match
  const gogTd = el("td", { className: "gog-title" });
  if (row.state === "searching" || row.state === "queued") {
    gogTd.append(el("span", { className: "muted", textContent: "Searching…" }));
  } else if (row.state === "error") {
    gogTd.append(el("span", { className: "status-err", textContent: "Search failed" }));
  } else if (!row.gog) {
    gogTd.append(el("span", { className: "muted", textContent: "Not on GOG" }));
  } else {
    gogTd.append(
      el("a", { href: row.gog.link, target: "_blank", rel: "noopener", textContent: row.gog.title }),
    );
    if (row.gog.possible) {
      gogTd.append(
        el("span", {
          className: "tag tag-edition",
          textContent: "possible match, check",
          title: "No exact match on GOG; this is the closest title. Open it to check before adding.",
        }),
      );
    } else if (!row.gog.exact) {
      gogTd.append(
        el("span", {
          className: "tag tag-edition",
          textContent: "different edition",
          title: "GOG sells a different edition than the one on your Steam wishlist.",
        }),
      );
    }
  }
  tr.appendChild(gogTd);

  // GOG price
  const gogPriceTd = el("td");
  if (row.gog?.priceText) {
    gogPriceTd.append(el("span", { className: "price", textContent: row.gog.priceText }));
    if (row.gog.discount) {
      gogPriceTd.append(el("span", { className: "tag tag-discount", textContent: row.gog.discount }));
    }
  } else if (row.gog) {
    gogPriceTd.append(el("span", { className: "muted", textContent: "—" }));
  }
  tr.appendChild(gogPriceTd);

  // Steam price (converted to GOG's currency when they differ)
  const steamTd = el("td", { className: "col-steam" });
  const sp = row.steam?.price;
  if (sp) {
    steamTd.append(el("span", { className: "price", textContent: formatMoney(sp.final, sp.currency) }));
    if (sp.initial > sp.final) {
      const pct = Math.round((1 - sp.final / sp.initial) * 100);
      steamTd.append(el("span", { className: "tag tag-discount", textContent: `-${pct}%` }));
    }
    if (row.steam.converted != null && row.steam.convertedCurrency !== sp.currency) {
      const conv = row.gog?.priceText
        ? formatLike(row.gog.priceText, row.steam.converted / 100)
        : formatMoney(row.steam.converted, row.steam.convertedCurrency);
      steamTd.append(el("div", { className: "muted", textContent: `≈ ${conv}` }));
    }
  } else if (row.steam) {
    steamTd.append(el("span", { className: "muted", textContent: "—" }));
  }
  tr.appendChild(steamTd);

  // Verdict
  const bestTd = el("td", { className: "col-best" });
  if (row.gog?.exact && row.gog.amount != null && row.steam?.converted != null) {
    const steamValue = row.steam.converted / 100;
    const diff = (steamValue - row.gog.amount) / Math.max(steamValue, row.gog.amount);
    const pct = Math.round(Math.abs(diff) * 100);
    if (pct < 1) bestTd.append(el("span", { className: "muted", textContent: "Same" }));
    else if (diff > 0) bestTd.append(el("span", { className: "best-gog", textContent: `GOG −${pct}%` }));
    else bestTd.append(el("span", { className: "best-steam", textContent: `Steam −${pct}%` }));
  }
  tr.appendChild(bestTd);

  // Action / status
  const actionTd = el("td");
  if (row.gog) {
    if (gogUser.owned.has(row.gog.id)) {
      actionTd.append(el("span", { className: "status-ok", textContent: "✓ Owned on GOG" }));
    } else if (gogUser.wishlist.has(row.gog.id)) {
      actionTd.append(el("span", { className: "status-ok", textContent: "✓ On GOG wishlist" }));
    } else if (gogUser.loggedIn) {
      const btn = el("button", {
        className: "btn-primary",
        textContent: row.adding ? "Adding…" : "+ GOG wishlist",
        disabled: !!row.adding,
      });
      btn.addEventListener("click", () => addRow(row));
      actionTd.append(btn);
      if (row.addError) actionTd.append(el("div", { className: "status-err", textContent: row.addError }));
    }
  }
  tr.appendChild(actionTd);
  return tr;
}

function updateToolbar() {
  const done = rows.filter((r) => r.state !== "queued" && r.state !== "searching").length;
  const found = rows.filter((r) => r.gog).length;
  const addableExact = rows.filter((r) => categoryOf(r).addable && r.gog.exact && !r.adding);
  if (done < rows.length) {
    progressEl.textContent = `Searching GOG… ${done} of ${rows.length}`;
  } else {
    const already = rows.filter((r) => categoryOf(r).done).length;
    const canAdd = rows.filter((r) => categoryOf(r).addable).length;
    progressEl.textContent =
      `${rows.length} games on your Steam wishlist · ${found} on GOG · ` +
      `${already} already on your GOG wishlist or owned · ${canAdd} can be added`;
  }
  addAllBtn.disabled = addableExact.length === 0;
  addAllBtn.textContent = addableExact.length
    ? `+ Add ${addableExact.length} to GOG wishlist`
    : "+ Add all to GOG wishlist";
  addAllBtn.title =
    "Adds exact matches only. Different editions are left for you to add individually.";
}

function refreshAll() {
  rows.forEach(renderRow);
  updateToolbar();
}

// ---------- Actions ----------

async function addRow(row) {
  row.adding = true;
  row.addError = null;
  renderRow(row);
  updateToolbar();
  try {
    await addToGogWishlist(row.gog.id);
    gogUser.wishlist.add(row.gog.id);
  } catch (err) {
    console.error("Add to GOG wishlist failed:", err);
    row.addError = "Couldn't add. Are you still logged in to GOG?";
  }
  row.adding = false;
  renderRow(row);
  updateToolbar();
}

addAllBtn.addEventListener("click", async () => {
  const targets = rows.filter((r) => categoryOf(r).addable && r.gog.exact && !r.adding);
  if (!targets.length) return;
  if (!confirm(`Add ${targets.length} games to your GOG wishlist?`)) return;
  addAllBtn.disabled = true;
  for (const row of targets) {
    await addRow(row); // one at a time to be gentle with GOG
  }
  updateToolbar();
});

document.getElementById("filters").addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-filter]");
  if (!btn) return;
  filter = btn.dataset.filter;
  document
    .querySelectorAll("#filters button")
    .forEach((b) => b.classList.toggle("active", b === btn));
  rows.forEach((r) => (r.tr.hidden = !isVisible(r)));
});

refreshBtn.addEventListener("click", async () => {
  refreshBtn.disabled = true;
  refreshBtn.textContent = "Syncing…";
  const res = await browser.runtime.sendMessage({ action: "sync_wishlist" }).catch(() => null);
  if (!res?.success) {
    alert(res?.message || "Steam wishlist sync failed.");
    refreshBtn.disabled = false;
    refreshBtn.textContent = "🔄 Re-sync Steam wishlist";
    return;
  }
  location.reload();
});

// ---------- Main ----------

async function pool(items, size, worker) {
  let next = 0;
  const runners = Array.from({ length: size }, async () => {
    while (next < items.length) await worker(items[next++]);
  });
  await Promise.all(runners);
}

async function processRow(row) {
  row.state = "searching";
  renderRow(row);
  try {
    row.gog = await findOnGog(row.name, row.appid);
    row.state = row.gog ? "found" : "notfound";
  } catch (err) {
    console.warn("GOG search failed for", row.name, err);
    row.state = "error";
  }
  renderRow(row);
  updateToolbar();

  if (row.gog) {
    row.steam = await browser.runtime
      .sendMessage({
        action: "steam_price",
        title: row.name,
        appid: row.appid,
        gogCurrency: row.gog.currency || gogUser.currency,
      })
      .catch(() => null);
    renderRow(row);
  }
}

async function main() {
  const data = await browser.storage.local.get(["steamWishlistItems", "gogSearchCache"]);
  searchCache = data.gogSearchCache || {};
  const items = data.steamWishlistItems || [];

  if (!items.length) {
    const banner = document.getElementById("emptyBanner");
    banner.textContent =
      "No Steam wishlist data yet. Click “Re-sync Steam wishlist” (needs your Steam details in Settings).";
    banner.hidden = false;
    progressEl.textContent = "";
    return;
  }

  progressEl.textContent = "Checking your GOG account…";
  await loadGogUser();
  document.getElementById("loginBanner").hidden = gogUser.loggedIn;

  rows = items.map((item) => ({ ...item, state: "queued" }));
  rows.forEach((row) => rowsEl.appendChild(renderRow(row)));
  updateToolbar();

  await pool(rows, GOG_CONCURRENCY, processRow);

  if (cacheDirty) {
    // Drop expired entries so the cache doesn't grow forever.
    const now = Date.now();
    const fresh = Object.fromEntries(
      Object.entries(searchCache).filter(([, v]) => now - v.ts < GOG_SEARCH_TTL_MS),
    );
    await browser.storage.local.set({ gogSearchCache: fresh });
  }
  refreshAll();
}

main();
