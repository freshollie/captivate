import { MidiMessage, midiInputID } from '../../shared/midi'
import { CleanReduxState } from '../../renderer/redux/store'
import { RealtimeState } from '../../renderer/redux/realtimeStore'
import {
  buttonMidiActionTypes,
  momentaryMidiActionTypes,
  getActionID,
  getSetBaseParamSplitIndex,
  SliderAction,
  SliderControlOptions,
  MidiAction,
  type SetGroupControlKind,
  initSliderOptions,
  normalizeSliderOptionsForAction,
} from '../../renderer/redux/deviceState'
import { fireMidiButtonAction } from '../../renderer/redux/fireMidiButtonAction'
import {
  midiSetButtonAction,
  midiSetSliderAction,
  setAutoSceneBombacity,
  setMaster,
  setBaseParams,
} from '../../renderer/redux/controlSlice'
import {
  setMoverFollowOverridePan,
  setMoverFollowOverrideTilt,
} from '../../renderer/redux/guiSlice'
import {
  setGroupBrightness,
  setGroupDiscoBall,
  setGroupGobo,
  setGroupPrism,
  setGroupPrismSpeed,
  setGroupStrobe,
  setMasterBrightness,
} from '../../renderer/redux/groupControlSlice'
import NodeLink from 'node-link'
import { PayloadAction } from '@reduxjs/toolkit'

const buttonThresholdState = new Map<string, boolean>()

/** The slice action one Groups-page fader dispatches. */
function groupControlSliderAction(
  control: SetGroupControlKind,
  group: string,
  value: number
): PayloadAction<{ group: string; value: number }> {
  const payload = { group, value }
  switch (control) {
    case 'strobe':
      return setGroupStrobe(payload)
    case 'discoBall':
      return setGroupDiscoBall(payload)
    case 'gobo':
      return setGroupGobo(payload)
    case 'prism':
      return setGroupPrism(payload)
    case 'prismSpeed':
      return setGroupPrismSpeed(payload)
    default:
      return setGroupBrightness(payload)
  }
}

interface MidiInput {
  id: string
  message: MidiMessage
}

function getInput(msg: MidiMessage): MidiInput {
  return {
    id: midiInputID(msg),
    message: msg,
  }
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value))
}

function normalizeCcValue(value: number): number {
  const maxRaw = value > 127 ? 255 : 127
  return clamp(value / maxRaw, 0, 1)
}

function normalizeNoteVelocity(velocity: number): number {
  const maxRaw = velocity > 127 ? 255 : 127
  return clamp(velocity / maxRaw, 0, 1)
}

// Handles a few common relative encoder styles:
// - 7-bit two's complement (1..63 up, 65..127 down, 64 center)
// - 8-bit signed (1..127 up, 129..255 down, 128 center)
function relativeCcDelta(value: number): number {
  if (value > 127) {
    if (value === 128) return 0
    const signed = value > 128 ? value - 256 : value
    return signed / 64
  }

  if (value === 64) return 0
  if (value > 64) {
    return (value - 128) / 64
  }
  return value / 64
}

function normalizeOptions(action: MidiAction, options: SliderControlOptions) {
  return normalizeSliderOptionsForAction(action, options)
}

export function handleMessage(
  message: MidiMessage,
  state: CleanReduxState,
  rt_state: RealtimeState,
  nodeLink: NodeLink,
  dispatch: (action: PayloadAction<any>) => void,
  tapTempo: () => void
) {
  const input = getInput(message)
  const midiState = state.control.device

  if (midiState.isEditing && midiState.listening) {
    const listenType = midiState.listening.type
    if (buttonMidiActionTypes.has(listenType)) {
      dispatch(
        midiSetButtonAction({
          inputID: input.id,
          action: midiState.listening,
        })
      )
    } else {
      if (input.message.type === 'CC') {
        dispatch(
          midiSetSliderAction({
            inputID: input.id,
            action: midiState.listening,
            options: initSliderOptions(midiState.listening, 'cc'),
          })
        )
      } else if (input.message.type === 'On') {
        const actionId = getActionID(midiState.listening)
        const existing: SliderAction | undefined =
          midiState.sliderActions[actionId]
        if (
          existing &&
          existing.inputID === input.id &&
          existing.options.type === 'note'
        ) {
          // if the note is already set, do nothing
        } else {
          dispatch(
            midiSetSliderAction({
              inputID: input.id,
              action: midiState.listening,
              options: initSliderOptions(midiState.listening, 'note'),
            })
          )
        }
      }
    }
    return
  }

  const buttonAction = Object.entries(midiState.buttonActions).find(
    ([_actionId, action]) => action.inputID === input.id
  )?.[1]

  if (buttonAction) {
    const actionKey = `${input.id}:${getActionID(buttonAction.action)}`
    const isMomentary = momentaryMidiActionTypes.has(buttonAction.action.type)

    const fireButtonAction = (pressed?: boolean) => {
      fireMidiButtonAction(
        dispatch,
        state,
        rt_state,
        buttonAction.action,
        tapTempo,
        pressed
      )
    }

    if (input.message.type === 'CC') {
      const pressed = input.message.value >= 64
      const wasPressed = buttonThresholdState.get(actionKey) === true
      buttonThresholdState.set(actionKey, pressed)
      if (isMomentary) {
        // Follow the pad in both directions.
        if (pressed !== wasPressed) {
          fireButtonAction(pressed)
        }
      } else if (pressed && !wasPressed) {
        fireButtonAction()
      }
    } else if (input.message.type === 'On') {
      if (isMomentary) {
        // Plenty of controllers send note-on with velocity 0 rather than a note-off.
        // Only momentary actions read velocity that way — latching actions keep
        // firing on any note-on, exactly as they did before.
        const pressed = input.message.velocity > 0
        const wasPressed = buttonThresholdState.get(actionKey) === true
        buttonThresholdState.set(actionKey, pressed)
        if (pressed !== wasPressed) {
          fireButtonAction(pressed)
        }
      } else {
        fireButtonAction()
      }
    } else {
      const wasPressed = buttonThresholdState.get(actionKey) === true
      buttonThresholdState.set(actionKey, false)
      if (isMomentary && wasPressed) {
        fireButtonAction(false)
      }
    }
  }

  const sliderAction = Object.entries(midiState.sliderActions).find(
    ([_actionId, action]) => action.inputID === input.id
  )?.[1]

  if (!sliderAction) return

  const action = sliderAction.action
  const options = normalizeOptions(action, sliderAction.options)
  const range = options.max - options.min

  const getOldVal = () => {
    if (action.type === 'setAutoSceneBombacity') {
      return state.control.light.auto.epicness
    } else if (action.type === 'setBpm') {
      return rt_state.time.bpm
    } else if (action.type === 'setBaseParam') {
      const splitIndex = getSetBaseParamSplitIndex(action)
      return (
        state.control.light.byId[state.control.light.active]?.splitScenes[
          splitIndex
        ]?.baseParams[action.paramKey] ?? 0.5
      )
    } else if (action.type === 'setMaster') {
      return state.control.master
    } else if (action.type === 'setGroupMasterDimmer') {
      return state.groupControl?.master?.brightness ?? 1
    } else if (action.type === 'setGroupControl') {
      const control = state.groupControl?.byGroup[action.group]
      if (control === undefined) {
        // Released positions: strobe and disco rest at the bottom, brightness at full.
        return action.control === 'brightness' ? 1 : 0
      }
      if (action.control === 'strobe') return control.strobe
      if (action.control === 'discoBall') return control.discoBall
      if (action.control === 'gobo') return control.gobo
      if (action.control === 'prism') return control.prism
      if (action.control === 'prismSpeed') return control.prismSpeed
      return control.brightness
    } else if (action.type === 'setMoverFollowOverridePan') {
      return state.gui.moverFollowOverridePan
    } else if (action.type === 'setMoverFollowOverrideTilt') {
      return state.gui.moverFollowOverrideTilt
    }

    return 0
  }

  const setNewVal = (newVal: number) => {
    const bounded = clamp(newVal, options.min, options.max)

    if (action.type === 'setAutoSceneBombacity') {
      dispatch(
        setAutoSceneBombacity({
          sceneType: 'light',
          val: bounded,
        })
      )
    } else if (action.type === 'setMaster') {
      dispatch(setMaster(bounded))
    } else if (action.type === 'setBaseParam') {
      dispatch(
        setBaseParams({
          splitIndex: getSetBaseParamSplitIndex(action),
          params: {
            [action.paramKey]: bounded,
          },
        })
      )
    } else if (action.type === 'setGroupControl') {
      dispatch(groupControlSliderAction(action.control, action.group, bounded))
    } else if (action.type === 'setGroupMasterDimmer') {
      dispatch(setMasterBrightness(bounded))
    } else if (action.type === 'setBpm') {
      nodeLink.setTempo(bounded)
    } else if (action.type === 'tapTempo') {
      tapTempo()
    } else if (action.type === 'setMoverFollowOverridePan') {
      dispatch(setMoverFollowOverridePan(clamp(bounded, 0, 1)))
    } else if (action.type === 'setMoverFollowOverrideTilt') {
      dispatch(setMoverFollowOverrideTilt(clamp(bounded, 0, 1)))
    }
  }

  if (options.type === 'cc') {
    if (input.message.type !== 'CC') return

    if (options.mode === 'absolute') {
      const normalized = normalizeCcValue(input.message.value)
      setNewVal(options.min + normalized * range)
    } else {
      const delta = relativeCcDelta(input.message.value) * range
      setNewVal(getOldVal() + delta)
    }
    return
  }

  if (input.message.type === 'On') {
    const normalizedVelocity = normalizeNoteVelocity(input.message.velocity)
    const val =
      options.value === 'velocity'
        ? options.min + normalizedVelocity * range
        : options.max

    if (options.mode === 'hold') {
      setNewVal(val)
    } else {
      if (getOldVal() > options.min) {
        setNewVal(options.min)
      } else {
        setNewVal(val)
      }
    }
  } else if (input.message.type === 'Off') {
    if (options.mode === 'hold') {
      setNewVal(options.min)
    }
  }
}
