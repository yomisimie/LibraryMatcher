// Shared title normalization, loaded by both the background script and the
// content script. Exposed on globalThis so it works in module and classic scripts.

// Trailing edition labels that don't change which game it is. Remasters and
// remakes are deliberately not listed: those are separate products.
const EDITION_SUFFIX =
  /\s+(?:game of the year|goty|definitive|enhanced|complete|deluxe|digital deluxe|gold|ultimate|special|anniversary|standard|premium|directors cut|collectors)(?:\s+edition)?$/;

// Full normalized title: strips accents, trademark symbols and punctuation,
// and collapses whitespace, so "Pokémon™: Foo - Bar" becomes "pokemon foo bar".
function normalizeTitle(name) {
  return String(name)
    .replace(/[™®©℠]/g, "") // before NFKD, which would expand ™ into "TM"
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\bgoty\b/g, "game of the year")
    .trim();
}

// Looser key used as a fallback: drops a leading "the" and edition suffixes,
// so "The Witcher 3 Wild Hunt GOTY Edition" matches "Witcher 3 Wild Hunt".
function baseTitle(normalized) {
  let base = normalized.replace(/^the\s+/, "").replace(/\s+edition$/, "");
  let prev;
  do {
    prev = base;
    base = base.replace(EDITION_SUFFIX, "");
  } while (base !== prev);
  return base || normalized;
}

// Roman numerals as standalone words, II to XX. "I" and "X" are left out: "I"
// is a word ("I Am Bread"), and "Mega Man X" is not "Mega Man 10".
const ROMAN = {
  ii: 2, iii: 3, iv: 4, v: 5, vi: 6, vii: 7, viii: 8, ix: 9, xi: 11, xii: 12,
  xiii: 13, xiv: 14, xv: 15, xvi: 16, xvii: 17, xviii: 18, xix: 19, xx: 20,
};
const ROMAN_WORD = new RegExp(`\\b(?:${Object.keys(ROMAN).join("|")})\\b`, "g");

// Key for comparing two normalized titles, so "DOOM II" matches "Doom 2".
// Not stored anywhere (ignore-list keys stay plain normalized titles), so it
// can change freely.
function titleKey(normalized) {
  return normalized.replace(ROMAN_WORD, (w) => String(ROMAN[w]));
}

// Stores tell same-named games apart with a year: GOG sells "DOOM (2016)" and
// "DOOM (1993)", while Steam calls the 2016 game just "DOOM". Splits that
// year off a raw (not normalized) title; only a parenthesized year counts,
// since "Cyberpunk 2077" or "Anno 1800" end in numbers that are the name.
const YEAR_SUFFIX = /\s*\(((?:19|20)\d{2})\)\s*$/;

function splitYear(name) {
  const clean = String(name).replace(/[™®©℠]/g, "").trim();
  const m = clean.match(YEAR_SUFFIX);
  return m
    ? { title: clean.slice(0, m.index), year: Number(m[1]) }
    : { title: clean, year: null };
}

// A store's year and Steam's release date can straddle New Year (regional
// launches, release vs. announcement), so allow one year either way. Same-named
// games are remakes or reboots, years apart.
function sameYear(a, b) {
  return !!a && !!b && Math.abs(a - b) <= 1;
}

// ---------- Same title, different game ----------

// Company names as written differ between stores ("Milestone S.r.l." vs
// "Milestone", "Night Dive Studios" vs "Nightdive Studios"), so compare them
// without legal suffixes and spaces.
const COMPANY_SUFFIX =
  /\s+(?:inc|llc|ltd|limited|gmbh|ag|sa|srl|s r l|s a|sp z o o|co|corp|corporation|ab|oy|bv|kk|plc|pty)$/;

function companyKey(name) {
  let key = normalizeTitle(name);
  let prev;
  do {
    prev = key;
    key = key.replace(COMPANY_SUFFIX, "");
  } while (key !== prev);
  return key.replace(/\s+/g, "");
}

function sharesCompany(a, b) {
  const keys = new Set(a.map(companyKey).filter(Boolean));
  return b.map(companyKey).some((k) => k && keys.has(k));
}

// Two store entries with the same title can be different games: GOG's
// "Screamer" is the 1995 racer, Steam's newest "Screamer" a 2026 game by
// another studio. Each side is { year, companies } (developers and
// publishers), or null when unknown. Release years alone can't tell: a classic
// re-released on Steam may only carry the re-release date (Uplink: 2001 on
// GOG, 2006 on Steam). So it's a different game only when the years are far
// apart and no developer or publisher is shared. Unknown data keeps the match.
function differentGames(gog, steam) {
  if (!gog?.year || !steam?.year) return false;
  if (sameYear(gog.year, steam.year)) return false;
  if (!gog.companies?.length || !steam.companies?.length) return false;
  return !sharesCompany(gog.companies, steam.companies);
}

// { year, companies } from a GOG catalog product. releaseDate is the
// original release ("1995.10.31"); storeReleaseDate is when GOG listed it.
function gogProductInfo(p) {
  const year = parseInt(p.releaseDate, 10);
  return {
    year: year > 1900 ? year : 0,
    companies: [...(p.developers || []), ...(p.publishers || [])],
  };
}

globalThis.differentGames = differentGames;
globalThis.gogProductInfo = gogProductInfo;
globalThis.normalizeTitle = normalizeTitle;
globalThis.baseTitle = baseTitle;
globalThis.titleKey = titleKey;
globalThis.splitYear = splitYear;
globalThis.sameYear = sameYear;
