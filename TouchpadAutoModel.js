function boolFromConfig(value, fallback) {
  if (value === undefined || value === null) return fallback
  return !!value
}

function intFromConfig(value, fallback) {
  var n = Number(value)
  if (!isFinite(n) || n < 0) return fallback
  return Math.floor(n)
}

function parseCount(text) {
  var trimmed = String(text || "").trim()
  var n = parseInt(trimmed, 10)
  if (!isFinite(n) || n < 0) return 0
  return n
}

if (typeof module !== "undefined") {
  module.exports = {
    boolFromConfig: boolFromConfig,
    intFromConfig: intFromConfig,
    parseCount: parseCount
  }
}
