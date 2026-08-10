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
  setGroupExclusive,
  setGroupBlinder,
  setGroupStrobeFlash,
  toggleGroupBlinder,
  toggleGroupExclusive,
  toggleGroupStrobeFlash,
} from './groupControlSlice'
import type { SceneType } from '../../shared/Scenes'
import { msUntilNextBeatBoundary } from '../../shared/sceneBeatQuantize'

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
    dispatch(releaseGroupStrobe(action.group))
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
  } else if (action.type === 'setGroupExclusive') {
    dispatch(
      pressed === undefined
        ? toggleGroupExclusive(action.group)
        : setGroupExclusive({ group: action.group, enabled: pressed })
    )
  }
}
