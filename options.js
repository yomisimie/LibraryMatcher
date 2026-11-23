// Load previously saved values if they exist
document.addEventListener("DOMContentLoaded", async () => {
  const data = await browser.storage.local.get([
    "steamId",
    "apiKey",
    "showSteamPrices",
    "steamCountry",
  ]);
  if (data.steamId) document.getElementById("steamId").value = data.steamId;
  if (data.apiKey) document.getElementById("apiKey").value = data.apiKey;
  document.getElementById("showSteamPrices").checked =
    data.showSteamPrices !== false;
  document.getElementById("steamCountry").value = data.steamCountry || "";
  renderIgnored();
});

// ---------- Ignored games (saved immediately, independent of Save & Sync) ----------

async function renderIgnored() {
  const { dimIgnoredGames } = await browser.storage.local.get("dimIgnoredGames");
  document.getElementById("dimIgnoredGames").checked = dimIgnoredGames === true;
  const ignoredGames = await getIgnored();

  const list = document.getElementById("ignoredList");
  list.replaceChildren();
  const entries = Object.entries(ignoredGames).sort((a, b) =>
    a[1].localeCompare(b[1]),
  );
  for (const [key, title] of entries) {
    const li = document.createElement("li");
    const name = document.createElement("span");
    name.textContent = title;
    const btn = document.createElement("button");
    btn.textContent = "Unignore";
    btn.addEventListener("click", () => setIgnored(key, title, false));
    li.append(name, btn);
    list.appendChild(li);
  }
  document.getElementById("ignoredEmpty").hidden = entries.length > 0;
}

document.getElementById("dimIgnoredGames").addEventListener("change", (e) => {
  browser.storage.local.set({ dimIgnoredGames: e.target.checked });
});

// Keep the list current when games are ignored from a GOG tab.
browser.storage.onChanged.addListener((changes, area) => {
  if (
    ignoreListChanged(changes, area) ||
    (area === "local" && "dimIgnoredGames" in changes)
  )
    renderIgnored();
});

// Save credentials and request background script to sync
document.getElementById("saveBtn").addEventListener("click", async () => {
  const steamId = document.getElementById("steamId").value.trim();
  const apiKey = document.getElementById("apiKey").value.trim();
  const status = document.getElementById("status");

  const showSteamPrices = document.getElementById("showSteamPrices").checked;
  const steamCountry = document
    .getElementById("steamCountry")
    .value.trim()
    .toUpperCase();

  if (!steamId || !apiKey) {
    status.style.color = "#ff8888";
    status.textContent = "Please fill out both fields.";
    return;
  }
  if (steamCountry && !/^[A-Z]{2}$/.test(steamCountry)) {
    status.style.color = "#ff8888";
    status.textContent = "Country must be a 2-letter code, e.g. RO or US.";
    return;
  }

  status.style.color = "#fff";
  status.textContent = "Saving configuration...";

  // Save values to local storage
  await browser.storage.local.set({
    steamId,
    apiKey,
    showSteamPrices,
    steamCountry,
  });

  try {
    // 1. Run the Owned Games Sync first
    const ownedResponse = await browser.runtime.sendMessage({
      action: "force_sync",
    });

    // 2. Run the Wishlist Sync second
    const wishlistResponse = await browser.runtime.sendMessage({
      action: "sync_wishlist",
    });

    // 3. Handle the UI status updates using both results
    if (ownedResponse?.success && wishlistResponse?.success) {
      status.style.color = "#a3ffb4";
      status.textContent = `Synced ${ownedResponse.count} games and ${wishlistResponse.count} wishlist items!`;
    } else if (ownedResponse?.success) {
      status.style.color = "#ffcc66";
      status.textContent = `Library synced, but Wishlist failed: ${wishlistResponse?.message || "unknown error"}`;
    } else {
      status.style.color = "#ff8888";
      status.textContent = `Sync failed: ${ownedResponse?.message || "unknown error"}`;
    }
  } catch (err) {
    console.error("Combined synchronization routine crashed:", err);
    status.textContent = "Connection error during batch processing.";
  }
});
