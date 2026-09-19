# Touchpad ownership

## Objective

Make the plugin act only on a disabled state it created itself, and restore that
state before it stops running.

## Problem

The service decides whether to enable the touchpad from the external-pointer count
alone. It never records whether the current disabled state came from this plugin or
from the user, so two user-visible defects follow.

**Enabling a manually disabled touchpad.** `applyPointerState()` calls
`setTouchpad(true)` whenever the last external pointer disconnects, and
unconditionally on the first evaluation after startup. A touchpad the user disabled
with `omarchy-toggle-input-device touchpad off` is silently re-enabled on the next
pointer disconnect, or on the next shell restart.

**No restoration on unload.** `Service.qml` has no `Component.onDestruction`
handler, and the `onPluginEnabledChanged` disable path stops the monitor and the
debounce timer without restoring the touchpad. Disabling or removing the plugin
while it holds the touchpad disabled leaves the machine with no touchpad and
nothing left running that knows how to restore it. Omarchy persists the disabled
state independently of the service lifetime, so it survives a reboot.

Both were reported by @ywenhao in
[omarchy-plugin-marketplace#4127](https://github.com/omacom/omarchy-plugin-marketplace/issues/4127)
against approved snapshot `b7bcc45`, and both reproduce on reading the source.

## Why

The plugin currently assumes it is the only writer of the touchpad enabled state.
It is not: the user has a keybinding and a command for the same state, and Omarchy
persists it across reboots. Acting on a state it did not create makes the plugin
override deliberate user choices, and leaving without restoring makes removal
destructive.

## Approach

Record authorship, not state. A durable marker at
`$HOME/.local/state/omarchy/touchpad-auto/owned-disable` means "this plugin caused
the touchpad to be disabled and is responsible for re-enabling it".

- Claim only when the plugin's own disable is what turns the touchpad off. If
  Omarchy's `touchpad-disabled-name` already exists, the disable belongs to the
  user and no claim is made.
- Re-enable only while the marker exists. Without it, leave the touchpad alone.
- Release the marker whenever the plugin re-enables the touchpad.
- On unload, restore and release if the marker is held.

The marker has to outlive the process because the disabled state does. An
in-memory flag would lose ownership on every shell restart and reintroduce the
first defect.

Restoration on unload runs through `Quickshell.execDetached()` (available in
Quickshell 0.3.1) invoking `omarchy-toggle-input-device`, which lives in `/usr/bin`.
Neither depends on the plugin directory, which `omarchy plugin remove` deletes.

## Scope

In scope: ownership tracking, unload restoration, unit tests for the decision
logic, and collapsing the per-device `udevadm` loops into a single
`udevadm --export-db` call per scan.

The `udevadm` change is included because it is measured at 133.7 ms for 15 calls
against 35.8 ms for one, on the toggle path the user waits through, and because the
same pattern is a recorded review finding on #4127.

Out of scope: the `omarchy-hw-touchpad` device-resolution defect
([omarchy#12029](https://github.com/omacom/omarchy/issues/12029)), which is fixed
upstream in omarchy#12307. The existing identity check stays as it is.

## Constraints

- The published marketplace snapshot is `b7bcc45`. Updating the listing requires
  the **Plugin verification** issue form with the action "Verify and publish a
  newer upstream commit" and the full 40-character SHA of the new HEAD. Pushing
  without filing it makes the listing show `Update unverified`.
- Ownership cannot be proven causally. Between reading Omarchy's state file and
  issuing the toggle, another writer can change the live state. The marker narrows
  the window; it does not close it. Documented, not hidden.
- No test harness exists in this repository yet.

## Tasks

- [ ] T1. Add a node-based test runner and cover the current decision logic in
      `TouchpadAutoModel.js` as a baseline.
- [ ] T2. Move the enable/disable decision into `TouchpadAutoModel.js` as a pure
      function of (pointer count, ownership, first evaluation), with tests written
      first for each case: manual disable preserved, owned disable restored, first
      evaluation with and without the marker, override active.
- [ ] T3. Add `bin/omarchy-touchpad-auto-own` with `claim-unless-disabled`,
      `release`, and `check`, reading Omarchy's `touchpad-disabled-name` to decide
      whether a claim is warranted.
- [ ] T4. Wire ownership into `Service.qml`: read the marker before the first
      evaluation, claim before disabling, release on enable.
- [ ] T5. Add `Component.onDestruction` restoration via `Quickshell.execDetached()`,
      and restore on the `onPluginEnabledChanged` disable path.
- [ ] T6. Replace the per-device `udevadm` loops in
      `bin/omarchy-touchpad-auto-count` and `bin/omarchy-touchpad-auto-internal`
      with a single `udevadm info --export-db` call each.
- [ ] T7. Document the ownership contract and its known limitation in `README.md`.

## Acceptance criteria

- A touchpad disabled by the user stays disabled across pointer connect/disconnect
  cycles and across a shell restart.
- A touchpad disabled by the plugin is restored when the last external pointer
  disconnects, when the plugin is disabled, and when the plugin is removed.
- Removing the plugin never leaves the touchpad disabled with nothing to restore it.
- Each scan issues one `udevadm` process rather than one per input device.

## Checks

- `node --test` for the decision logic.
- Manual verification on the reporting hardware: ThinkPad E595, built-in
  `SynPS/2 Synaptics TouchPad`, Apple Magic Trackpad over Bluetooth, Lenovo USB
  receiver.

## Delivery

Strategy: `single-pr`. Forecast is well under the 400 authored-line budget.

## Progress

Not started. This document is the PR's problem statement.
