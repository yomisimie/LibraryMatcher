# Changelog

All notable changes to Library Matcher for Steam & GOG, newest first.
`npm run bump` adds a heading for the new version; write that version's
changes under it.

## [0.4.1] - 2026-11-27

### Fixed
- GOG titles with a year, like "DOOM (2016)", now match the Steam game of the
  same name ("DOOM") for the Owned and wishlist badges, Steam prices and the
  Steam wishlist page. The year has to agree with the game's release year on
  Steam, so "DOOM (1993)" isn't mistaken for the 2016 game.

## [0.4.0] - 2026-11-26

### Added
- No Steam API key needed anymore: sign in to the Steam store in Firefox and
  click Save & Sync. Your library, wishlist and SteamID are read from that
  sign-in, the same way the Steam store shows "In Library" on its pages.
- The settings page shows whether you're signed in to Steam, with a link to
  sign in.
- DLC you own on Steam is synced too and marked "Owned DLC" on GOG (when
  syncing through your Steam sign-in; the API key can't list DLC). The popup
  shows how many DLC were synced.

### Changed
- The SteamID and API key fields moved under "Advanced" in the settings.
  An API key still works if you'd rather not stay signed in to Steam.
- If your Steam sign-in expires, your last synced lists are kept, and the
  error says to sign in again.
- Clearer error when Steam doesn't accept the SteamID.

## [0.3.0] - 2026-11-26

### Added
- Your GOG wishlist page now shows the Steam badges (owned / on your Steam
  wishlist) and the Steam price comparison, in a strip under each game's
  title.
- "Your GOG currency" setting. Some GOG pages, like your wishlist, show
  prices without a currency sign; Steam prices there are converted to this
  currency. On Auto it uses the last currency seen on a GOG store page.

### Fixed
- Save & Sync asks Firefox for access to Steam's servers when the extension
  doesn't have it yet, instead of failing with "NetworkError".

## [0.2.2] - 2026-11-23

### Fixed
- Compact list rows on GOG (e.g. the bestsellers list): the Steam badge and
  price no longer overlap on the small cover. The badge shows just the Steam
  icon with ♥ or ✓, and the price comparison sits on one line next to GOG's
  price.

## [0.2.1] - 2026-11-23

### Changed
- Homepage link points to the renamed repository,
  github.com/yomisimie/LibraryMatcher.

## [0.2.0] - 2026-11-23

### Added
- Extension icon.
- Settings page links to where to find your SteamID64 and get a Steam Web
  API key.
- README with setup steps and what data goes where; MIT license.

### Changed
- Renamed to "Library Matcher for Steam & GOG", with a permanent extension
  ID for addons.mozilla.org. Existing installs count as a new extension:
  enter your Steam ID and API key again (the ignore list starts empty).
- Declares the data it sends (the Steam API key, and GOG game titles for
  Steam price lookups), which Firefox shows when installing.

## [0.1.0] - 2026-11-23

### Added
- Right-click a game on GOG and choose Ignore (or Unignore). Works on the
  regular tiles and on GOG's bigger hover card, which covers the ✕ button.
- GOG's hover card gets the same marks as the tiles: Steam owned/wishlist
  badges, the Steam price comparison and an "✕ Ignore" button.

## [0.0.8] - 2026-11-23

### Changed
- Release process: every commit is a release, with the version bump and
  changelog in the same commit (documented in `AGENTS.md`).

## [0.0.7] - 2026-11-23

### Added
- Ignore games on GOG: hover a tile and click ✕ to hide that game on every
  GOG page. The options page lists ignored games with an Unignore button,
  and a setting shows ignored games dimmed instead of hidden.
- The ignore list syncs across devices through Firefox Sync (when "Add-ons"
  is enabled in Sync settings).
- `AGENTS.md` with notes for coding agents, and this changelog.

## [0.0.6] - 2026-11-20

### Added
- "Steam wishlist on GOG" page: matches the Steam wishlist against GOG's
  catalog, compares prices and adds games to the GOG wishlist in one click.
- Automatic hourly check that resyncs Steam lists older than a day.
- Steam badges link to the game's Steam store page.
- Steam price comparison on GOG tiles for games wishlisted on Steam or GOG,
  converted to GOG's currency at the daily ECB rate.
- web-ext packaging scripts: `npm start`, `npm run lint`, `npm run package`,
  `npm run bump`.

### Changed
- Better title matching (accents, trademark symbols, edition suffixes such
  as GOTY or Deluxe), shared between the background and content scripts.
- Steam lists are cached in the content script instead of being read for
  every tile.

### Fixed
- Steam badge SVG markup, styling and sync error handling.
- A failed or partial wishlist sync no longer overwrites the saved list.

## [0.0.5] - 2026-06-17

### Changed
- Version bump only.

## [0.0.4] - 2026-06-17

### Added
- Match games on your Steam wishlist, not just owned games.

### Fixed
- Assorted fixes.

## [0.0.1] - 2026-06-09

### Added
- First version: marks GOG games you already own on Steam.
- Popup fixes.
