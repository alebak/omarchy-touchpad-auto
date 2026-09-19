const test = require("node:test")
const assert = require("node:assert/strict")

const model = require("../TouchpadAutoModel.js")

// decideAction is the whole enable/disable policy, extracted from Service.qml so
// it can be exercised without a compositor. It answers one question: given what
// the plugin just counted and what it knows it owns, what should happen to the
// touchpad?
//
// The rule that drives every case below: the plugin re-enables only a disable it
// created itself. Omarchy persists the disabled state, and the user has their own
// keybinding for the same state, so a disable the plugin did not cause belongs to
// the user and is left alone.

function decide(overrides) {
  return model.decideAction(Object.assign({
    pointerCount: 0,
    pointerWasPresent: false,
    firstEvaluation: false,
    ownsDisable: false,
    overrideActive: false
  }, overrides))
}

test("does nothing when the pointer count has not crossed zero", () => {
  const stillConnected = decide({ pointerCount: 2, pointerWasPresent: true })
  assert.equal(stillConnected.action, "none")
  assert.equal(stillConnected.reason, "no-transition")

  const stillAbsent = decide({ pointerCount: 0, pointerWasPresent: false })
  assert.equal(stillAbsent.action, "none")
  assert.equal(stillAbsent.reason, "no-transition")
})

test("disables the touchpad when the first external pointer appears", () => {
  const result = decide({ pointerCount: 1, pointerWasPresent: false })
  assert.equal(result.action, "disable")
  assert.equal(result.reason, "pointer-connected")
})

test("leaves the touchpad alone while the user override is active", () => {
  const result = decide({ pointerCount: 1, pointerWasPresent: false, overrideActive: true })
  assert.equal(result.action, "none")
  assert.equal(result.reason, "override-active")
})

test("restores the touchpad when the last pointer leaves and the disable is ours", () => {
  const result = decide({ pointerCount: 0, pointerWasPresent: true, ownsDisable: true })
  assert.equal(result.action, "enable")
  assert.equal(result.reason, "restoring-owned-disable")
})

test("keeps a manually disabled touchpad off when the last pointer leaves", () => {
  // The user ran `omarchy-toggle-input-device touchpad off` themselves, so the
  // plugin never claimed the disable and must not undo it.
  const result = decide({ pointerCount: 0, pointerWasPresent: true, ownsDisable: false })
  assert.equal(result.action, "none")
  assert.equal(result.reason, "disable-not-owned")
})

test("clears the override once the last pointer leaves, and not before", () => {
  const gone = decide({ pointerCount: 0, pointerWasPresent: true, overrideActive: true })
  assert.equal(gone.clearOverride, true)

  const stillConnected = decide({ pointerCount: 1, pointerWasPresent: false, overrideActive: true })
  assert.equal(stillConnected.clearOverride, false)
})

test("first evaluation acts even though nothing has transitioned", () => {
  // pointerWasPresent starts false, so a boot with no pointer connected looks
  // like "no transition" to the transition check. The first evaluation has to
  // apply the resolved state anyway.
  const owned = decide({ pointerCount: 0, pointerWasPresent: false, firstEvaluation: true, ownsDisable: true })
  assert.equal(owned.action, "enable")
  assert.equal(owned.reason, "restoring-owned-disable")
})

test("first evaluation does not resurrect a touchpad the user disabled", () => {
  // The behaviour this whole change exists for. Before ownership tracking, this
  // case enabled the touchpad unconditionally and discarded the user's choice on
  // every shell restart.
  const result = decide({ pointerCount: 0, pointerWasPresent: false, firstEvaluation: true, ownsDisable: false })
  assert.equal(result.action, "none")
  assert.equal(result.reason, "disable-not-owned")
})

test("first evaluation with a pointer already connected disables the touchpad", () => {
  const result = decide({ pointerCount: 1, pointerWasPresent: false, firstEvaluation: true })
  assert.equal(result.action, "disable")
  assert.equal(result.reason, "pointer-connected")
})

test("treats a malformed count as no pointers rather than guessing", () => {
  const result = decide({ pointerCount: model.parseCount("garbage"), pointerWasPresent: true, ownsDisable: true })
  assert.equal(result.action, "enable")
})
