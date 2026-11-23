// Ignored games, shared by the content script, options page and background.
// Stored in browser.storage.sync so Firefox Sync carries them across devices.
// Each game is its own key ("ignore:<normalized title>" -> display title):
// sync storage caps a single key at 8 KB, and per-key storage lets two
// devices ignore different games without overwriting each other.

const IGNORE_PREFIX = "ignore:";

// Returns { normalizedTitle: displayTitle }.
async function getIgnored() {
  const all = await browser.storage.sync.get(null);
  const out = {};
  for (const [k, v] of Object.entries(all)) {
    if (k.startsWith(IGNORE_PREFIX)) out[k.slice(IGNORE_PREFIX.length)] = v;
  }
  return out;
}

function setIgnored(key, title, on) {
  return on
    ? browser.storage.sync.set({ [IGNORE_PREFIX + key]: title })
    : browser.storage.sync.remove(IGNORE_PREFIX + key);
}

// True when a storage.onChanged event touches the ignore list.
function ignoreListChanged(changes, area) {
  return area === "sync" && Object.keys(changes).some((k) => k.startsWith(IGNORE_PREFIX));
}

globalThis.getIgnored = getIgnored;
globalThis.setIgnored = setIgnored;
globalThis.ignoreListChanged = ignoreListChanged;
