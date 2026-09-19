const test = require("node:test")
const assert = require("node:assert/strict")
const { execFileSync } = require("node:child_process")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")

const HELPER = path.join(__dirname, "..", "bin", "omarchy-touchpad-auto-own")

// The helper is the only thing that reads or writes ownership, so it is tested
// as a process against a throwaway HOME. Both the marker it owns and Omarchy's
// touchpad-disabled-name that it consults live under $HOME/.local/state.

function withHome(fn) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "touchpad-auto-own-"))
  try {
    return fn({
      home,
      marker: path.join(home, ".local/state/omarchy/touchpad-auto/owned-disable"),
      omarchyName: path.join(home, ".local/state/omarchy/toggles/hypr/touchpad-disabled-name")
    })
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
}

function run(home, ...args) {
  try {
    const stdout = execFileSync(HELPER, args, { env: { ...process.env, HOME: home }, encoding: "utf8" })
    return { code: 0, stdout: stdout.trim() }
  } catch (error) {
    return { code: error.status, stdout: String(error.stdout || "").trim() }
  }
}

function writeOmarchyDisable(paths, name) {
  fs.mkdirSync(path.dirname(paths.omarchyName), { recursive: true })
  fs.writeFileSync(paths.omarchyName, name + "\n")
}

test("check reports no ownership when the marker is absent", () => {
  withHome((paths) => {
    const result = run(paths.home, "check")
    assert.equal(result.code, 1)
    assert.equal(result.stdout, "unowned")
  })
})

test("claim-unless-disabled takes ownership when the touchpad is currently enabled", () => {
  withHome((paths) => {
    // No touchpad-disabled-name, so nobody has it disabled and this plugin's
    // disable is what is about to turn it off.
    const result = run(paths.home, "claim-unless-disabled")
    assert.equal(result.code, 0)
    assert.equal(result.stdout, "owned")
    assert.ok(fs.existsSync(paths.marker), "marker should exist")

    const check = run(paths.home, "check")
    assert.equal(check.code, 0)
    assert.equal(check.stdout, "owned")
  })
})

test("claim-unless-disabled refuses to claim a disable the user already made", () => {
  withHome((paths) => {
    writeOmarchyDisable(paths, "synps/2-synaptics-touchpad")

    const result = run(paths.home, "claim-unless-disabled")
    assert.equal(result.code, 0)
    assert.equal(result.stdout, "unowned")
    assert.ok(!fs.existsSync(paths.marker), "must not claim a pre-existing disable")
  })
})

test("release drops ownership and is safe to repeat", () => {
  withHome((paths) => {
    run(paths.home, "claim-unless-disabled")
    assert.ok(fs.existsSync(paths.marker))

    const first = run(paths.home, "release")
    assert.equal(first.code, 0)
    assert.equal(first.stdout, "unowned")
    assert.ok(!fs.existsSync(paths.marker))

    const second = run(paths.home, "release")
    assert.equal(second.code, 0, "releasing twice is not an error")
  })
})

test("claiming twice stays owned rather than failing", () => {
  withHome((paths) => {
    run(paths.home, "claim-unless-disabled")
    const again = run(paths.home, "claim-unless-disabled")
    assert.equal(again.code, 0)
    assert.equal(again.stdout, "owned")
  })
})

test("ownership survives a fresh process, which is the point of a file", () => {
  withHome((paths) => {
    run(paths.home, "claim-unless-disabled")
    // A shell restart is exactly this: a new process reading the same HOME.
    const afterRestart = run(paths.home, "check")
    assert.equal(afterRestart.stdout, "owned")
  })
})

test("marker-path publishes the marker location so nothing has to hardcode it", () => {
  // Service.qml needs this path to clean up on unload, when the plugin's own
  // bin/ may already have been deleted. Asking the helper keeps one source of
  // truth instead of the same path written in two files that drift apart.
  withHome((paths) => {
    const result = run(paths.home, "marker-path")
    assert.equal(result.code, 0)
    assert.equal(result.stdout, paths.marker)

    // And it is the path actually used, not a plausible-looking string.
    run(paths.home, "claim-unless-disabled")
    assert.ok(fs.existsSync(result.stdout), "the published path is the one claimed")
  })
})

test("marker-path works before the state directory exists", () => {
  withHome((paths) => {
    assert.ok(!fs.existsSync(path.dirname(paths.marker)))
    assert.equal(run(paths.home, "marker-path").code, 0)
  })
})

test("an unknown subcommand fails loudly instead of doing nothing", () => {
  withHome((paths) => {
    const result = run(paths.home, "wat")
    assert.equal(result.code, 2)
  })
})

test("no subcommand fails loudly", () => {
  withHome((paths) => {
    const result = run(paths.home)
    assert.equal(result.code, 2)
  })
})
