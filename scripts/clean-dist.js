#!/usr/bin/env node
// Deletes the zips in dist/ before npm run package builds a new one, so only
// the current version's files are there. Only .zip files are removed.

const fs = require("fs");
const path = require("path");

const distDir = path.resolve(__dirname, "..", "dist");

if (fs.existsSync(distDir)) {
  for (const file of fs.readdirSync(distDir)) {
    if (file.toLowerCase().endsWith(".zip")) {
      fs.unlinkSync(path.join(distDir, file));
      console.log(`Removed dist/${file}`);
    }
  }
}
