"use strict"
// The settings live in three places that must agree: Model.SETTINGS (what the
// service reads), the bar widget's schema in manifest.json (what the bar's
// settings show) and the i18n catalog (what the panel's settings view shows).
const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("fs")
const path = require("path")
const M = require("./load")("Model.js")

const root = path.join(__dirname, "..")
const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"))
const catalog = JSON.parse(fs.readFileSync(path.join(root, "i18n", "en.json"), "utf8"))
const schema = manifest.barWidget.schema

const SCHEMA_TYPES = { int: "integer", bool: "boolean", enum: "enum", clock: "string", range: "string" }

test("the manifest id is the plugin id the code falls back to", () => {
  assert.equal(manifest.id, M.PLUGIN_ID)
})

test("every setting is in the widget schema, with the same type, range and default", () => {
  assert.deepEqual(schema.map(f => f.key).sort(), Object.keys(M.SETTINGS).sort())
  for (const field of schema) {
    const spec = M.SETTINGS[field.key]
    assert.equal(field.type, SCHEMA_TYPES[spec.type], field.key + " type")
    assert.deepEqual(field.defaultValue, spec.value, field.key + " default")
    if (spec.type === "int") {
      assert.equal(field.min, spec.min, field.key + " min")
      assert.equal(field.max, spec.max, field.key + " max")
    }
    if (spec.type === "enum") assert.deepEqual(field.options, spec.options, field.key + " options")
  }
})

test("the widget's defaults agree with the settings", () => {
  for (const [key, value] of Object.entries(manifest.barWidget.defaults)) {
    assert.ok(M.isSetting(key), key)
    assert.deepEqual(value, M.SETTINGS[key].value, key)
  }
})

test("every setting has a title and a description in the catalog", () => {
  for (const key of Object.keys(M.SETTINGS)) {
    assert.equal(typeof catalog["settings." + key], "string", "settings." + key)
    assert.equal(typeof catalog["settings." + key + ".desc"], "string", "settings." + key + ".desc")
  }
  for (const spec of Object.values(M.SETTINGS).filter(s => s.type === "enum"))
    for (const option of spec.options) assert.equal(typeof catalog["option." + option], "string", "option." + option)
})

test("every literal catalog key the QML asks for exists", () => {
  const files = fs.readdirSync(root).filter(f => f.endsWith(".qml"))
  const src = files.map(f => fs.readFileSync(path.join(root, f), "utf8")).join("\n")
  const keys = new Set()
  for (const m of src.matchAll(/\b(?:t|tn|plural)\("([A-Za-z]+\.[A-Za-z.]*[A-Za-z])"/g)) keys.add(m[1])
  assert.ok(keys.size > 50)
  for (const key of keys) assert.ok(key in catalog, key)
})
