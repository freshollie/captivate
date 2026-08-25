import type { PayloadAction } from '@reduxjs/toolkit'
import type { CleanReduxState } from './store'
import type { RealtimeState } from './realtimeStore'
import type { MidiAction } from './deviceState'
import {
  setActiveSceneIndex,
  setAutoSceneEnabled,
} from './controlSlice'
import {
  setBlackout,
  fireAtmosManualTrigger,
  toggleMoverFollowOverrideEnabled,
  setActivePage,
  setLaserToolFromMidiMapping,
} from './guiSlice'
import {
  releaseGroupStrobe,
  setGroupRelease,
  setGroupExclusive,
  setGroupBlinder,
  setGroupStrobeFlash,
  releaseAllLiveOverrides,
  setMasterBlinder,
  setMasterStrobe,
  toggleGroupBlinder,
  toggleGroupExclusive,
  toggleGroupStrobeFlash,
  toggleMasterBlinder,
  toggleMasterStrobe,
} from './groupControlSlice'
import type { SceneType } from '../../shared/Scenes'
import { msUntilNextBeatBoundary } from '../../shared/sceneBeatQuantize'
import { pickSceneForEpicnessLevel } from '../../shared/autoScene'
import { setActiveScene } from './controlSlice'

const pendingMidiSceneTimeouts: Partial<
  Record<SceneType, ReturnType<typeof setTimeout>>
> = {}

/**
 * Runs the same “MIDI button” side-effects as {@link ../../main/engine/handleMidi}
 * for one-shot triggers (notes, keyboard shortcuts, etc.).
 */
export function fireMidiButtonAction(
  dispatch: (action: PayloadAction<unknown>) => void,
  state: CleanReduxState,
  rt_state: RealtimeState,
  action: MidiAction,
  tapTempo: () => void,
  /**
   * Press state for momentary actions. Leave undefined for inputs that have no
   * release to report (keyboard, on-screen click) — those toggle instead, so the
   * action cannot latch on with no way to clear it.
   */
  pressed?: boolean
): void {
  if (action.type === 'setActiveSceneIndex') {
    const sceneType = action.sceneType
    const val = action.index
    const prev = pendingMidiSceneTimeouts[sceneType]
    if (prev !== undefined) {
      clearTimeout(prev)
    }
    const delayMs = msUntilNextBeatBoundary(rt_state.time)
    pendingMidiSceneTimeouts[sceneType] = setTimeout(() => {
      delete pendingMidiSceneTimeouts[sceneType]
      dispatch(setActiveSceneIndex({ sceneType, val }))
    }, delayMs)
  } else if (action.type === 'tapTempo') {
    tapTempo()
  } else if (action.type === 'toggleAutoScene') {
    const sceneType = action.sceneType
    dispatch(
      setAutoSceneEnabled({
        sceneType,
        val: !state.control[sceneType].auto.enabled,
      })
    )
  } else if (action.type === 'toggleBlackout') {
    dispatch(setBlackout(!state.gui.blackout))
  } else if (action.type === 'toggleMoverFollowOverride') {
    dispatch(toggleMoverFollowOverrideEnabled())
  } else if (action.type === 'triggerAtmosFixture') {
    dispatch(fireAtmosManualTrigger(action.fixtureId))
  } else if (action.type === 'setActivePage') {
    dispatch(setActivePage(action.page))
  } else if (action.type === 'laserTool') {
    dispatch(setLaserToolFromMidiMapping({ tool: action.tool }))
  } else if (action.type === 'releaseGroupStrobe') {
    // Momentary, so it can be *held* as the lock modifier; a click or keyboard chord
    // has no release to report and falls back to a plain tap.
    dispatch(
      pressed === undefined
        ? releaseGroupStrobe(action.group)
        : setGroupRelease({ group: action.group, pressed })
    )
  } else if (action.type === 'setGroupStrobeFlash') {
    dispatch(
      pressed === undefined
        ? toggleGroupStrobeFlash(action.group)
        : setGroupStrobeFlash({ group: action.group, pressed })
    )
  } else if (action.type === 'setGroupBlinder') {
    dispatch(
      pressed === undefined
        ? toggleGroupBlinder(action.group)
        : setGroupBlinder({ group: action.group, pressed })
    )
  } else if (action.type === 'setEpicnessLevel') {
    // Resolved now, from the state the operator could see when they pressed —
    // not after the quantize delay, when auto-scene may have moved on.
    const nextScene = pickSceneForEpicnessLevel(
      state.control.light,
      action.level
    )
    if (nextScene !== null) {
      const prev = pendingMidiSceneTimeouts.light
      if (prev !== undefined) {
        clearTimeout(prev)
      }
      // Quantized to the beat, the same as MIDI scene buttons.
      const delayMs = msUntilNextBeatBoundary(rt_state.time)
      pendingMidiSceneTimeouts.light = setTimeout(() => {
        delete pendingMidiSceneTimeouts.light
        dispatch(setActiveScene({ sceneType: 'light', val: nextScene }))
      }, delayMs)
    }
  } else if (action.type === 'releaseAllGroupOverrides') {
    dispatch(releaseAllLiveOverrides())
  } else if (action.type === 'setGroupMasterStrobe') {
    dispatch(
      pressed === undefined ? toggleMasterStrobe() : setMasterStrobe(pressed)
    )
  } else if (action.type === 'setGroupMasterBlinder') {
    dispatch(
      pressed === undefined ? toggleMasterBlinder() : setMasterBlinder(pressed)
    )
  } else if (action.type === 'setGroupExclusive') {
    dispatch(
      pressed === undefined
        ? toggleGroupExclusive(action.group)
        : setGroupExclusive({ group: action.group, enabled: pressed })
    )
  }
}
