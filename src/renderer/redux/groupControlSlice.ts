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
      const control = controlFor(state, payload.group)
      control.brightness = clamp01(payload.value)
      // Moving a fader is an instruction to use it — arming separately every time
      // would make MIDI and touch control useless.
      control.brightnessEnabled = true
    },
    setGroupBrightnessEnabled: (
      state,
      { payload }: PayloadAction<{ group: string; enabled: boolean }>
    ) => {
      controlFor(state, payload.group).brightnessEnabled = payload.enabled === true
    },
    setGroupStrobe: (
      state,
      { payload }: PayloadAction<{ group: string; value: number }>
    ) => {
      const control = controlFor(state, payload.group)
      control.strobe = clampGroupStrobeValue(payload.value)
      control.strobeEnabled = true
    },
    setGroupStrobeEnabled: (
      state,
      { payload }: PayloadAction<{ group: string; enabled: boolean }>
    ) => {
      controlFor(state, payload.group).strobeEnabled = payload.enabled === true
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
    clearGroupControl: (state, { payload }: PayloadAction<string>) => {
      delete state.byGroup[payload]
    },
    clearAllGroupControls: (state) => {
      state.byGroup = {}
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
  setGroupBrightnessEnabled,
  setGroupStrobe,
  setGroupStrobeEnabled,
  setGroupExclusive,
  toggleGroupExclusive,
  clearGroupControl,
  clearAllGroupControls,
} = groupControlSlice.actions

export default groupControlSlice.reducer
