# AGENTS.md

Notes for coding agents working on Library Matcher for Steam & GOG (repo:
LibraryMatcher). User-facing docs are in `README.md`.

## What this is

A Firefox (Manifest V3) extension for GOG.com. It marks games you own on
Steam (dimmed tile + "Owned" badge) or have wishlisted on Steam (blue outline
+ badge), shows Steam prices next to GOG prices for wishlisted games, and lets
you ignore (hide) games on GOG pages. It also has a "Steam wishlist on GOG"
page that matches your Steam wishlist against GOG's catalog and can add games
to your GOG wishlist.

Plain JavaScript with no bundler, framework or build step. Files are loaded
exactly as written, so there are no imports: shared code is exposed on
`globalThis` and loaded via script order in `manifest.json` / `<script>` tags.
The code uses the `browser.*` (promise-based WebExtension) API; Chrome is not
a target.

## Files

| File | Role |
| --- | --- |
| `manifest.json` | Extension manifest. Script load order matters (shared files first). `data_collection_permissions` must list every kind of data that leaves the browser (see Publishing). |
| `icon.svg` | Extension and toolbar icon. Original artwork: don't use Steam's or GOG's logos for it. |
| `normalize.js` | Shared title matching: `normalizeTitle()` and `baseTitle()` (edition-stripped fallback). Used everywhere titles are compared. |
| `ignore.js` | Shared ignore-list helpers over `storage.sync`: `getIgnored()`, `setIgnored()`, `ignoreListChanged()`. |
| `background.js` | Steam sync (owned games, wishlist; via the Steam store session by default, or the Web API with a key), hourly auto sync via `alarms`, Steam store price lookup with caching/queueing, ECB exchange rates, message handlers, ignore-list migration, the right-click "Ignore" menu item (the content script resolves which game was clicked). Its header comment documents the storage layout; keep it current. |
| `content.js` / `content.css` | Runs on `*.gog.com`. Finds product tiles, adds badges, price cards and the ignore button. Everything it injects has class `slm-ui`; every class it adds is listed in `MARK_CLASSES`, so `clearMarks()` can fully reset a page. |
| `options.html` / `options.js` | Setup: Steam sign-in status (default, no key), optional SteamID64 + API key under Advanced, price settings, ignored-games list. |
| `popup.html` / `popup.js` | Toolbar popup: sync status and manual sync buttons. |
| `wishlist.html` / `wishlist.js` | "Steam wishlist on GOG" page (uses GOG's catalog and the user's GOG login cookies). |
| `scripts/` | Dev tooling (Node): version bump, dist cleanup. Not shipped. |

## Storage

- `browser.storage.local`: credentials, synced Steam lists, settings, caches.
  See the header of `background.js` for every key.
- `browser.storage.sync`: the ignore list, one key per game
  (`ignore:<normalized title>` → display title). Per-key storage keeps each
  item under the 8 KB item quota and lets devices merge edits. Firefox's sync
  quota is ~100 KB / 512 items total.
- Sync is tied to the gecko ID in `manifest.json`
  (`browser_specific_settings.gecko.id`, `steam-library-matcher@yomisimie`).
  It's permanent on addons.mozilla.org: never change it.

Content script and options page react to `storage.onChanged` instead of
messaging each other; writing to storage is how you update open GOG tabs.

## GOG DOM assumptions

Tile and title selectors live at the top of `content.js` (`TITLE_SELECTOR`,
`TILE_SELECTOR`, `SKIP_AREA_SELECTOR`, `GOG_WISHLIST_SELECTOR`). GOG changes
its markup occasionally; when badges stop appearing, check these first. GOG
styles every `<img>` in cover areas aggressively, hence the `!important`
overrides on `.slm-icon`. Our elements sit inside GOG's tile `<a>`, so click
handlers must `preventDefault()` and `stopPropagation()`.

## Commands

```sh
npm install          # web-ext (dev dependency only)
npm start            # web-ext run: launches Firefox with the extension loaded
npm run lint         # web-ext lint: run before committing
npm run package      # clears dist/*.zip, builds dist/library_matcher_for_steam_gog-<version>.zip
npm run bump         # patch bump; also: -- minor | -- major | -- 1.2.3
```

Never edit a version by hand; see Releasing below. There are no automated
tests: check syntax with `node --check <file>.js`, run `npm run lint`, and
test by hand in Firefox with `npm start`.

The packaged zip excludes `package*.json`, `scripts/`, `dist/` and `*.md`
(see `webExt.ignoreFiles` in `package.json`). A new runtime file is picked up
automatically; a new dev-only file or folder must be added to that list.

## Releasing

Every commit is a release, made in one commit:

1. Make the change.
2. `npm run bump` (patch for fixes, `-- minor` for features, `-- major` for
   breaking changes). It updates `manifest.json` and `package.json` and adds
   an empty `## [x.y.z] - <date>` heading at the top of `CHANGELOG.md`.
3. Under that heading, describe the changes for users, grouped as
   `### Added`, `### Changed`, `### Fixed`, `### Removed`.
4. `npm run lint`.
5. Commit everything together, titled `<summary> (x.y.z)`, and push to `main`.
6. `npm run package` builds the upload zip in `dist/`.

## Publishing

The extension is meant for addons.mozilla.org. When a change sends data to a
new place, or sends new kinds of data, update three things together:
`data_collection_permissions` in `manifest.json` (Mozilla's categories,
currently `authenticationInfo` for the Steam API key and `websiteContent` for
GOG page titles sent to Steam's search), `host_permissions`, and the Privacy
section of `README.md`. The `web-ext lint` warning about Firefox for Android
and `data_collection_permissions` is known and ignored: the extension is
desktop-only.

## Conventions

- Commit directly to `main`; no feature branches.
- Comments explain *why* (GOG quirks, API limits, matching trade-offs), not
  what the code does.
- No new dependencies for the extension itself; it ships as plain files.
- Never log or send the Steam API key anywhere except `api.steampowered.com`.
