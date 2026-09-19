const test = require("node:test")
const assert = require("node:assert/strict")

const model = require("../TouchpadAutoModel.js")

// These cover the helpers as they behave today, so later changes to the module
// have a baseline to break against.

test("boolFromConfig falls back only for undefined and null", () => {
  assert.equal(model.boolFromConfig(undefined, true), true)
  assert.equal(model.boolFromConfig(null, true), true)
  assert.equal(model.boolFromConfig(undefined, false), false)

  assert.equal(model.boolFromConfig(false, true), false)
  assert.equal(model.boolFromConfig(0, true), false)
  assert.equal(model.boolFromConfig("", true), false)

  assert.equal(model.boolFromConfig(true, false), true)
  assert.equal(model.boolFromConfig("no", false), true, "any non-empty string is truthy")
})

test("intFromConfig accepts non-negative numbers and floors them", () => {
  assert.equal(model.intFromConfig(400, 100), 400)
  assert.equal(model.intFromConfig(0, 100), 0)
  assert.equal(model.intFromConfig("250", 100), 250)
  assert.equal(model.intFromConfig(12.9, 100), 12)
})

test("intFromConfig falls back for negative, non-numeric and non-finite input", () => {
  assert.equal(model.intFromConfig(-1, 100), 100)
  assert.equal(model.intFromConfig("abc", 100), 100)
  assert.equal(model.intFromConfig(undefined, 100), 100)
  assert.equal(model.intFromConfig(null, 100), 0, "Number(null) is 0, which is a valid value")
  assert.equal(model.intFromConfig(Infinity, 100), 100)
  assert.equal(model.intFromConfig(NaN, 100), 100)
})

test("parseCount reads a leading integer and clamps everything else to zero", () => {
  assert.equal(model.parseCount("2"), 2)
  assert.equal(model.parseCount("  3\n"), 3)
  assert.equal(model.parseCount("0"), 0)
  assert.equal(model.parseCount("1 external"), 1, "parseInt stops at the first non-digit")

  assert.equal(model.parseCount(""), 0)
  assert.equal(model.parseCount(null), 0)
  assert.equal(model.parseCount(undefined), 0)
  assert.equal(model.parseCount("-1"), 0)
  assert.equal(model.parseCount("not a number"), 0)
})
