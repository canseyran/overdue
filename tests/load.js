// Loads a QML JavaScript library (".pragma library" + plain functions) into
// Node or Bun. The pragma line is not JavaScript, so it is blanked out (the
// line count stays the same, so stack traces still point at the right line),
// then the file runs with a CommonJS `module` it fills in itself.
"use strict"
const fs = require("fs")
const path = require("path")

module.exports = function load(name) {
  const file = path.join(__dirname, "..", name)
  const src = fs.readFileSync(file, "utf8").replace(/^\.pragma library\s*$/m, "")
  const mod = { exports: {} }
  new Function("module", "exports", src + "\n//# sourceURL=" + file)(mod, mod.exports)
  return mod.exports
}
