import { createSlice, PayloadAction } from '@reduxjs/toolkit'
import {
  clampBlinderFadeBeats,
  clampGroupStrobeValue,
  clampGroupTimedReminderSeconds,
  clampGroupTimedSeconds,
  initGroupControl,
  initGroupControlState,
  isGroupTimedActive,
  type GroupControl,
  type GroupControlState,
} from '../../shared/groupControl'
import type { SceneType } from '../../shared/Scenes'

/**
 * Scene-change actions from the `scenes` slice (`controlSlice`).
 *
 * Matched by type string rather than by importing the creators: that slice pulls in
 * the whole scene/visualizer graph, and this one has no other reason to depend on
 * it. Same approach the remote-control allowlist uses.
 */
const SET_ACTIVE_SCENE = 'scenes/setActiveScene'
const SET_ACTIVE_SCENE_INDEX = 'scenes/setActiveSceneIndex'

export type { GroupControl, GroupControlState }
export { initGroupControlState }

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(1, Math.max(0, value))
}

/** Everything that has to come down when a strobe is handed back to the scene. */
function clearStrobe(control: GroupControl): void {
  control.strobeEnabled = false
  control.strobe = 0
  control.strobeFlashActive = false
  control.strobeFlashHeld = false
  control.strobeLocked = false
}

/**
 * Everything that has to come down when the wheels go back to the scene.
 *
 * The gobo fader drops to open with the override, so the card and the rig agree: a
 * released group is showing the scene's gobo, and a fader left parked on Breakup would
 * claim otherwise — and would put Breakup back on the rig the instant it was nudged.
 * Open is also the only value that is never a surprise to re-arm into.
 *
 * The prism and rotation faders keep their positions. They arm nothing on their own,
 * so a parked one cannot do anything on its own either, and they are the slower
 * settings of the three — worth keeping dialled between looks.
 */
function clearWheelOverride(control: GroupControl): void {
  control.goboEnabled = false
  control.gobo = 0
}

/** Everything that has to come down when a solo is handed back. */
function clearExclusive(control: GroupControl): void {
  control.exclusiveEnabled = false
  control.exclusiveHeld = false
  control.exclusiveLocked = false
}

/** Everything that has to come down when a blinder is let go for good. */
function clearBlinder(control: GroupControl): void {
  control.blinderActive = false
  control.blinderHeld = false
  control.blinderLocked = false
}

/** Everything that has to come down when a blackout is let go for good. */
function clearBlackout(control: GroupControl): void {
  control.blackoutActive = false
  control.blackoutHeld = false
  control.blackoutLocked = false
}

/** Shut a timed gate, whether it was running or already down. */
function clearTimed(control: GroupControl): void {
  control.timedUntilMs = 0
}

/**
 * Lock whatever pads are down, and report whether any were.
 *
 * The gesture works from either end — Release tapped with a pad already held, or a pad
 * pressed while Release is held — so both entry points come through here. Locking is
 * additive: a pad that is not down keeps whatever lock it already had.
 */
function lockHeldControls(control: GroupControl): boolean {
  let locked = false
  if (control.strobeFlashHeld === true) {
    control.strobeLocked = control.strobeLocked !== true
    locked = true
  }
  if (control.exclusiveHeld === true) {
    control.exclusiveLocked = control.exclusiveLocked !== true
    locked = true
  }
  if (control.blinderHeld === true) {
    control.blinderLocked = control.blinderLocked !== true
    locked = true
  }
  if (control.blackoutHeld === true) {
    control.blackoutLocked = control.blackoutLocked !== true
    locked = true
  }
  return locked
}

/**
 * What Release does when it is not being used as a lock modifier.
 *
 * The strobe and the wheel override go back to the scene, and any *locked* solo,
 * blinder or blackout comes down with them — a lock has no other way down from this
 * card. Ones merely held or latched are left alone, as they always have been; that is
 * what Release all is for.
 *
 * A locked blackout is the only one of the three that could still be standing from
 * several scenes ago, since nothing but this and Release all takes it down, so this is
 * usually the button that ends it.
 */
function releaseGroup(control: GroupControl): void {
  clearStrobe(control)
  clearWheelOverride(control)
  if (control.exclusiveLocked === true) clearExclusive(control)
  if (control.blinderLocked === true) clearBlinder(control)
  if (control.blackoutLocked === true) clearBlackout(control)
  // A gate standing open is the loudest thing on the card — a fogger mid-run — and
  // Release is the button an operator reaches for to stop a group doing something.
  clearTimed(control)
}

function controlFor(state: GroupControlState, group: string): GroupControl {
  const existing = state.byGroup[group]
  if (existing !== undefined) {
    return existing
  }
  const created = initGroupControl()
  state.byGroup[group] = created
  return created
}

export const groupControlSlice = createSlice({
  name: 'groupControl',
  initialState: initGroupControlState(),
  reducers: {
    /**
     * Replace the whole slice with the host's copy.
     *
     * Mirror windows are sent group-control changes on their own rather than inside a
     * full state, so they need somewhere to put one that is not `resetRemoteState` —
     * that rebuilds and revalidates the entire project to land a fader move.
     */
    replaceGroupControlState: (
      _state,
      { payload }: PayloadAction<GroupControlState>
    ) => payload,
    setGroupBrightness: (
      state,
      { payload }: PayloadAction<{ group: string; value: number }>
    ) => {
      // Always live — full is the released position, so there is nothing to arm.
      controlFor(state, payload.group).brightness = clamp01(payload.value)
    },
    /**
     * Pull this group's movers onto their mirror-ball aims, 0 = scene, 1 = locked on.
     *
     * Always live, like brightness: there is no arming to do because the bottom of
     * the fader hands every head straight back to the scene. Heads with no aim
     * captured for them are unaffected at any position.
     */
    setGroupDiscoBall: (
      state,
      { payload }: PayloadAction<{ group: string; value: number }>
    ) => {
      controlFor(state, payload.group).discoBall = clamp01(payload.value)
    },
    /**
     * Pick the group's gobo — and arm the wheel override by doing so.
     *
     * Moving the fader *is* the arming gesture, because there is no released position
     * to rest at: gobo 0 is a real slot, so a fader sitting at the bottom cannot mean
     * "leave the scene alone". Release, Release all and the next light scene hand the
     * wheels back and drop this fader to open with them.
     */
    setGroupGobo: (
      state,
      { payload }: PayloadAction<{ group: string; value: number }>
    ) => {
      const control = controlFor(state, payload.group)
      control.gobo = clamp01(payload.value)
      control.goboEnabled = true
    },
    /**
     * Prism slot fired by the wheel override.
     *
     * Deliberately does not arm: it is one third of a beam look, and a look picked
     * from the prism alone with the gobo left wherever it was parked is not one anyone
     * asked for. Dialling it with the override down is fine and changes nothing on the
     * wire until the Gobo fader arms it.
     */
    setGroupPrism: (
      state,
      { payload }: PayloadAction<{ group: string; value: number }>
    ) => {
      controlFor(state, payload.group).prism = clamp01(payload.value)
    },
    /** Prism rotation fired by the wheel override. Does not arm; see `setGroupPrism`. */
    setGroupPrismSpeed: (
      state,
      { payload }: PayloadAction<{ group: string; value: number }>
    ) => {
      controlFor(state, payload.group).prismSpeed = clamp01(payload.value)
    },
    /**
     * Trims a strobe that is already live, and does nothing otherwise.
     *
     * The fader deliberately cannot arm: 0 is a real strobe value rather than "off",
     * so arming on touch meant a knocked fader — or a controller sending its
     * positions on connect — started the rig strobing. Flash arms it; Flash plus
     * Release locks it on so the fader can be dialled with the pad let go.
     */
    setGroupStrobe: (
      state,
      { payload }: PayloadAction<{ group: string; value: number }>
    ) => {
      const control = controlFor(state, payload.group)
      if (control.strobeEnabled !== true) return
      control.strobe = clampGroupStrobeValue(payload.value)
      // Remember anything above zero as the level Flash will fire at, so the button
      // still has something to do once the live value has been released.
      if (control.strobe > 0) {
        control.strobeFlashLevel = control.strobe
      }
    },
    /**
     * Momentary: hold to strobe at the remembered level, let go to drop it — unless
     * the strobe was locked while the pad was down, which is the one thing that
     * survives the release.
     */
    setGroupStrobeFlash: (
      state,
      { payload }: PayloadAction<{ group: string; pressed: boolean }>
    ) => {
      const control = controlFor(state, payload.group)
      if (payload.pressed) {
        control.strobe = clampGroupStrobeValue(control.strobeFlashLevel)
        control.strobeEnabled = true
        control.strobeFlashActive = true
        control.strobeFlashHeld = true
        if (control.releaseHeld === true) {
          control.strobeLocked = true
          control.releaseUsedForLock = true
        }
      } else if (control.strobeLocked === true) {
        // The strobe stays up at whatever it is on, but the flash is no longer
        // holding it — so it stops forcing brightness to full.
        control.strobeFlashActive = false
        control.strobeFlashHeld = false
      } else {
        clearStrobe(control)
      }
    },
    /** For inputs with no release to report — an on-screen click, a keyboard chord. */
    toggleGroupStrobeFlash: (state, { payload }: PayloadAction<string>) => {
      const control = controlFor(state, payload)
      if (control.strobeEnabled) {
        clearStrobe(control)
      } else {
        control.strobe = clampGroupStrobeValue(control.strobeFlashLevel)
        control.strobeEnabled = true
        control.strobeFlashActive = true
        // Latched, not held: nothing will report a release for a click, so this must
        // not read as a pad being down.
        control.strobeFlashHeld = false
        if (control.releaseHeld === true) {
          control.strobeLocked = true
          control.releaseUsedForLock = true
        }
      }
    },
    /**
     * A Release with no hold to report — an on-screen click, a keyboard chord. Hands
     * this group's strobe and wheels back to the scene, or, if a pad is held, locks
     * that pad's control on instead so it survives the pad coming up.
     *
     * Doubling up on Release keeps the gesture to two pads and reads the right way
     * round: the button that ends an override is the one that decides it should stay.
     * The same gesture unlocks, and with nothing held Release means release again.
     * `setGroupRelease` is the same button from a pad, where it can also be held.
     *
     * Kept named `releaseGroupStrobe` because MIDI and keyboard mappings are stored by
     * action type — renaming it would silently unbind every operator's Release pad.
     */
    releaseGroupStrobe: (state, { payload }: PayloadAction<string>) => {
      const control = controlFor(state, payload)
      if (lockHeldControls(control)) return
      releaseGroup(control)
    },
    /**
     * Release from a pad, which can report its own release — so it can be held as a
     * modifier rather than only tapped.
     *
     * Held, it locks: any pad pressed while it is down locks on, and a pad already
     * down when it goes there locks immediately. The release itself waits for the pad
     * to come up, and only happens if the hold locked nothing — otherwise reaching for
     * Release first and a second pad after would drop the very locks being added to.
     */
    setGroupRelease: (
      state,
      { payload }: PayloadAction<{ group: string; pressed: boolean }>
    ) => {
      const control = controlFor(state, payload.group)
      if (payload.pressed === true) {
        control.releaseHeld = true
        control.releaseUsedForLock = lockHeldControls(control)
        return
      }
      if (control.releaseUsedForLock !== true) {
        releaseGroup(control)
      }
      control.releaseHeld = false
      control.releaseUsedForLock = false
    },
    /**
     * Panic release: drop every live override on every group.
     *
     * Momentary controls can latch if a MIDI note-off is missed, and a latched solo
     * blacks out the rig from a card the operator may not think to look at. This is
     * the one control guaranteed to clear it. Brightness is a trim, not an override,
     * so it is left alone.
     */
    releaseAllLiveOverrides: (state) => {
      // Master strobe and blinder are overrides and go; the master dimmer is a
      // trim, like each group's own, and is left where the operator set it.
      state.master.strobeActive = false
      state.master.blinderActive = false
      for (const control of Object.values(state.byGroup)) {
        if (control === undefined) continue
        clearStrobe(control)
        clearWheelOverride(control)
        clearExclusive(control)
        clearBlinder(control)
        clearBlackout(control)
        clearTimed(control)
        // A Release pad whose note-off never arrived would silently turn every later
        // press into a lock, so the panic button clears the modifier too.
        control.releaseHeld = false
        control.releaseUsedForLock = false
      }
    },
    releaseAllGroupStrobes: (state) => {
      for (const control of Object.values(state.byGroup)) {
        if (control === undefined) continue
        clearStrobe(control)
      }
    },
    /**
     * Momentary: hold to blind, let go to hand the group straight back — unless the
     * blinder was locked while the pad was down, which is the one thing that
     * survives it.
     */
    setGroupBlinder: (
      state,
      { payload }: PayloadAction<{ group: string; pressed: boolean }>
    ) => {
      const control = controlFor(state, payload.group)
      if (payload.pressed === true) {
        control.blinderActive = true
        control.blinderHeld = true
        if (control.releaseHeld === true) {
          control.blinderLocked = true
          control.releaseUsedForLock = true
        }
      } else if (control.blinderLocked === true) {
        // Still blinding; just no longer held.
        control.blinderHeld = false
      } else {
        clearBlinder(control)
      }
    },
    /** For inputs with no release to report — an on-screen click, a keyboard chord. */
    toggleGroupBlinder: (state, { payload }: PayloadAction<string>) => {
      const control = controlFor(state, payload)
      if (control.blinderActive) {
        clearBlinder(control)
      } else {
        control.blinderActive = true
        // Latched, not held: nothing will report a release for a click, so this must
        // not read as a pad being down.
        control.blinderHeld = false
        if (control.releaseHeld === true) {
          control.blinderLocked = true
          control.releaseUsedForLock = true
        }
      }
    },
    /**
     * Momentary: hold to kill the group, let go to hand it straight back — unless the
     * blackout was locked while the pad was down, which is the one thing that
     * survives it.
     */
    setGroupBlackout: (
      state,
      { payload }: PayloadAction<{ group: string; pressed: boolean }>
    ) => {
      const control = controlFor(state, payload.group)
      if (payload.pressed === true) {
        control.blackoutActive = true
        control.blackoutHeld = true
        if (control.releaseHeld === true) {
          control.blackoutLocked = true
          control.releaseUsedForLock = true
        }
      } else if (control.blackoutLocked === true) {
        // Still dark; just no longer held.
        control.blackoutHeld = false
      } else {
        clearBlackout(control)
      }
    },
    /** For inputs with no release to report — an on-screen click, a keyboard chord. */
    toggleGroupBlackout: (state, { payload }: PayloadAction<string>) => {
      const control = controlFor(state, payload)
      if (control.blackoutActive) {
        clearBlackout(control)
      } else {
        control.blackoutActive = true
        // Latched, not held: nothing will report a release for a click, so this must
        // not read as a pad being down.
        control.blackoutHeld = false
        if (control.releaseHeld === true) {
          control.blackoutLocked = true
          control.releaseUsedForLock = true
        }
      }
    },
    /**
     * Whether this group is gated by a timed Go button.
     *
     * A setting, not a gesture: it survives Release, Release all and scene changes, the
     * same way `overrideScene` does. Turning it on shuts the group immediately — the
     * gate starts closed, which is the only safe way round for the things this is for.
     */
    setGroupTimedEnabled: (
      state,
      { payload }: PayloadAction<{
        group: string
        enabled: boolean
        /** Stamped as the reminder's starting point; see `fireGroupTimed`. */
        nowMs: number
      }>
    ) => {
      const control = controlFor(state, payload.group)
      control.timedEnabled = payload.enabled === true
      clearTimed(control)
      // Turning the gate on starts the reminder's clock, so a group configured and
      // then left alone nags on schedule rather than waiting for a first press that
      // may never come. Turning it off stops the clock entirely.
      control.timedLastFiredAtMs = control.timedEnabled ? payload.nowMs : 0
    },
    /**
     * How long Go may go unpressed before it starts flashing. 0 is off.
     *
     * Setting it on a gate that has never been fired starts the clock from now, so the
     * reminder begins counting from the moment it is asked for rather than sitting
     * dormant until the first press.
     */
    setGroupTimedReminderSeconds: (
      state,
      { payload }: PayloadAction<{
        group: string
        seconds: number
        nowMs: number
      }>
    ) => {
      const control = controlFor(state, payload.group)
      control.timedReminderSeconds = clampGroupTimedReminderSeconds(payload.seconds)
      if (
        control.timedReminderSeconds > 0 &&
        !(Number.isFinite(control.timedLastFiredAtMs) && control.timedLastFiredAtMs > 0)
      ) {
        control.timedLastFiredAtMs = payload.nowMs
      }
    },
    /** How long one press of Go runs for. Changing it never affects a run in progress. */
    setGroupTimedSeconds: (
      state,
      { payload }: PayloadAction<{ group: string; seconds: number }>
    ) => {
      controlFor(state, payload.group).timedSeconds = clampGroupTimedSeconds(
        payload.seconds
      )
    },
    /**
     * Go: open the gate for its configured run, or shut it if it is already open.
     *
     * A press while it is running stops it rather than extending it. The point of the
     * control is that the group cannot be left running, so the button an operator hits
     * when they want it to stop has to be the one already under their finger — and
     * re-arming from shut is one more press, where recovering from "I could not turn it
     * off" is a walk to the fogger.
     *
     * `nowMs` comes from the caller rather than the reducer so this stays pure and so
     * both sides — a click here, a pad in the engine process — stamp the same clock.
     */
    fireGroupTimed: (
      state,
      { payload }: PayloadAction<{ group: string; nowMs: number }>
    ) => {
      const control = controlFor(state, payload.group)
      if (control.timedEnabled !== true) return
      // Any press restarts the reminder, the stopping one included: what it measures is
      // time since a hand was last on the control, not time since fog was last made.
      control.timedLastFiredAtMs = payload.nowMs
      if (isGroupTimedActive(control, payload.nowMs)) {
        clearTimed(control)
        return
      }
      control.timedUntilMs =
        payload.nowMs + clampGroupTimedSeconds(control.timedSeconds) * 1000
    },
    setBlinderFadeBeats: (state, { payload }: PayloadAction<number>) => {
      state.blinderFadeBeats = clampBlinderFadeBeats(payload)
    },
    setGroupFollowMasterHotkeys: (
      state,
      { payload }: PayloadAction<{ group: string; follow: boolean }>
    ) => {
      controlFor(state, payload.group).followMasterHotkeys = payload.follow === true
    },
    /**
     * Hand the group's fixtures to its own fader, off the scene entirely.
     *
     * A setting, not a gesture: it survives Release, Release all and scene changes,
     * the same way `followMasterHotkeys` does. The fader keeps whatever position it
     * was on, which means ticking this on a group left at full lights it to full
     * white immediately — the honest reading of a fader that now means what it says.
     */
    setGroupOverrideScene: (
      state,
      { payload }: PayloadAction<{ group: string; override: boolean }>
    ) => {
      controlFor(state, payload.group).overrideScene = payload.override === true
    },
    setMasterBrightness: (state, { payload }: PayloadAction<number>) => {
      state.master.brightness = clamp01(payload)
    },
    /** Momentary: hold to strobe every group that follows the master hotkeys. */
    setMasterStrobe: (state, { payload }: PayloadAction<boolean>) => {
      state.master.strobeActive = payload === true
    },
    toggleMasterStrobe: (state) => {
      state.master.strobeActive = !state.master.strobeActive
    },
    /** Momentary: hold to blind every group that follows the master hotkeys. */
    setMasterBlinder: (state, { payload }: PayloadAction<boolean>) => {
      state.master.blinderActive = payload === true
    },
    toggleMasterBlinder: (state) => {
      state.master.blinderActive = !state.master.blinderActive
    },
    /**
     * Momentary: hold to solo, let go to hand the rig back — unless the solo was
     * locked while the pad was down, which is the one thing that survives it.
     */
    setGroupExclusive: (
      state,
      { payload }: PayloadAction<{ group: string; enabled: boolean }>
    ) => {
      const control = controlFor(state, payload.group)
      if (payload.enabled === true) {
        control.exclusiveEnabled = true
        control.exclusiveHeld = true
        if (control.releaseHeld === true) {
          control.exclusiveLocked = true
          control.releaseUsedForLock = true
        }
      } else if (control.exclusiveLocked === true) {
        // Still soloing; just no longer held.
        control.exclusiveHeld = false
      } else {
        clearExclusive(control)
      }
    },
    /** For inputs with no release to report — an on-screen click, a keyboard chord. */
    toggleGroupExclusive: (state, { payload }: PayloadAction<string>) => {
      const control = controlFor(state, payload)
      if (control.exclusiveEnabled) {
        clearExclusive(control)
      } else {
        control.exclusiveEnabled = true
        // Latched, not held: nothing will report a release for a click, so this must
        // not read as a pad being down.
        control.exclusiveHeld = false
        if (control.releaseHeld === true) {
          control.exclusiveLocked = true
          control.releaseUsedForLock = true
        }
      }
    },
  },
  extraReducers: (builder) => {
    /**
     * A lock is a decision about the look being played, so a new light scene drops
     * every one of them — strobe, solo and blinder alike — and the wheel override
     * goes with them, being a decision about the look in exactly the same way.
     *
     * This replaces an older rule that released the *strobe* on every scene change.
     * That existed because the fader used to arm the strobe, so one could be left up
     * with nothing on screen to explain it; now the only ways up are a pad, which
     * releases itself, and a lock, which this clears. A pad still down keeps its
     * control — letting go is what ends that — it just no longer has a lock to stand
     * on afterwards. Brightness is a rig trim rather than a look, so it survives.
     *
     * The blackout is the deliberate exception and is not touched here at all, locked
     * or held. The others say something about the look being played, so the look
     * changing ends them; a blackout says a group must not be lit — a dead fixture, a
     * bar to keep dark through the speeches — and a scene change is no reason to
     * believe that has stopped being true. Handing it back would light precisely the
     * lights that were deliberately killed, at the moment nobody is watching the card.
     * Release and Release all remain the ways down.
     *
     * A timed gate is left alone for the same reason and a stronger one: it is a
     * physical process on a clock — fog in the air, a blast that has been fired — and
     * the scene changing neither starts nor stops it. Its own timer is what ends it.
     */
    const releaseLocksOnLightSceneChange = (
      state: GroupControlState,
      sceneType: SceneType | undefined
    ) => {
      if (sceneType !== 'light') return
      for (const control of Object.values(state.byGroup)) {
        if (control === undefined) continue
        // No pad holds the wheels, so there is no held-versus-locked case to weigh:
        // the new scene's gobos are what the operator asked for by changing scene.
        clearWheelOverride(control)
        if (control.strobeFlashHeld === true) {
          control.strobeLocked = false
        } else if (control.strobeLocked === true) {
          clearStrobe(control)
        }
        if (control.exclusiveHeld === true) {
          control.exclusiveLocked = false
        } else if (control.exclusiveLocked === true) {
          clearExclusive(control)
        }
        if (control.blinderHeld === true) {
          control.blinderLocked = false
        } else if (control.blinderLocked === true) {
          clearBlinder(control)
        }
      }
    }

    builder.addMatcher(
      (action): action is PayloadAction<{ sceneType: SceneType }> =>
        action.type === SET_ACTIVE_SCENE || action.type === SET_ACTIVE_SCENE_INDEX,
      (state, { payload }) => {
        releaseLocksOnLightSceneChange(state, payload?.sceneType)
      }
    )
  },
})

export const {
  replaceGroupControlState,
  setGroupBrightness,
  setGroupDiscoBall,
  setGroupGobo,
  setGroupPrism,
  setGroupPrismSpeed,
  setGroupStrobe,
  setGroupStrobeFlash,
  toggleGroupStrobeFlash,
  releaseGroupStrobe,
  setGroupRelease,
  releaseAllGroupStrobes,
  releaseAllLiveOverrides,
  setGroupFollowMasterHotkeys,
  setGroupOverrideScene,
  setMasterBrightness,
  setMasterStrobe,
  toggleMasterStrobe,
  setMasterBlinder,
  toggleMasterBlinder,
  setGroupExclusive,
  toggleGroupExclusive,
  setGroupBlinder,
  toggleGroupBlinder,
  setGroupBlackout,
  toggleGroupBlackout,
  setGroupTimedEnabled,
  setGroupTimedSeconds,
  setGroupTimedReminderSeconds,
  fireGroupTimed,
  setBlinderFadeBeats,
} = groupControlSlice.actions

export default groupControlSlice.reducer
