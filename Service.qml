import QtQuick
import Quickshell.Io
import "TouchpadAutoModel.js" as TouchpadAutoModel

Item {
  id: root

  // Injected by omarchy-shell (the first-party service loader).
  property var shell: null

  // The helper scripts sit next to this file, so the plugin runs from
  // wherever it was installed (omarchy plugin add clones it under
  // ~/.config/omarchy/plugins/<id>/) without putting anything on $PATH.
  readonly property string countScriptPath:
    Qt.resolvedUrl("bin/omarchy-touchpad-auto-count").toString().replace(/^file:\/\//, "")
  readonly property string internalScriptPath:
    Qt.resolvedUrl("bin/omarchy-touchpad-auto-internal").toString().replace(/^file:\/\//, "")
  readonly property string iconPath:
    Qt.resolvedUrl("assets/touchpad.svg").toString().replace(/^file:\/\//, "")

  readonly property var touchpadAutoConfig: shell && shell.shellConfig && shell.shellConfig.touchpadAuto
    ? shell.shellConfig.touchpadAuto : ({})
  readonly property bool pluginEnabled: TouchpadAutoModel.boolFromConfig(touchpadAutoConfig.enabled, true)
  // Governs only the identity-mismatch "paused" notification below -- the
  // plugin no longer raises enable/disable notifications of its own, since
  // omarchy-toggle-input-device already shows Omarchy's OSD for those.
  readonly property bool notifyEnabled: TouchpadAutoModel.boolFromConfig(touchpadAutoConfig.notify, true)
  readonly property int debounceMs: TouchpadAutoModel.intFromConfig(touchpadAutoConfig.debounceMs, 400)

  // Last-known state, re-derived from scratch on every debounced recount.
  property bool pointerPresent: false

  // Set true right after the first recount has been applied. The very first
  // evaluation after startup must always APPLY the resolved state, not just
  // react to a transition: the touchpad's disabled state PERSISTS across
  // reboots (Omarchy writes it to
  // ~/.local/state/omarchy/toggles/hypr/touchpad-disabled-name), so a boot
  // with no external pointer connected has pointerPresent === false ===
  // wasPresent on the very first recount. A transition-only check would see
  // "no change" and never re-enable a touchpad left disabled from a previous
  // session, leaving the user with no touchpad and no mouse. Every
  // evaluation after this first one goes back to being transition-based.
  property bool firstEvaluationDone: false

  // Manual override: set via the IPC `override` call (see the IpcHandler
  // below) while a pointer is still connected. Cleared the moment the last
  // external pointer is unplugged, so the next connection is treated as
  // fresh.
  property bool overrideActive: false

  property bool countPending: false
  property bool hasPendingToggle: false
  property bool pendingToggleEnable: false

  // ---------------------------------------------------- identity-check state
  //
  // omacom/omarchy#12029: omarchy-hw-touchpad can name the wrong device when
  // an external trackpad is connected (see resolveAndToggle() below), so
  // every toggle is gated on independently confirming the two agree first.
  property bool identityCheckRunning: false
  property bool hasPendingIdentityToggle: false
  property bool pendingIdentityEnable: false
  property bool identityEnable: false
  property string identityHwName: ""
  property string identityInternalName: ""
  property bool identityWarnedThisSession: false

  property string lastEvent: "starting"
  property string lastEventAt: ""

  function nowIso() {
    return new Date().toISOString()
  }

  function logEvent(event, details) {
    var suffix = details === undefined || details === null || details === "" ? "" : ": " + String(details)
    root.lastEventAt = nowIso()
    root.lastEvent = event + suffix
    console.log("omarchy touchpad-auto " + root.lastEventAt + " " + root.lastEvent)
  }

  // ------------------------------------------------------------- recounting

  function scheduleRecount() {
    if (!root.pluginEnabled) return
    debounceTimer.restart()
  }

  function runCount() {
    if (countProcess.running) {
      root.countPending = true
      return
    }
    root.countPending = false
    countProcess.running = true
  }

  function handleCountResult(text) {
    var count = TouchpadAutoModel.parseCount(text)
    logEvent("recount", count + " external pointer(s) detected")
    applyPointerState(count)
  }

  function applyPointerState(count) {
    var present = count > 0
    var wasPresent = root.pointerPresent
    var isFirstEvaluation = !root.firstEvaluationDone
    root.firstEvaluationDone = true
    root.pointerPresent = present

    if (!isFirstEvaluation && present === wasPresent) {
      logEvent("no-transition", "pointerPresent=" + present)
      return
    }

    if (present) {
      if (root.overrideActive) {
        logEvent("skip-disable", "external pointer connected but override active")
        return
      }
      setTouchpad(false)
    } else {
      root.overrideActive = false
      setTouchpad(true)
    }
  }

  // --------------------------------------------------------- touchpad toggle

  function setTouchpad(enable) {
    logEvent("touchpad", enable ? "enabling" : "disabling")
    requestToggle(enable)
  }

  // Queues an identity-checked toggle. Only one identity check runs at a
  // time; a request that arrives while one is in flight replaces whatever
  // was previously queued (only the latest desired state matters) and runs
  // right after the in-flight check finishes.
  function requestToggle(enable) {
    if (root.identityCheckRunning) {
      root.pendingIdentityEnable = enable
      root.hasPendingIdentityToggle = true
      return
    }
    root.identityCheckRunning = true
    root.identityEnable = enable
    root.identityHwName = ""
    root.identityInternalName = ""
    hwTouchpadProcess.running = true
  }

  function handleHwTouchpadResult(text) {
    root.identityHwName = String(text || "").trim()
    internalTouchpadProcess.running = true
  }

  // Runs once omarchy-hw-touchpad and omarchy-touchpad-auto-internal have
  // both reported. Only toggles when they agree on the same device name; see
  // the identity-check state comment above for why this check exists.
  function handleInternalTouchpadExit(exitCode) {
    var resolvedOk = exitCode === 0 && root.identityInternalName !== ""
    var hwName = root.identityHwName
    var internalName = root.identityInternalName
    var enable = root.identityEnable

    root.identityCheckRunning = false

    if (resolvedOk && hwName === internalName) {
      runToggle(enable)
    } else {
      var detail = "hyprland=" + (hwName || "(empty)") +
        " internal=" + (resolvedOk ? internalName : "(unresolved)")
      logEvent("identity-mismatch", detail + " -- see omacom/omarchy#12029, refusing to toggle")
      warnIdentityMismatchOnce()
    }

    if (root.hasPendingIdentityToggle) {
      var nextEnable = root.pendingIdentityEnable
      root.hasPendingIdentityToggle = false
      requestToggle(nextEnable)
    }
  }

  function warnIdentityMismatchOnce() {
    if (root.identityWarnedThisSession) return
    root.identityWarnedThisSession = true
    if (root.notifyEnabled) {
      runNotify("Touchpad Auto paused",
        "Can't identify the built-in touchpad safely (see omacom/omarchy#12029). Automatic switching is paused.")
    }
  }

  function runToggle(enable) {
    if (toggleProcess.running) {
      root.pendingToggleEnable = enable
      root.hasPendingToggle = true
      return
    }
    toggleProcess.command = ["omarchy-toggle-input-device", "touchpad", enable ? "on" : "off"]
    toggleProcess.running = true
  }

  // ------------------------------------------------------------- notifications
  //
  // This is the only notification the plugin raises. Enable/disable
  // transitions are deliberately silent here: omarchy-toggle-input-device
  // already shows Omarchy's own OSD for those, so a notification from this
  // plugin on top would just duplicate it and clutter the notification
  // center. This one stays because it reports an error condition (the
  // identity check refusing to guess) that the user must be able to review
  // later -- an ephemeral OSD would be lost the moment it fades.
  //
  // Uses an icon this plugin ships itself (assets/touchpad.svg) rather than
  // an XDG icon name: Omarchy's default theme (Yaru) inherits
  // Yaru/Humanity/hicolor, none of which ship input-touchpad, so naming it
  // would render a broken-image placeholder instead.
  function runNotify(summary, body) {
    if (notifyProcess.running) notifyProcess.running = false
    var args = ["notify-send", "--app-name=Touchpad Auto", "-i", root.iconPath, summary]
    if (body) args.push(body)
    notifyProcess.command = args
    notifyProcess.running = true
  }

  // Triggered via IPC (see the IpcHandler below), not a notification button:
  // while a pointer is still connected, tells the plugin to back off and
  // leave the touchpad enabled. Cleared automatically once every external
  // pointer disconnects (see applyPointerState above).
  function activateOverride() {
    logEvent("override", "user enabled the touchpad via override")
    root.overrideActive = true
    requestToggle(true)
  }

  // --------------------------------------------------------------- status

  function statusJson() {
    return JSON.stringify({
      enabled: root.pluginEnabled,
      notify: root.notifyEnabled,
      debounceMs: root.debounceMs,
      pointerPresent: root.pointerPresent,
      overrideActive: root.overrideActive,
      monitorRunning: monitorProcess.running,
      lastEvent: root.lastEvent,
      lastEventAt: root.lastEventAt
    })
  }

  // ---------------------------------------------------------------- wiring

  onPluginEnabledChanged: {
    if (root.pluginEnabled) {
      logEvent("plugin-enabled")
      if (!monitorProcess.running) monitorProcess.running = true
      scheduleRecount()
    } else {
      logEvent("plugin-disabled")
      debounceTimer.stop()
      monitorProcess.running = false
    }
  }

  Timer {
    id: debounceTimer
    interval: root.debounceMs
    repeat: false
    onTriggered: root.runCount()
  }

  Timer {
    id: monitorRestartTimer
    interval: 1000
    repeat: false
    onTriggered: {
      if (root.pluginEnabled && !monitorProcess.running) monitorProcess.running = true
    }
  }

  // Change signal only -- never the source of truth. `remove` events carry
  // incomplete udev properties, so every line just triggers a debounced,
  // from-scratch recount via bin/omarchy-touchpad-auto-count.
  Process {
    id: monitorProcess
    command: ["udevadm", "monitor", "--udev", "--subsystem-match=input"]
    stdout: SplitParser {
      onRead: function(line) { root.scheduleRecount() }
    }
    onExited: function(exitCode, exitStatus) {
      root.logEvent("monitor-exit", "exitCode=" + exitCode + " status=" + exitStatus + ", restarting")
      monitorRestartTimer.restart()
    }
  }

  Process {
    id: countProcess
    command: [root.countScriptPath]
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: root.handleCountResult(text)
    }
    onExited: function(exitCode) {
      if (exitCode !== 0) root.logEvent("count-error", "exitCode=" + exitCode)
      if (root.countPending) root.runCount()
    }
  }

  // First step of the identity check: ask Omarchy's own resolver what it
  // thinks the touchpad is.
  Process {
    id: hwTouchpadProcess
    command: ["omarchy-hw-touchpad"]
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: root.handleHwTouchpadResult(text)
    }
    onExited: function(exitCode) {
      if (exitCode !== 0) root.logEvent("hw-touchpad-error", "exitCode=" + exitCode)
    }
  }

  // Second step of the identity check: ask our own udev-based resolver for
  // the built-in touchpad, independently of Omarchy's name-substring match.
  // The comparison and the actual toggle both happen in
  // handleInternalTouchpadExit once this process has exited.
  Process {
    id: internalTouchpadProcess
    command: [root.internalScriptPath]
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: root.identityInternalName = String(text || "").trim()
    }
    onExited: function(exitCode) { root.handleInternalTouchpadExit(exitCode) }
  }

  Process {
    id: toggleProcess
    onExited: function(exitCode) {
      root.logEvent("toggle-exit", "exitCode=" + exitCode)
      if (root.hasPendingToggle) {
        var enable = root.pendingToggleEnable
        root.hasPendingToggle = false
        root.runToggle(enable)
      }
    }
  }

  // Notification process for the "paused" warning -- the only notification
  // this plugin raises. See the comment on runNotify() above for why.
  Process {
    id: notifyProcess
    onExited: function(exitCode) { root.logEvent("notify-exit", "exitCode=" + exitCode) }
  }

  Component.onCompleted: {
    logEvent("service-ready")
    if (root.pluginEnabled) {
      monitorProcess.running = true
      root.runCount()
    }
  }

  IpcHandler {
    target: "touchpad-auto"

    function status(): string {
      return root.statusJson()
    }

    function recount(): string {
      root.scheduleRecount()
      return "recounting"
    }

    function override(): string {
      root.activateOverride()
      return "override"
    }
  }
}
