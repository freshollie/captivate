import { createSlice, PayloadAction } from '@reduxjs/toolkit'
import {
  clampBlinderFadeBeats,
  clampGroupStrobeValue,
  initGroupControl,
  initGroupControlState,
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
  return locked
}

/**
 * What Release does when it is not being used as a lock modifier.
 *
 * The strobe goes back to the scene, and any *locked* solo or blinder comes down with
 * it — a lock has no other way down from this card. Ones merely held or latched are
 * left alone, as they always have been; that is what Release all is for.
 */
function releaseGroup(control: GroupControl): void {
  clearStrobe(control)
  if (control.exclusiveLocked === true) clearExclusive(control)
  if (control.blinderLocked === true) clearBlinder(control)
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
     * this group's strobe back to the scene, or, if a pad is held, locks that pad's
     * control on instead so it survives the pad coming up.
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
        clearExclusive(control)
        clearBlinder(control)
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
    setBlinderFadeBeats: (state, { payload }: PayloadAction<number>) => {
      state.blinderFadeBeats = clampBlinderFadeBeats(payload)
    },
    setGroupFollowMasterHotkeys: (
      state,
      { payload }: PayloadAction<{ group: string; follow: boolean }>
    ) => {
      controlFor(state, payload.group).followMasterHotkeys = payload.follow === true
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
     * every one of them — strobe, solo and blinder alike.
     *
     * This replaces an older rule that released the *strobe* on every scene change.
     * That existed because the fader used to arm the strobe, so one could be left up
     * with nothing on screen to explain it; now the only ways up are a pad, which
     * releases itself, and a lock, which this clears. A pad still down keeps its
     * control — letting go is what ends that — it just no longer has a lock to stand
     * on afterwards. Brightness is a rig trim rather than a look, so it survives.
     */
    const releaseLocksOnLightSceneChange = (
      state: GroupControlState,
      sceneType: SceneType | undefined
    ) => {
      if (sceneType !== 'light') return
      for (const control of Object.values(state.byGroup)) {
        if (control === undefined) continue
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
  setGroupStrobe,
  setGroupStrobeFlash,
  toggleGroupStrobeFlash,
  releaseGroupStrobe,
  setGroupRelease,
  releaseAllGroupStrobes,
  releaseAllLiveOverrides,
  setGroupFollowMasterHotkeys,
  setMasterBrightness,
  setMasterStrobe,
  toggleMasterStrobe,
  setMasterBlinder,
  toggleMasterBlinder,
  setGroupExclusive,
  toggleGroupExclusive,
  setGroupBlinder,
  toggleGroupBlinder,
  setBlinderFadeBeats,
} = groupControlSlice.actions

export default groupControlSlice.reducer
