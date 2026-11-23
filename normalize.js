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

globalThis.normalizeTitle = normalizeTitle;
globalThis.baseTitle = baseTitle;
