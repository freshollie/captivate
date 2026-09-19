import styled from 'styled-components'
import { useMemo } from 'react'
import {
  actionIDsSharingInput,
  findKeyboardChordIdForAction,
  getActionID,
  getMidiSliderBounds,
  type MidiAction,
} from '../redux/deviceState'
import {
  midiListen,
  keyboardListen,
  midiSetSliderAction,
  removeMidiAction,
  clearButtonMapping,
  removeKeyboardChord,
} from '../redux/controlSlice'
import { useDeviceSelector } from '../redux/store'
import { useDispatch } from 'react-redux'
import DraggableNumber from './DraggableNumber'
import Button from './Button'
import { formatChordId } from '../input/keyboardChord'

interface Props {
  children?: React.ReactNode
  action: MidiAction
  style?: React.CSSProperties
}

/**
 * The other controls this input drives, if any.
 *
 * Learning is additive, so a pad can carry a whole macro. Nothing else on the page
 * would say so — each control's overlay only knows its own binding — and a shared pad
 * nobody knows about is found out during a show, so the count goes next to the input
 * name and the tooltip names the company it is keeping.
 *
 * Selected as a joined string rather than an array: a fresh array compares unequal
 * every time and would re-render every visible overlay on every store action.
 */
function useSharedActionIDs(inputID: string | null, actionID: string): string[] {
  const sharedKey = useDeviceSelector((state) =>
    inputID === null
      ? ''
      : actionIDsSharingInput(state, inputID, actionID).join('\n')
  )
  return useMemo(
    () => (sharedKey.length === 0 ? [] : sharedKey.split('\n')),
    [sharedKey]
  )
}

function SharedInputBadge({ sharedActionIDs }: { sharedActionIDs: string[] }) {
  if (sharedActionIDs.length === 0) return null
  return (
    <SharedCount
      title={`This input also fires: ${sharedActionIDs.join(
        ', '
      )}. Clearing it here leaves those alone.`}
    >
      {`\u00d7${sharedActionIDs.length + 1}`}
    </SharedCount>
  )
}

export function ButtonMidiOverlay({ children, action, style }: Props) {
  const isEditing = useDeviceSelector((state) => state.isEditing)
  const keyboardLearnMode = useDeviceSelector((state) => state.keyboardLearnMode)
  const mappingVisible = isEditing || keyboardLearnMode

  const controlledAction = useDeviceSelector((state) => {
    return state.buttonActions[getActionID(action)] || null
  })
  const chordId = useDeviceSelector((state) =>
    findKeyboardChordIdForAction(state.keyboardShortcuts, action)
  )
  const isListeningMidi = useDeviceSelector((state) => {
    if (!state.listening) return false
    return getActionID(state.listening) === getActionID(action)
  })
  const isListeningKeyboard = useDeviceSelector((state) => {
    if (!state.keyboardListening) return false
    return getActionID(state.keyboardListening) === getActionID(action)
  })
  const isListening = isListeningMidi || isListeningKeyboard
  const sharedActionIDs = useSharedActionIDs(
    controlledAction?.inputID ?? null,
    getActionID(action)
  )
  const dispatch = useDispatch()

  const onClick = () => {
    if (keyboardLearnMode && !isEditing) {
      dispatch(keyboardListen(action))
      window.focus()
      if (document.activeElement instanceof HTMLElement) {
        document.activeElement.blur()
      }
    } else {
      dispatch(midiListen(action))
    }
  }

  return (
    <Root style={style}>
      {children}
      {mappingVisible && (
        <Overlay selected={isListening} onClick={onClick}>
          {(controlledAction || chordId) && (
            <BindingRow>
              {controlledAction ? (
                <>
                  <span>{controlledAction.inputID}</span>
                  <SharedInputBadge sharedActionIDs={sharedActionIDs} />
                  <ClearMappingsX action={action} />
                </>
              ) : null}
              {chordId ? (
                <span style={{ marginLeft: controlledAction ? '0.35rem' : 0 }}>
                  {formatChordId(chordId)}
                  <ClearKeyboardX chordId={chordId} />
                </span>
              ) : null}
            </BindingRow>
          )}
        </Overlay>
      )}
    </Root>
  )
}

function ClearMappingsX({ action }: { action: MidiAction }) {
  const dispatch = useDispatch()
  return (
    <div
      onClick={(e) => {
        e.stopPropagation()
        dispatch(clearButtonMapping(action))
      }}
      style={{ cursor: 'pointer', marginLeft: '0.5rem' }}
    >
      X
    </div>
  )
}

function ClearKeyboardX({ chordId }: { chordId: string }) {
  const dispatch = useDispatch()
  return (
    <span
      onClick={(e) => {
        e.stopPropagation()
        dispatch(removeKeyboardChord(chordId))
      }}
      style={{ cursor: 'pointer', marginLeft: '0.35rem' }}
    >
      ×
    </span>
  )
}

export function SliderMidiOverlay({ children, action, style }: Props) {
  const isEditing = useDeviceSelector((state) => state.isEditing)
  const controlledAction = useDeviceSelector((state) => {
    return state.sliderActions[getActionID(action)] || null
  })
  const isListening = useDeviceSelector((state) => {
    if (!state.listening) return false
    return getActionID(state.listening) === getActionID(action)
  })
  const sharedActionIDs = useSharedActionIDs(
    controlledAction?.inputID ?? null,
    getActionID(action)
  )
  const dispatch = useDispatch()

  const onClick = () => {
    dispatch(midiListen(action))
  }

  const onChangeMin = (newVal: number) => {
    dispatch(
      midiSetSliderAction({
        ...controlledAction,
        options: {
          ...controlledAction.options,
          min: newVal,
        },
      })
    )
  }

  const onChangeMax = (newVal: number) => {
    dispatch(
      midiSetSliderAction({
        ...controlledAction,
        options: {
          ...controlledAction.options,
          max: newVal,
        },
      })
    )
  }

  const onClickMode = () => {
    dispatch(
      midiSetSliderAction({
        ...controlledAction,
        options: {
          ...controlledAction.options,
          mode: controlledAction.options.mode === 'hold' ? 'toggle' : 'hold',
        },
      })
    )
  }

  const onClickMode_cc = () => {
    dispatch(
      midiSetSliderAction({
        ...controlledAction,
        options: {
          ...controlledAction.options,
          mode:
            controlledAction.options.mode === 'relative'
              ? 'absolute'
              : 'relative',
        },
      })
    )
  }

  const onClickValue = (value: 'max' | 'velocity') => () => {
    dispatch(
      midiSetSliderAction({
        ...controlledAction,
        options: {
          ...controlledAction.options,
          value: value === 'max' ? 'velocity' : 'max',
        },
      })
    )
  }

  const minMaxStyle: React.CSSProperties = {
    padding: '0.1rem 0.2rem',
    margin: '0.2rem',
    color: 'white',
    backgroundColor: '#0009',
  }

  const sliderBounds = getMidiSliderBounds(action)

  return (
    <Root style={style}>
      {children}
      {isEditing && (
        <Overlay selected={isListening} onClick={onClick}>
          <Wrapper>
            {controlledAction && (
              <>
                {controlledAction.inputID}
                <SharedInputBadge sharedActionIDs={sharedActionIDs} />
                <X action={action} />
                <MinMax>
                  <DraggableNumber
                    type="continuous"
                    style={minMaxStyle}
                    value={controlledAction.options.min}
                    min={sliderBounds.min}
                    max={controlledAction.options.max}
                    onChange={onChangeMin}
                    noArrows
                  />
                  <DraggableNumber
                    type="continuous"
                    style={minMaxStyle}
                    value={controlledAction.options.max}
                    min={controlledAction.options.min}
                    max={sliderBounds.max}
                    onChange={onChangeMax}
                    noArrows
                  />
                </MinMax>
                {controlledAction.options.type === 'note' && (
                  <>
                    <Button
                      fontSize="0.8rem"
                      label={controlledAction.options.mode}
                      onClick={onClickMode}
                    />
                    <Button
                      fontSize="0.8rem"
                      label={controlledAction.options.value}
                      onClick={onClickValue(controlledAction.options.value)}
                    />
                  </>
                )}
                {controlledAction.options.type === 'cc' && (
                  <Button
                    fontSize="0.8rem"
                    label={controlledAction.options.mode}
                    onClick={onClickMode_cc}
                  />
                )}
              </>
            )}
          </Wrapper>
        </Overlay>
      )}
    </Root>
  )
}

const BindingRow = styled.div`
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: center;
  gap: 0.15rem;
  font-size: 0.72rem;
`

const Root = styled.div`
  position: relative;
`

const Overlay = styled.div<{ selected: boolean }>`
  position: absolute;
  top: 0;
  bottom: 0;
  left: 0;
  right: 0;
  cursor: pointer;
  border: ${(props) => props.selected && '2px solid white'};
  background: #56fd56b7;
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  align-items: center;
  align-content: center;
  color: black;
`

const Wrapper = styled.div`
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  align-items: center;
  align-content: center;
  background-color: #56fd56b7;
`

/** Sits on the input name, so a shared pad reads as "0note40 x3" at a glance. */
const SharedCount = styled.span`
  margin-left: 0.2rem;
  padding: 0 0.15rem;
  border-radius: 0.15rem;
  font-size: 0.7rem;
  font-weight: 700;
  color: #ffffff;
  background: #00000066;
  cursor: help;
`

const MinMax = styled.div`
  display: flex;
  flex-wrap: wrap-reverse;
  font-size: 0.75rem;
  justify-content: center;
`

function X({ action }: { action: MidiAction }) {
  const dispatch = useDispatch()
  const onClick = () => dispatch(removeMidiAction(action))
  return (
    <div onClick={onClick} style={{ cursor: 'pointer', marginLeft: '0.5rem' }}>
      X
    </div>
  )
}
