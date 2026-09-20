import { CleanReduxState } from '../renderer/redux/store'
import {
  isGroupTimedActive,
  isGroupTimedOverdue,
  timedFlashPhaseOn,
} from './groupControl'
import type { GroupControl, GroupControlState } from './groupControl'

/**
 * Which bound controls are currently doing something, so the controller can light them.
 *
 * A lamp answers the question "is this control active right now", not "was this pad
 * pressed" — so it follows the state however it got there: a pad, a click on the group
 * card, a lock left standing after the pad was let go, or a scene change dropping one.
 *
 * Only controls with a genuine on/off state are reported. One-shots and controls whose
 * state Captivate does not model are left out of the map entirely rather than reported
 * dark, so the map stays a statement about what is actually known.
 */

export const MIDI_FEEDBACK_ENABLED = true

function groupOf(
  groupControl: GroupControlState | undefined,
  group: string
): GroupControl | undefined {
  return groupControl?.byGroup?.[group]
}

/** Engaged by a press, or standing on a lock after the press ended. Same lamp either way. */
function strobeActive(control: GroupControl | undefined): boolean {
  return control?.strobeFlashActive === true || control?.strobeLocked === true
}

function blinderActive(control: GroupControl | undefined): boolean {
  return control?.blinderActive === true || control?.blinderLocked === true
}

function exclusiveActive(control: GroupControl | undefined): boolean {
  return control?.exclusiveEnabled === true || control?.exclusiveLocked === true
}

function blackoutActive(control: GroupControl | undefined): boolean {
  return control?.blackoutActive === true || control?.blackoutLocked === true
}

/**
 * Release lights when it has something to release: a lock standing on this group, or a
 * wheel override armed on it.
 *
 * Both outlive the gesture that started them — a lock survives its pad coming up, and
 * the wheel override has no pad at all — so the lamp is the only thing on the surface
 * saying the group is still off the scene.
 *
 * Not lit while Release is merely held down: held, Release is the lock *modifier*, and
 * lighting it then would claim something is standing when the gesture has not put
 * anything there yet. Momentary controls are left out for the same reason — their own
 * pad is lit while a hand is on it.
 */
function hasReleasableOverride(control: GroupControl | undefined): boolean {
  return (
    control?.strobeLocked === true ||
    control?.blinderLocked === true ||
    control?.exclusiveLocked === true ||
    // The one lock a scene change does not drop, so this lamp may be the only thing
    // still saying the group is dead several looks after it was killed.
    control?.blackoutLocked === true ||
    control?.goboEnabled === true
  )
}

function anyGroupHasReleasableOverride(
  groupControl: GroupControlState | undefined
): boolean {
  const byGroup = groupControl?.byGroup ?? {}
  return Object.keys(byGroup).some((group) =>
    hasReleasableOverride(byGroup[group])
  )
}

/**
 * Desired lamp state for every bound input, keyed by input id.
 *
 * Keys are input ids as bound (`"0cc20"`); translating those to the address the lamp
 * answers on is the device profile's job, not this function's.
 */
export function computeMidiFeedbackState(
  state: CleanReduxState,
  /**
   * Wall clock the timed gates are judged against. Defaulted rather than required
   * because every other lamp here reads pure state; only the gate has a deadline.
   */
  nowMs: number = Date.now()
): Map<string, boolean> {
  const lamps = new Map<string, boolean>()
  const groupControl = state.groupControl
  const master = groupControl?.master

  /**
   * Fold one bound control into its pad's lamp.
   *
   * Several actions can share an input, and the pad has one lamp between them, so it
   * answers "is anything on this pad doing something" rather than reporting whichever
   * binding happened to be visited last. Lit if any of them is up, which keeps the dark
   * state meaning what it should: nothing on this pad is standing.
   */
  const lamp = (inputID: string, lit: boolean) => {
    lamps.set(inputID, lamps.get(inputID) === true || lit)
  }

  for (const buttonAction of Object.values(
    state.control.device.buttonActions
  )) {
    const action = buttonAction.action
    const id = buttonAction.inputID

    if (action.type === 'setGroupStrobeFlash') {
      lamp(id, strobeActive(groupOf(groupControl, action.group)))
    } else if (action.type === 'setGroupBlinder') {
      lamp(id, blinderActive(groupOf(groupControl, action.group)))
    } else if (action.type === 'setGroupBlackout') {
      lamp(id, blackoutActive(groupOf(groupControl, action.group)))
    } else if (action.type === 'setGroupTimed') {
      // Solid while the gate is open, blinking while it is overdue, dark otherwise.
      // The blink is a function of the clock rather than a state the engine toggles,
      // so the pad and the on-screen button stay in step without either driving the
      // other — they are both reading the same half-second quantum.
      const control = groupOf(groupControl, action.group)
      lamp(
        id,
        isGroupTimedActive(control, nowMs) ||
          (isGroupTimedOverdue(control, nowMs) && timedFlashPhaseOn(nowMs))
      )
    } else if (action.type === 'setGroupExclusive') {
      lamp(id, exclusiveActive(groupOf(groupControl, action.group)))
    } else if (action.type === 'releaseGroupStrobe') {
      lamp(id, hasReleasableOverride(groupOf(groupControl, action.group)))
    } else if (action.type === 'setGroupMasterStrobe') {
      lamp(id, master?.strobeActive === true)
    } else if (action.type === 'setGroupMasterBlinder') {
      lamp(id, master?.blinderActive === true)
    } else if (action.type === 'releaseAllGroupOverrides') {
      // The rig-wide Release: lit whenever any group is holding something for it to
      // drop — a lock, or a wheel override.
      lamp(id, anyGroupHasReleasableOverride(groupControl))
    }
  }

  return lamps
}

/**
 * The lamp transitions between two states.
 *
 * Only changes are emitted, so a control that is still active is not re-sent on every
 * state update. `force` re-states everything, for a controller that has just appeared and
 * knows nothing about what it should be showing.
 *
 * Returns input ids; the caller resolves each to a device address.
 */
export function midiFeedbackChanges(
  previous: Map<string, boolean>,
  desired: Map<string, boolean>,
  force = false
): Array<{ inputID: string; lit: boolean }> {
  const changes: Array<{ inputID: string; lit: boolean }> = []

  for (const [inputID, lit] of desired) {
    if (!force && previous.get(inputID) === lit) {
      continue
    }
    changes.push({ inputID, lit })
  }

  // A binding that has gone away — rebound elsewhere, or its action deleted — leaves a
  // lamp lit with nothing behind it, so darken it on the way out.
  for (const [inputID, wasLit] of previous) {
    if (wasLit && !desired.has(inputID)) {
      changes.push({ inputID, lit: false })
    }
  }

  return changes
}
