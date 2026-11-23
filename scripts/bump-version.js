#!/usr/bin/env node
// Bumps the extension version in manifest.json, keeps package.json in sync,
// and adds a heading for the new version to CHANGELOG.md.
//
// Usage:
//   npm run bump              -> patch (0.0.5 -> 0.0.6)
//   npm run bump -- minor     -> 0.0.6 -> 0.1.0
//   npm run bump -- major     -> 0.1.0 -> 1.0.0
//   npm run bump -- 0.2.0     -> set an explicit version

const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const files = ["manifest.json", "package.json"].map((f) => path.join(root, f));

const arg = (process.argv[2] || "patch").trim();
const manifest = JSON.parse(fs.readFileSync(files[0], "utf8"));
const current = manifest.version;

function parse(v) {
  const parts = String(v).split(".").map((p) => Number(p));
  if (parts.length < 1 || parts.length > 3 || parts.some((n) => !Number.isInteger(n) || n < 0)) {
    throw new Error(`Invalid version "${v}" (expected up to 3 numeric parts, e.g. 0.1.0)`);
  }
  while (parts.length < 3) parts.push(0);
  return parts;
}

let next;
if (/^\d+(\.\d+){0,2}$/.test(arg)) {
  next = parse(arg);
} else {
  const [major, minor, patch] = parse(current);
  switch (arg) {
    case "major": next = [major + 1, 0, 0]; break;
    case "minor": next = [major, minor + 1, 0]; break;
    case "patch": next = [major, minor, patch + 1]; break;
    default:
      console.error(`Unknown bump type "${arg}". Use patch, minor, major, or an explicit version.`);
      process.exit(1);
  }
}
const nextVersion = next.join(".");

// Replace only the top-level "version" value so the rest of each file's formatting is untouched.
for (const file of files) {
  const text = fs.readFileSync(file, "utf8");
  const updated = text.replace(/^(\s*"version"\s*:\s*")[^"]*(")/m, `$1${nextVersion}$2`);
  if (updated === text && !text.includes(`"version": "${nextVersion}"`)) {
    console.error(`Could not find a "version" field in ${path.basename(file)}`);
    process.exit(1);
  }
  fs.writeFileSync(file, updated);
}

console.log(`Version bumped: ${current} -> ${nextVersion}`);

// Add an empty "## [x.y.z] - date" heading above the newest entry in
// CHANGELOG.md, ready for this version's changes to be written under it.
const changelog = path.join(root, "CHANGELOG.md");
if (fs.existsSync(changelog)) {
  const text = fs.readFileSync(changelog, "utf8");
  const d = new Date();
  const date = [d.getFullYear(), d.getMonth() + 1, d.getDate()]
    .map((n) => String(n).padStart(2, "0"))
    .join("-");
  const heading = `## [${nextVersion}] - ${date}`;
  const first = text.search(/^## /m);

  if (text.includes(`## [${nextVersion}]`)) {
    console.warn(`CHANGELOG.md already has a ${nextVersion} section; left unchanged.`);
  } else {
    const updated =
      first === -1
        ? `${text.trimEnd()}\n\n${heading}\n`
        : `${text.slice(0, first)}${heading}\n\n${text.slice(first)}`;
    fs.writeFileSync(changelog, updated);
    console.log(`CHANGELOG.md: added "${heading}", write this version's changes under it.`);
  }
}
