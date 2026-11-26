const statusEl = document.getElementById("status");
const infoEl = document.getElementById("info");

function setStatus(text, isError = false) {
  statusEl.textContent = text;
  statusEl.classList.toggle("error", isError);
}

function timeAgo(ts) {
  if (!ts) return "never";
  const minutes = Math.round((Date.now() - ts) / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}

function countOf(list) {
  if (!list) return 0;
  return Array.isArray(list) ? list.length : Object.keys(list).length;
}

async function renderInfo() {
  const d = await browser.storage.local.get([
    "steamId",
    "steamOwned",
    "steamOwnedDlc",
    "steamOwnedNames",
    "steamWishlist",
    "steamWishlistNames",
    "steamOwnedSyncedAt",
    "steamWishlistSyncedAt",
    "lastSyncError",
  ]);

  infoEl.replaceChildren();
  if (!d.steamId) {
    infoEl.textContent = "Not set up yet. Sign in to the Steam store in Firefox, then open Settings and click Save & Sync.";
    return;
  }

  const line = (label, count, ts) => {
    const div = document.createElement("div");
    const strong = document.createElement("strong");
    strong.textContent = `${count.toLocaleString()} ${label}`;
    div.append(strong, ` · synced ${timeAgo(ts)}`);
    infoEl.appendChild(div);
  };
  line("games", countOf(d.steamOwned || d.steamOwnedNames), d.steamOwnedSyncedAt);
  // DLC is only known when synced through the Steam sign-in, not the API key.
  if (countOf(d.steamOwnedDlc))
    line("DLC", countOf(d.steamOwnedDlc), d.steamOwnedSyncedAt);
  line("wishlisted", countOf(d.steamWishlist || d.steamWishlistNames), d.steamWishlistSyncedAt);

  if (d.lastSyncError) setStatus(`Auto sync failed: ${d.lastSyncError}`, true);
}

async function runSync(button, action, busyText, successText) {
  button.disabled = true;
  setStatus(busyText);
  try {
    const response = await browser.runtime.sendMessage({ action });
    if (response?.success) {
      setStatus(successText(response.count));
    } else {
      setStatus(response?.message || "Sync failed!", true);
    }
  } catch (err) {
    console.error(err);
    setStatus("Connection error. Try again.", true);
  } finally {
    button.disabled = false;
    renderInfo();
  }
}

document.getElementById("syncBtn").addEventListener("click", (e) =>
  runSync(e.currentTarget, "force_sync", "Syncing library…", ({ games, dlc }) =>
    dlc ? `Synced ${games} games and ${dlc} DLC!` : `Synced ${games} games!`),
);

document.getElementById("wishlistBtn").addEventListener("click", (e) =>
  runSync(e.currentTarget, "sync_wishlist", "Syncing wishlist…", (n) => `Synced ${n} wishlist items!`),
);

document.getElementById("gogWishlistBtn").addEventListener("click", () => {
  browser.tabs.create({ url: browser.runtime.getURL("wishlist.html") });
  window.close();
});

document.getElementById("optionsBtn").addEventListener("click", () => {
  browser.runtime.openOptionsPage().catch((err) => {
    console.error("Failed to open settings:", err);
    setStatus("Error opening settings.", true);
  });
});

renderInfo();
