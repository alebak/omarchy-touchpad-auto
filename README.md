# Touchpad Auto

An [Omarchy](https://omarchy.org) service plugin that disables the built-in
touchpad automatically when an external mouse or trackpad is connected, and
re-enables it the moment the last one disconnects.

The built-in touchpad sits right under your palms while you type. On a
clickpad, resting weight there does not just drift the cursor -- it registers
as a held click, which is what turns typing into stray window drags and
misfires the moment you plug in a real mouse and forget the touchpad is still
live underneath your hands.

GNOME has solved this for years: its
`org.gnome.desktop.peripherals.touchpad send-events` setting accepts
`disabled-on-external-mouse`, and libinput has carried
`LIBINPUT_CONFIG_SEND_EVENTS_DISABLED_ON_EXTERNAL_MOUSE` all along. Hyprland
exposes no equivalent: the upstream request,
[hyprwm/Hyprland#4454](https://github.com/hyprwm/Hyprland/issues/4454), was
closed `NOT_PLANNED`. This plugin fills that gap at the shell level instead,
using Omarchy's own input-toggle tooling.

## Install

```bash
omarchy plugin add https://github.com/alebak/omarchy-touchpad-auto.git --enable
```

Needs `udevadm`, `notify-send`, and `jq` -- all of which an Omarchy install
already has. Nothing else to configure; it starts watching as soon as it is
enabled.

## What it does

1. A background `udevadm monitor --udev --subsystem-match=input` process
   watches for any input device change. Its output lines are used **only**
   as a "something changed" signal, never as the source of truth --
   `remove` events carry incomplete udev properties, so parsing them
   directly leads to phantom state.
2. Every signal is debounced (400ms by default, configurable) to coalesce
   the burst of events a single plug or unplug generates.
3. When the debounce fires, `bin/omarchy-touchpad-auto-count` re-enumerates
   `/dev/input/event*` from scratch and prints a single authoritative count
   of currently connected external pointers.
4. The plugin compares that count against its last known state and acts on
   an actual transition (and, once at startup, applies whatever the current
   state resolves to -- see **Fail-safe by design** below for why):
   - **A pointer appears:** disables the touchpad.
   - **The last pointer disappears:** re-enables the touchpad.
5. The plugin raises no notification of its own for either transition. The
   actual toggle is delegated to `omarchy-toggle-input-device`, which already
   shows Omarchy's own OSD ("Touchpad enabled"/"disabled") the moment it
   runs -- a notification from this plugin on top would just duplicate that
   and clutter your notification center. This is deliberate, not a missing
   feature: see **Notifications** below for the one case where the plugin
   does speak up, and **Override** for how to tell it to back off.

**What counts as an external pointer:**
- A plain mouse: `ID_INPUT_MOUSE=1` and neither `ID_INPUT_TOUCHPAD=1` nor
  `ID_INPUT_POINTINGSTICK=1`.
- An external trackpad, such as an Apple Magic Trackpad over Bluetooth:
  `ID_INPUT_TOUCHPAD=1` and `ID_INPUT_TOUCHPAD_INTEGRATION=external`. These
  report no `ID_INPUT_MOUSE` at all, which is why they need their own rule.

**Never counted, no matter what:**
- Anything with `ID_INPUT_POINTINGSTICK=1`. On a ThinkPad, the TrackPoint
  also advertises `ID_INPUT_MOUSE=1` -- without this exclusion, the
  TrackPoint itself would disable the touchpad on every boot.
- Any touchpad reported as `internal`, or with the integration property
  **absent**. That property comes from udev's own integration rules, which
  can leave it unset for some USB devices. An unclassified touchpad is left
  alone rather than guessed at either way.

The actual enable/disable is delegated entirely to Omarchy's own
`omarchy-toggle-input-device touchpad <on|off>`, which persists the state
under `~/.local/state/omarchy/toggles/hypr/touchpad-disabled-name` so it
survives a Hyprland reload or reboot. This plugin never calls `hyprctl`
directly.

## Fail-safe by design

Two failure modes get handled deliberately rather than assumed away:

- **Touchpad left disabled across a reboot.** Because the disable persists
  to disk, a machine that reboots with no pointer connected would otherwise
  never get a "transition" to re-enable it -- no mouse at boot looks
  identical to no mouse a minute ago. The plugin always applies the resolved
  state once at startup, whether or not anything changed, specifically to
  recover from this.
- **Ambiguous touchpad identity.** Omarchy's own resolver,
  `omarchy-hw-touchpad`, picks the first device whose name matches
  `touchpad|trackpad` -- and with an external trackpad connected, that can
  be the wrong one. This is a confirmed upstream bug,
  [omacom/omarchy#12029](https://github.com/omacom/omarchy/issues/12029).
  Before every toggle, this plugin independently resolves the built-in
  touchpad via udev integration data and compares it against
  `omarchy-hw-touchpad`'s answer. If they disagree, or the built-in touchpad
  can't be resolved unambiguously, it refuses to toggle anything, logs both
  values, and shows a one-time "paused" notification instead of guessing and
  possibly disabling the wrong device.

## Notifications

This "paused" warning above is the only notification the plugin raises. Every
enable/disable transition stays silent on purpose (see **What it does**
above) -- but the paused warning reports an error condition the identity
check refused to guess through, and that needs to survive being missed. An
OSD fades in a couple of seconds; if you were away from the screen or looked
away at the wrong moment, it's gone. A regular notification sits in your
notification center until you actually see it, which matters here because
the plugin stops doing anything useful (no more auto-disable/enable) the
moment it pauses.

The `notify` config key (see **Config** below) controls only this one
notification.

## A note on Bluetooth pointers

A USB mouse is detected the instant it is plugged or unplugged -- that is a
physical bus event. A Bluetooth device is not. When you switch one off it
simply stops answering, and the host only declares it gone once the connection
supervision timeout expires, which takes several seconds.

So with a Bluetooth mouse or trackpad, expect a short delay between switching
it off and the touchpad coming back. That wait belongs to the Bluetooth stack,
not to this plugin: the debounce here is 400ms, and the recount runs as soon as
the kernel reports the change. Nothing is stuck.

## Override

Telling the plugin to back off is reached through `omarchy-shell`'s IPC, so it
can be bound to whatever key you like. The plugin does not claim a shortcut of
its own: a plugin that assigns itself keys is a plugin that silently steals one
of yours.

First check the combination is free on your setup:

```bash
omarchy menu keybindings --print | grep -i "SUPER SHIFT + T"
```

If that prints nothing, the combination is available. Then add the binding --
this appends it only once, so it is safe to run again:

```bash
grep -q "touchpad-auto override" ~/.config/hypr/bindings.lua || cat >> ~/.config/hypr/bindings.lua <<'EOF'

-- Touchpad Auto: leave the touchpad on while a pointer stays connected
o.bind("SUPER + SHIFT + T", "Touchpad override", "omarchy-shell touchpad-auto override")
EOF
```

Hyprland reloads on save, so the binding is live immediately.

`SUPER + SHIFT + T` is only a suggestion. To use a different key, edit the line
in `~/.config/hypr/bindings.lua` -- and if the combination you want is already
taken, call `hl.unbind` for it before your `o.bind`, as Omarchy's own bindings
do:

```lua
hl.unbind("SUPER + SHIFT + T")
o.bind("SUPER + SHIFT + T", "Touchpad override", "omarchy-shell touchpad-auto override")
```

Running the override while a pointer is connected tells the plugin to back off
and leave the touchpad enabled, even though an external pointer is still
plugged in. It resets automatically the moment every external pointer is
disconnected, so the next connection is treated as fresh.

To check the plugin's current state at any time, including whether the override
is active:

```bash
omarchy-shell touchpad-auto status
```

## Config

Add a `touchpadAuto` section to `~/.config/omarchy/shell.json`:

```json
{
  "touchpadAuto": {
    "enabled": true,
    "notify": true,
    "debounceMs": 400
  }
}
```

| Key          | Type | Default | Description                                                 |
|--------------|------|---------|---------------------------------------------------------------|
| `enabled`    | bool | `true`  | Turns the whole plugin on or off.                             |
| `notify`     | bool | `true`  | Shows the identity-mismatch "paused" notification (see **Notifications**). |
| `debounceMs` | int  | `400`   | Debounce window (ms) before re-counting connected pointers.   |

## Uninstall

```bash
omarchy plugin remove alebak.touchpad-auto
```

## Status

This is a **prototype**, built to be offered upstream as a contribution to
Omarchy. It has been validated with `omarchy plugin validate` and manual
testing of both helper scripts, but has not yet been through Omarchy's
contribution/review process, nor tested across a wide range of external mice
and trackpads. Feedback and issues are welcome before that happens.

**Tested:** installed and enabled on Omarchy 4.0.3 with Hyprland 0.56.2, on a
ThinkPad E595 with a built-in Synaptics PS/2 clickpad, a TrackPoint, a Lenovo
USB receiver mouse, and an Apple Magic Trackpad over Bluetooth. Verified live
on that machine:
- The service loads and its udev monitor runs.
- External pointers are counted correctly (2, with the mouse and the Magic
  Trackpad both connected; the TrackPoint and the built-in touchpad are
  correctly excluded).
- Disconnecting the last external pointer re-enables the touchpad, and
  reconnecting one disables it again.
- The identity-mismatch fail-safe triggered for real: `omarchy-hw-touchpad`
  named the external trackpad, and the plugin correctly refused to toggle.

It has **not** been tested on any other hardware, or with any other external
pointer devices.

## License

MIT. See [LICENSE](LICENSE).
