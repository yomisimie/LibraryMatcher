# Library Matcher for Steam & GOG

A Firefox extension for people who buy games on both Steam and GOG. While you
browse GOG it shows which games you already own or have wishlisted on Steam,
compares prices, and lets you hide games you're not interested in.

## Features

- **Owned on Steam:** the GOG tile is dimmed and gets an "Owned" badge.
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

After installing, the settings page opens. It needs two things:

1. **Your SteamID64:** a 17-digit number. It's shown as "Steam ID" on your
   [Steam account page](https://store.steampowered.com/account/). If your
   profile link looks like `steamcommunity.com/profiles/7656…`, that number
   is it.
2. **A Steam Web API key:** get one at
   [steamcommunity.com/dev/apikey](https://steamcommunity.com/dev/apikey).
   For "Domain Name" enter anything, e.g. `localhost`. Steam only issues keys
   to accounts that have spent at least $5.

Click **Save & Sync Library**, then browse [gog.com](https://www.gog.com).
The toolbar button resyncs your library or wishlist at any time.

## Privacy

There is no server of ours; nothing is sent to the developer.

- Your Steam ID and API key are stored in your browser and sent only to
  Steam's API (`api.steampowered.com`) to read your library and wishlist.
- Titles of games on GOG pages are sent to Steam's store search
  (`store.steampowered.com`) to find their Steam prices.
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
