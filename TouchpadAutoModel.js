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

// The whole enable/disable policy, kept here as a pure function so it can be
// tested without a compositor.
//
// The rule it encodes: the plugin re-enables only a disable it created itself.
// Omarchy persists the touchpad's disabled state across reboots and the user has
// their own command and keybinding for that same state, so a disable this plugin
// did not cause belongs to the user and is left alone.
//
// state:
//   pointerCount       external pointers found by the last scan
//   pointerWasPresent  whether the previous scan found any
//   firstEvaluation    true for the first scan after the service starts
//   ownsDisable        whether this plugin holds the ownership marker
//   overrideActive     whether the user told the plugin to back off
//
// Returns { action: "disable" | "enable" | "none", reason, clearOverride }.
function decideAction(state) {
  var present = state.pointerCount > 0
  var clearOverride = !present && !!state.overrideActive

  // Every scan after the first only reacts to the count crossing zero. The
  // first one applies the resolved state regardless, because pointerWasPresent
  // starts false: a start with no pointer connected is indistinguishable from
  // "nothing changed", and the disabled state it has to reconcile with is
  // exactly the one that survived the restart.
  if (!state.firstEvaluation && present === !!state.pointerWasPresent) {
    return { action: "none", reason: "no-transition", clearOverride: clearOverride }
  }

  if (present) {
    if (state.overrideActive) {
      return { action: "none", reason: "override-active", clearOverride: false }
    }
    return { action: "disable", reason: "pointer-connected", clearOverride: false }
  }

  if (state.ownsDisable) {
    return { action: "enable", reason: "restoring-owned-disable", clearOverride: clearOverride }
  }
  return { action: "none", reason: "disable-not-owned", clearOverride: clearOverride }
}

if (typeof module !== "undefined") {
  module.exports = {
    boolFromConfig: boolFromConfig,
    intFromConfig: intFromConfig,
    parseCount: parseCount,
    decideAction: decideAction
  }
}
