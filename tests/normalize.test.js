// Title matching rules in normalize.js. Run with `npm test`.
// normalize.js is a plain browser script that sets globals, so it's loaded
// into this context with vm rather than require().
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

vm.runInThisContext(
  fs.readFileSync(path.join(__dirname, "..", "normalize.js"), "utf8"),
  { filename: "normalize.js" },
);

// The keys the extension compares: exact, then the edition-stripped base.
const key = (name) => titleKey(normalizeTitle(name));
const baseKey = (name) => baseTitle(key(name));

test("normalizeTitle strips symbols, accents and punctuation", () => {
  assert.equal(normalizeTitle("Pokémon™: Foo - Bar"), "pokemon foo bar");
  assert.equal(normalizeTitle("Baldur's Gate 3"), "baldurs gate 3");
  assert.equal(normalizeTitle("Baldur’s Gate 3"), "baldurs gate 3");
  assert.equal(normalizeTitle("Ratchet & Clank"), "ratchet and clank");
  assert.equal(normalizeTitle("  DOOM®  "), "doom");
  assert.equal(normalizeTitle("Foo GOTY"), "foo game of the year");
});

test("baseTitle drops a leading 'the' and edition suffixes", () => {
  assert.equal(
    baseKey("The Witcher 3: Wild Hunt - Game of the Year Edition"),
    baseKey("The Witcher 3: Wild Hunt"),
  );
  assert.equal(baseKey("Witcher 3 Wild Hunt GOTY"), "witcher 3 wild hunt");
  assert.equal(baseKey("Foo Deluxe Edition"), "foo");
  assert.equal(baseKey("Foo Director's Cut"), "foo");
  assert.equal(baseKey("Foo Complete Edition"), "foo");
  // Several suffixes in a row.
  assert.equal(baseKey("Foo Gold Edition Deluxe"), "foo");
});

test("baseTitle keeps remasters and remakes apart", () => {
  assert.notEqual(baseKey("Foo Remastered"), baseKey("Foo"));
  assert.notEqual(baseKey("Foo Remake"), baseKey("Foo"));
});

test("baseTitle never returns an empty title", () => {
  for (const title of ["deluxe edition", "the deluxe", "the", "gold"])
    assert.ok(baseTitle(title), title);
});

test("titleKey matches Roman numerals with digits", () => {
  assert.equal(key("DOOM II"), key("Doom 2"));
  assert.equal(key("Final Fantasy VII"), key("FINAL FANTASY 7"));
  assert.equal(key("Grand Theft Auto V"), key("Grand Theft Auto 5"));
  assert.equal(
    key("Heroes of Might and Magic III: Complete"),
    "heroes of might and magic 3 complete",
  );
  assert.equal(baseKey("Civilization VI Gold Edition"), key("Civilization 6"));
  assert.equal(key("XIII"), "13");
});

test("titleKey leaves 'I', 'X' and numeral-like parts of words alone", () => {
  assert.equal(key("I Am Bread"), "i am bread");
  assert.notEqual(key("Mega Man X"), key("Mega Man 10"));
  assert.equal(key("Civ"), "civ");
  assert.equal(key("Divinity"), "divinity");
  assert.equal(key("Sniper Elite V2"), "sniper elite v2");
  assert.notEqual(key("DOOM II"), key("DOOM III"));
});

test("splitYear takes only a parenthesized year at the end", () => {
  assert.deepEqual(splitYear("DOOM (2016)"), { title: "DOOM", year: 2016 });
  assert.deepEqual(splitYear("DOOM (1993)™"), { title: "DOOM", year: 1993 });
  assert.deepEqual(splitYear("Thief (2014) "), { title: "Thief", year: 2014 });
  assert.equal(splitYear("Cyberpunk 2077").year, null);
  assert.equal(splitYear("Anno 1800").year, null);
  assert.equal(splitYear("Foo (2016) Remastered").year, null);
  assert.equal(splitYear("Foo (Classic)").year, null);
  assert.equal(splitYear("Foo (1850)").year, null);
});

test("sameYear allows one year either way, and needs both years", () => {
  assert.ok(sameYear(2016, 2016));
  assert.ok(sameYear(2016, 2017));
  assert.ok(sameYear(2016, 2015));
  assert.ok(!sameYear(2016, 2018));
  assert.ok(!sameYear(1993, 2016));
  assert.ok(!sameYear(2016, 0)); // Steam has no release date
  assert.ok(!sameYear(2016, null));
});

test("a dated GOG title matches the undated Steam title only by year", () => {
  // Steam's "DOOM" is the 2016 game.
  const steam = { name: "DOOM", year: 2016 };
  const fits = (gog) => {
    const { title, year } = splitYear(gog);
    return key(title) === key(steam.name) && sameYear(year, steam.year);
  };
  assert.ok(fits("DOOM (2016)"));
  assert.ok(!fits("DOOM (1993)"));
  assert.ok(!fits("DOOM 3 (2004)"));
});
