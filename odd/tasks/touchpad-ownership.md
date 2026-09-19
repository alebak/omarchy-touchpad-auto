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

- [x] T1. Add a node-based test runner and cover the current decision logic in
      `TouchpadAutoModel.js` as a baseline.
- [x] T2. Move the enable/disable decision into `TouchpadAutoModel.js` as a pure
      function of (pointer count, ownership, first evaluation), with tests written
      first for each case: manual disable preserved, owned disable restored, first
      evaluation with and without the marker, override active.
- [x] T3. Add `bin/omarchy-touchpad-auto-own` with `claim-unless-disabled`,
      `release`, and `check`, reading Omarchy's `touchpad-disabled-name` to decide
      whether a claim is warranted.
- [x] T4. Wire ownership into `Service.qml`: read the marker before the first
      evaluation, claim before disabling, release on enable.
- [x] T5. Add `Component.onDestruction` restoration via `Quickshell.execDetached()`,
      and restore on the `onPluginEnabledChanged` disable path.
- [x] T6. Replace the per-device `udevadm` loops in
      `bin/omarchy-touchpad-auto-count` and `bin/omarchy-touchpad-auto-internal`
      with a single `udevadm info --export-db` call each.
- [x] T7. Document the ownership contract and its known limitation in `README.md`.

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

T1 done (`d154403`): `node --test` from the repository root, 4 baseline tests over
the config helpers. `node --test test/` does not work on node 26, which resolves
the argument as a module rather than a directory.

T2 done (`8a8cae2`): `decideAction()` in `TouchpadAutoModel.js`, 10 tests written
first and observed failing, then passing. Not yet wired into `Service.qml`.

T3 done (`7a5c499`): `bin/omarchy-touchpad-auto-own` with
`claim-unless-disabled`, `release` and `check`. 8 tests written first and observed
failing, then passing. Tested as a process against a throwaway `$HOME`, covering a
claim over a user's pre-existing disable, repeated claim and release, and survival
across a fresh process. Not yet wired into `Service.qml`.

T4 done (`cd3d01f`): `applyPointerState()` delegates to `decideAction()`; monitoring
starts only after the marker is read; the claim runs before the disable and the
release after the enable lands. `qmllint`: 0 errors, and every remaining warning is
the pre-existing `signal-handler-parameters` class caused by Quickshell types being
absent from qmllint's import path.

T5 done (`50f0924`): `Component.onDestruction` and the plugin-disabled path both
call `restoreOnStop()`, which uses `Quickshell.execDetached()` with system binaries
only. The helper gained `marker-path` so the marker location is not rebuilt in QML.

Suite: 24 passing, 0 failing. `qmllint`: 0 errors.

VERIFICATION GAP: qmllint cannot resolve Quickshell's own types (it reports
`QProcess::ExitStatus` as not found), so it does not prove the
`Quickshell.execDetached()` call is correct at runtime. The signature was checked
against `quickshell-core.qmltypes`, which declares it taking a QString list, and the
call passes a list of strings. Real proof needs the plugin loaded in the shell.

T6 done (`e77b9f8`): one `udevadm info --export-db` per scan. Measured on the
affected machine, best of five: `count` 103 ms -> 60 ms, `internal` 112 ms -> 57 ms,
both returning identical results. The gain is ~1.9x, not the ~4x the raw udevadm
comparison suggested, because bash startup and parsing dominate what is left. The
task's own justification is corrected accordingly. Records are filtered on DEVNAME
matching /dev/input/event*, since the database also carries inputN and mouseN nodes
that would double-count and create phantom resolver candidates.

Suite: 35 passing, 0 failing.

FOUND, NOT FIXED, out of this task's scope: `omarchy-touchpad-auto-internal`
normalises the Hyprland name with `tr ' ' '-'` but does not replace commas, which
Hyprland does. A touchpad whose name contains a comma would resolve to a name that
never matches, and the identity check would refuse to toggle forever. One line plus
a test; deliberately left for a separate change.

T7 done (`d824dad`): `README.md` gained a 'Whose disable is it' section with the
rule, why the marker is a file, the stop behaviour, and the manual recovery for a
killed shell. The limitation has its own subsection. Status now separates what is
proven on hardware from what only the suite covers, and the live-test bullet is
marked as predating ownership tracking.

All seven tasks complete. Suite: 35 passing, 0 failing. `qmllint`: 0 errors.

LIVE VERIFICATION DONE (2026-09-19, branch installed in the running shell):

- Claim lands before the toggle: `claimed this disable` at .122, `toggle-exit` at
  .226.
- Restore on stop works, through `Component.onDestruction`, the same path
  `omarchy plugin remove` takes. Before: touchpad off, marker present. After:
  touchpad on, marker gone. THIS CLOSES THE T5 VERIFICATION GAP:
  `Quickshell.execDetached()` is proven in a real shell.
- Claim refuses a user's disable: `touchpad was already disabled, leaving that
  disable to its owner`, `ownsDisable: false`.
- The user's disable survives the last pointer disconnecting: 0 pointers,
  `disable-not-owned`, touchpad stayed off. The old code enabled it here. This is
  the defect this change exists for, confirmed fixed on hardware.

All four acceptance criteria met.

DISCOVERED DURING THE LIVE TEST:
- Ownership is cached in memory and re-read only on start or re-enable. Editing the
  marker by hand while running is not noticed. Documented in README, not defended
  against, since nothing but the plugin writes it in normal use.
- `git checkout` of a branch in the installed plugin fires one Quickshell reload per
  changed file. Twenty in one second left the service not running at all, with the
  stale instance still owning the IPC target and no error logged. `omarchy restart
  shell` was required. Hot reload is only reliable for one- or two-file edits.

REMAINING:
1. the marketplace update: the **Plugin verification** issue form, action
   "Verify and publish a newer upstream commit", plugin ID
   `io.github.alebak.touchpad-auto`, repository URL, and the full 40-character SHA
   of the merged HEAD. Pushing to main without filing it makes the listing show
   `Update unverified`.
