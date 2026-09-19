const test = require("node:test")
const assert = require("node:assert/strict")
const { execFileSync } = require("node:child_process")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")

const BIN = path.join(__dirname, "..", "bin")
const COUNT = path.join(BIN, "omarchy-touchpad-auto-count")
const INTERNAL = path.join(BIN, "omarchy-touchpad-auto-internal")

// Both scanners are driven through a fake `udevadm` on PATH that replays a
// fixture database, so the classification rules can be exercised without the
// hardware they describe. The fixtures are shaped like real
// `udevadm info --export-db` output: records separated by blank lines, with
// properties on `E: KEY=VALUE` lines.

function record(props) {
  return Object.entries(props).map(([k, v]) => `E: ${k}=${v}`).join("\n")
}

function eventDevice(n, props) {
  return record(Object.assign({
    DEVPATH: `/devices/fake/input/input${n}/event${n}`,
    DEVNAME: `/dev/input/event${n}`,
    SUBSYSTEM: "input"
  }, props))
}

function withFixture(records, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "touchpad-auto-scan-"))
  try {
    fs.mkdirSync(path.join(dir, "bin"))
    fs.writeFileSync(path.join(dir, "db"), records.join("\n\n") + "\n")
    fs.writeFileSync(path.join(dir, "bin", "udevadm"),
      '#!/bin/bash\ncat "$FAKE_UDEV_DB"\n', { mode: 0o755 })
    fn({
      dir,
      run(script, extraEnv) {
        const env = Object.assign({
          ...process.env,
          PATH: `${path.join(dir, "bin")}:${process.env.PATH}`,
          FAKE_UDEV_DB: path.join(dir, "db")
        }, extraEnv || {})
        try {
          return { code: 0, stdout: execFileSync(script, { env, encoding: "utf8" }).trim() }
        } catch (error) {
          return { code: error.status, stdout: String(error.stdout || "").trim() }
        }
      },
      sysfs(number, name) {
        const p = path.join(dir, "sys", `event${number}`, "device")
        fs.mkdirSync(p, { recursive: true })
        fs.writeFileSync(path.join(p, "name"), name + "\n")
        return path.join(dir, "sys")
      }
    })
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

const INTERNAL_PAD = { ID_INPUT: 1, ID_INPUT_TOUCHPAD: 1, ID_INPUT_TOUCHPAD_INTEGRATION: "internal", ID_BUS: "i8042", ID_SERIAL: "noserial" }
const EXTERNAL_PAD = { ID_INPUT: 1, ID_INPUT_TOUCHPAD: 1, ID_INPUT_TOUCHPAD_INTEGRATION: "external", ID_BUS: "bluetooth", ID_SERIAL: "apple-pad" }
const TRACKPOINT = { ID_INPUT: 1, ID_INPUT_MOUSE: 1, ID_INPUT_POINTINGSTICK: 1, ID_SERIAL: "noserial-tp" }
const USB_MOUSE = { ID_INPUT: 1, ID_INPUT_MOUSE: 1, ID_SERIAL: "logitech-receiver" }

test("counts no external pointers on a bare laptop", () => {
  withFixture([eventDevice(17, INTERNAL_PAD), eventDevice(18, TRACKPOINT)], (t) => {
    assert.equal(t.run(COUNT).stdout, "0")
  })
})

test("counts an external trackpad that does not claim to be a mouse", () => {
  // The Apple Magic Trackpad reports ID_INPUT_TOUCHPAD but not
  // ID_INPUT_MOUSE, so integration is the only thing that classifies it.
  withFixture([eventDevice(17, INTERNAL_PAD), eventDevice(19, EXTERNAL_PAD)], (t) => {
    assert.equal(t.run(COUNT).stdout, "1")
  })
})

test("counts a plain USB mouse", () => {
  withFixture([eventDevice(17, INTERNAL_PAD), eventDevice(20, USB_MOUSE)], (t) => {
    assert.equal(t.run(COUNT).stdout, "1")
  })
})

test("never counts a pointing stick, which also reports itself a mouse", () => {
  withFixture([eventDevice(18, TRACKPOINT)], (t) => {
    assert.equal(t.run(COUNT).stdout, "0")
  })
})

test("does not count a touchpad whose integration is unknown", () => {
  // Fail safe: only a positively-classified "external" counts. Acting on an
  // unclassified device is worse than ignoring it.
  withFixture([eventDevice(21, { ID_INPUT: 1, ID_INPUT_TOUCHPAD: 1, ID_SERIAL: "mystery" })], (t) => {
    assert.equal(t.run(COUNT).stdout, "0")
  })
})

test("counts one physical device once even with several event nodes", () => {
  withFixture([
    eventDevice(20, USB_MOUSE),
    eventDevice(21, USB_MOUSE)
  ], (t) => {
    assert.equal(t.run(COUNT).stdout, "1")
  })
})

test("counts two genuinely different external pointers separately", () => {
  withFixture([eventDevice(19, EXTERNAL_PAD), eventDevice(20, USB_MOUSE)], (t) => {
    assert.equal(t.run(COUNT).stdout, "2")
  })
})

test("resolves the built-in touchpad to its Hyprland name", () => {
  withFixture([eventDevice(17, INTERNAL_PAD), eventDevice(19, EXTERNAL_PAD)], (t) => {
    const sys = t.sysfs(17, "SynPS/2 Synaptics TouchPad")
    const result = t.run(INTERNAL, { OMARCHY_INPUT_CLASS_PATH: sys })
    assert.equal(result.code, 0)
    assert.equal(result.stdout, "synps/2-synaptics-touchpad")
  })
})

test("refuses to guess when no internal touchpad exists", () => {
  withFixture([eventDevice(19, EXTERNAL_PAD)], (t) => {
    const result = t.run(INTERNAL, { OMARCHY_INPUT_CLASS_PATH: t.sysfs(19, "Apple Wireless Trackpad") })
    assert.equal(result.code, 1)
    assert.equal(result.stdout, "")
  })
})

test("refuses to guess when two devices claim to be the internal touchpad", () => {
  withFixture([
    eventDevice(17, INTERNAL_PAD),
    eventDevice(22, Object.assign({}, INTERNAL_PAD, { ID_SERIAL: "other" }))
  ], (t) => {
    t.sysfs(17, "SynPS/2 Synaptics TouchPad")
    const result = t.run(INTERNAL, { OMARCHY_INPUT_CLASS_PATH: t.sysfs(22, "Other Internal Pad") })
    assert.equal(result.code, 1)
  })
})

test("each scan spawns exactly one udevadm, not one per device", () => {
  // The reason this change exists. Measured on the affected machine:
  // 133.7 ms for a 15-device loop against 35.8 ms for a single call, on the
  // path the user waits through before the touchpad comes back.
  withFixture([
    eventDevice(17, INTERNAL_PAD),
    eventDevice(18, TRACKPOINT),
    eventDevice(19, EXTERNAL_PAD),
    eventDevice(20, USB_MOUSE)
  ], (t) => {
    const counter = path.join(t.dir, "calls")
    fs.writeFileSync(path.join(t.dir, "bin", "udevadm"),
      `#!/bin/bash\necho x >>"${counter}"\ncat "$FAKE_UDEV_DB"\n`, { mode: 0o755 })

    t.run(COUNT)
    const calls = fs.readFileSync(counter, "utf8").trim().split("\n").length
    assert.equal(calls, 1, `expected a single udevadm call, got ${calls}`)
  })
})
