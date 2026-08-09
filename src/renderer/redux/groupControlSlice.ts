import { createSlice, PayloadAction } from '@reduxjs/toolkit'
import {
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
    setGroupBrightness: (
      state,
      { payload }: PayloadAction<{ group: string; value: number }>
    ) => {
      // Always live — full is the released position, so there is nothing to arm.
      controlFor(state, payload.group).brightness = clamp01(payload.value)
    },
    setGroupStrobe: (
      state,
      { payload }: PayloadAction<{ group: string; value: number }>
    ) => {
      const control = controlFor(state, payload.group)
      control.strobe = clampGroupStrobeValue(payload.value)
      // Touching the fader arms it: 0 is a real strobe value, not "off", so the
      // armed flag is the only thing separating "override" from "leave the scene".
      control.strobeEnabled = true
      // Remember anything above zero as the level Flash will fire at, so the button
      // still has something to do once the live value has been released.
      if (control.strobe > 0) {
        control.strobeFlashLevel = control.strobe
      }
    },
    /** Momentary: hold to strobe at the remembered level, let go to drop it. */
    setGroupStrobeFlash: (
      state,
      { payload }: PayloadAction<{ group: string; pressed: boolean }>
    ) => {
      const control = controlFor(state, payload.group)
      if (payload.pressed) {
        control.strobe = clampGroupStrobeValue(control.strobeFlashLevel)
        control.strobeEnabled = true
      } else {
        control.strobeEnabled = false
        control.strobe = 0
      }
    },
    /** For inputs with no release to report — an on-screen click, a keyboard chord. */
    toggleGroupStrobeFlash: (state, { payload }: PayloadAction<string>) => {
      const control = controlFor(state, payload)
      if (control.strobeEnabled) {
        control.strobeEnabled = false
        control.strobe = 0
      } else {
        control.strobe = clampGroupStrobeValue(control.strobeFlashLevel)
        control.strobeEnabled = true
      }
    },
    /** Hand this group's strobe back to the scene. */
    releaseGroupStrobe: (state, { payload }: PayloadAction<string>) => {
      const control = controlFor(state, payload)
      control.strobeEnabled = false
      control.strobe = 0
    },
    releaseAllGroupStrobes: (state) => {
      for (const control of Object.values(state.byGroup)) {
        if (control === undefined) continue
        control.strobeEnabled = false
        control.strobe = 0
      }
    },
    setGroupExclusive: (
      state,
      { payload }: PayloadAction<{ group: string; enabled: boolean }>
    ) => {
      controlFor(state, payload.group).exclusiveEnabled = payload.enabled === true
    },
    toggleGroupExclusive: (state, { payload }: PayloadAction<string>) => {
      const control = controlFor(state, payload)
      control.exclusiveEnabled = !control.exclusiveEnabled
    },
  },
  extraReducers: (builder) => {
    // A new look should start from the scene's own strobe. Brightness is a rig
    // trim rather than a look, so it deliberately survives the change.
    const releaseStrobeOnLightSceneChange = (
      state: GroupControlState,
      sceneType: SceneType | undefined
    ) => {
      if (sceneType !== 'light') return
      for (const control of Object.values(state.byGroup)) {
        if (control === undefined) continue
        control.strobeEnabled = false
        control.strobe = 0
      }
    }

    builder.addMatcher(
      (action): action is PayloadAction<{ sceneType: SceneType }> =>
        action.type === SET_ACTIVE_SCENE || action.type === SET_ACTIVE_SCENE_INDEX,
      (state, { payload }) => {
        releaseStrobeOnLightSceneChange(state, payload?.sceneType)
      }
    )
  },
})

export const {
  setGroupBrightness,
  setGroupStrobe,
  setGroupStrobeFlash,
  toggleGroupStrobeFlash,
  releaseGroupStrobe,
  releaseAllGroupStrobes,
  setGroupExclusive,
  toggleGroupExclusive,
} = groupControlSlice.actions

export default groupControlSlice.reducer
