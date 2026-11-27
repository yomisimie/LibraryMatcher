# Library Matcher for Steam & GOG

A Firefox extension for people who buy games on both Steam and GOG. While you
browse GOG it shows which games you already own or have wishlisted on Steam,
compares prices, and lets you hide games you're not interested in.

## Features

- **Owned on Steam:** the GOG tile is dimmed and gets an "Owned" badge, or
  "Owned DLC" for DLC you own on Steam (when synced through your Steam
  sign-in; the API key can't list DLC).
- **On your Steam wishlist:** the tile is outlined and gets a "Wishlist" badge.
- **Price comparison:** for games on your Steam or GOG wishlist, the Steam
  price is shown on the tile (converted to GOG's currency at the daily ECB
  rate), with which store is cheaper.
- **Ignore games:** right-click a game on GOG and choose Ignore, or hover it
  and click ✕. Ignored games are hidden on every GOG page (or dimmed, if you
  prefer). The list syncs between your browsers with Firefox Sync.
- **Steam wishlist on GOG:** a page that finds your Steam wishlist games on
  GOG, compares prices, and adds them to your GOG wishlist in one click.
- Badges and prices also appear on GOG's bigger hover card.
- Your Steam lists resync automatically once a day.

## Setup

No API key or password needed:

1. Sign in to the [Steam store](https://store.steampowered.com/login/) in
   Firefox, if you aren't already.
2. After installing, the settings page opens. Click **Save & Sync**.

The extension reads your library and wishlist the same way the Steam store
does to show "In Library" on its pages, and finds your SteamID from the same
session. Then browse [gog.com](https://www.gog.com). The toolbar button
resyncs at any time, and if your Steam sign-in expires the extension keeps
your last synced lists until you sign in again.

**Advanced: API key instead of signing in.** If you'd rather not stay signed
in to Steam in Firefox, open *Advanced* in the settings and enter your
SteamID64 (shown as "Steam ID" on your
[account page](https://store.steampowered.com/account/)) and a Steam Web API
key from [steamcommunity.com/dev/apikey](https://steamcommunity.com/dev/apikey)
(for "Domain Name" enter anything, e.g. `localhost`). Steam only issues keys
to accounts that have spent at least $5, and your profile's game details must
be public.

## Privacy

There is no server of ours; nothing is sent to the developer.

- Your library, wishlist and SteamID are read from Steam
  (`store.steampowered.com`, `api.steampowered.com`) using your existing
  Steam store sign-in in Firefox. The extension never sees your password.
- If you use an API key instead, it's stored in your browser and sent only to
  Steam's API (`api.steampowered.com`).
- Titles of games on GOG pages are sent to Steam's store search
  (`store.steampowered.com`) to find their Steam prices.
- To tell apart games that share a name, the titles of matched games are
  looked up in GOG's catalog (`catalog.gog.com`), and their Steam app IDs at
  Steam (`api.steampowered.com`), for release dates and developers.
- Currency codes are sent to `api.frankfurter.dev` for exchange rates.
- The "Steam wishlist on GOG" page uses your existing GOG login to read your
  GOG library and wishlist and to add games to it.
- The ignore list is stored with Firefox Sync, which is end-to-end encrypted
  in your own Firefox account. Without an account it stays on this computer.

## Development

```sh
npm install      # web-ext
npm start        # run Firefox with the extension loaded
npm run lint
npm run package  # dist/<name>-<version>.zip
```

See [AGENTS.md](AGENTS.md) for how the code is organised and how releases
are made, and [CHANGELOG.md](CHANGELOG.md) for what changed in each version.

Not affiliated with Valve or GOG. Steam and GOG are trademarks of their
respective owners.

## License

[MIT](LICENSE)
