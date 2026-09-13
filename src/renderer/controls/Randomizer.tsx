import styled from 'styled-components'
import { useActiveLightScene, useBaseParam } from '../redux/store'
import RandomizerVisualizer from './RandomizerVisualizer'
import DraggableNumber from '../base/DraggableNumber'
import { useDispatch } from 'react-redux'
import { setRandomizer, setRandomizerChase } from '../redux/controlSlice'
import {
  colorChaseOrderingDescription,
  colorChaseOrderingName,
  colorChaseOrderings,
  colorChasePatternName,
  colorChasePatterns,
  COLOR_CHASE_MAX_BLOCK_SIZE,
} from '../../shared/colorChase'
import { initRandomizerOptions } from '../../shared/randomizer'
import Slider from '../base/Slider'
import ParamSlider from './ParamSlider'
import ADSR, { Control } from './ADSR'

interface Props {
  splitIndex: number
}

export default function Randomizer({ splitIndex }: Props) {
  const randomizer = useActiveLightScene((scene) =>
    scene.splitScenes[splitIndex]?.randomizer
  )
  const dispatch = useDispatch()
  const randomize = useBaseParam('randomize', splitIndex)

  if (randomizer === undefined || randomize === undefined) {
    return null
  }

  const options = { ...initRandomizerOptions(), ...randomizer }
  const {
    triggerPeriod,
    envelopeRatio,
    envelopeDuration,
  } = options
  const isChase = options.mode === 'chase'
  const patchChase = (patch: Parameters<typeof setRandomizerChase>[0]['patch']) =>
    dispatch(setRandomizerChase({ splitIndex, patch }))

  const ratio: Control = {
    val: envelopeRatio,
    min: 0,
    max: 1,
    onChange: (newVal) => {
      dispatch(
        setRandomizer({
          key: 'envelopeRatio',
          value: newVal,
          splitIndex,
        })
      )
    },
  }

  const duration: Control = {
    val: envelopeDuration,
    min: 0.1,
    max: 16,
    onChange: (newVal) => {
      dispatch(
        setRandomizer({
          key: 'envelopeDuration',
          value: newVal,
          splitIndex,
        })
      )
    },
  }

  return (
    <>
      <Root>
        <ModeRow>
          <ModeButton
            type="button"
            enabled={!isChase}
            title="Fire a random handful of lights each period"
            onClick={() => patchChase({ mode: 'random' })}
          >
            Random
          </ModeButton>
          <ModeButton
            type="button"
            enabled={isChase}
            title="Fire lights in a deliberate spatial order instead of at random"
            onClick={() => patchChase({ mode: 'chase' })}
          >
            Chase
          </ModeButton>
        </ModeRow>
        <ADSR width={200} height={100} ratio={ratio} duration={duration} />
        <RandomizerVisualizer splitIndex={splitIndex} />
        {isChase && (
          <ChaseRows>
            <ButtonRow>
              {colorChasePatterns.map((pattern) => (
                <ChoiceButton
                  key={pattern}
                  type="button"
                  enabled={options.chasePattern === pattern}
                  onClick={() => patchChase({ chasePattern: pattern })}
                >
                  {colorChasePatternName(pattern)}
                </ChoiceButton>
              ))}
            </ButtonRow>
            <ButtonRow>
              {colorChaseOrderings.map((ordering) => (
                <ChoiceButton
                  key={ordering}
                  type="button"
                  title={colorChaseOrderingDescription(ordering)}
                  enabled={options.chaseOrdering === ordering}
                  onClick={() => patchChase({ chaseOrdering: ordering })}
                >
                  {colorChaseOrderingName(ordering)}
                </ChoiceButton>
              ))}
            </ButtonRow>
            <ButtonRow>
              <ChoiceButton
                type="button"
                enabled={options.chaseReverse}
                onClick={() =>
                  patchChase({ chaseReverse: !options.chaseReverse })
                }
              >
                Reverse
              </ChoiceButton>
              <ChoiceButton
                type="button"
                title="Run outward from the centre in both directions at once"
                enabled={options.chaseMirror}
                onClick={() => patchChase({ chaseMirror: !options.chaseMirror })}
              >
                Mirror
              </ChoiceButton>
              {options.chasePattern !== 'runner' && (
                <>
                  {/* Runner ignores the group count - its window is the firing
                      group - so the control only appears where it does something. */}
                  <NumberLabel>Groups</NumberLabel>
                  <DraggableNumber
                    value={Math.max(2, options.chaseGroups)}
                    min={2}
                    max={8}
                    title="Split the rig into this many groups and light one at a time. 2 alternates, 4 lights a quarter at a time."
                    onChange={(newVal) => patchChase({ chaseGroups: newVal })}
                  />
                </>
              )}
              {options.chasePattern === 'runner' && (
                <>
                  <NumberLabel>Tail</NumberLabel>
                  <DraggableNumber
                    value={options.chaseTail}
                    min={1}
                    max={COLOR_CHASE_MAX_BLOCK_SIZE}
                    title="How many lights the travelling window covers"
                    onChange={(newVal) => patchChase({ chaseTail: newVal })}
                  />
                </>
              )}
              {options.chasePattern === 'rotate' && (
                <>
                  <NumberLabel>Run</NumberLabel>
                  <DraggableNumber
                    value={options.chaseBlockSize}
                    min={1}
                    max={COLOR_CHASE_MAX_BLOCK_SIZE}
                    title="How many adjacent lights share a group. 1 alternates light by light."
                    onChange={(newVal) => patchChase({ chaseBlockSize: newVal })}
                  />
                </>
              )}
            </ButtonRow>
          </ChaseRows>
        )}
        <Row>
          <div
            style={{
              flex: '1 0 0',
              marginRight: '0.3rem',
              // Density picks how many lights fire at random; in chase mode the
              // pattern decides that, so the control has nothing to say.
              visibility: isChase ? 'hidden' : 'visible',
            }}
          >
            <Slider
              value={options.triggerDensity}
              orientation="horizontal"
              onChange={(newVal) =>
                dispatch(
                  setRandomizer({
                    key: 'triggerDensity',
                    value: newVal,
                    splitIndex,
                  })
                )
              }
            />
          </div>
          <DraggableNumber
            value={triggerPeriod}
            min={0.05}
            max={4}
            onChange={(newVal) =>
              dispatch(
                setRandomizer({
                  key: 'triggerPeriod',
                  value: newVal,
                  splitIndex,
                })
              )
            }
          />
        </Row>
      </Root>
      <ParamSlider param={'randomize'} splitIndex={splitIndex} />
    </>
  )
}

const Root = styled.div`
  position: relative;
  width: fit-content;
  border: 1px solid ${(props) => props.theme.colors.divider};
  display: flex;
  flex-direction: column;
  box-sizing: border-box;
  margin-right: 1rem;
`

const ModeRow = styled.div`
  display: flex;
  gap: 0.2rem;
  padding: 0.3rem 0.3rem 0 0.3rem;
`

const ModeButton = styled.button<{ enabled: boolean }>`
  flex: 1 0 0;
  border: 1px solid ${(props) => (props.enabled ? '#fff' : '#666')};
  background: ${(props) => (props.enabled ? '#ffffff22' : '#00000055')};
  color: ${(props) => (props.enabled ? '#fff' : '#aaa')};
  cursor: pointer;
  font-size: 0.65rem;
  border-radius: 3px;
  padding: 0.15rem 0.3rem;
`

const ChaseRows = styled.div`
  display: flex;
  flex-direction: column;
  gap: 0.2rem;
  padding: 0 0.3rem;
`

const ButtonRow = styled.div`
  display: flex;
  gap: 0.2rem;
  flex-wrap: wrap;
  align-items: center;
`

const ChoiceButton = styled.button<{ enabled: boolean }>`
  flex: 1 0 auto;
  border: 1px solid ${(props) => (props.enabled ? '#fff' : '#666')};
  background: ${(props) => (props.enabled ? '#ffffff22' : '#00000055')};
  color: ${(props) => (props.enabled ? '#fff' : '#aaa')};
  cursor: pointer;
  font-size: 0.6rem;
  border-radius: 3px;
  padding: 0.2rem 0.3rem;
  white-space: nowrap;
`

const NumberLabel = styled.div`
  font-size: 0.6rem;
  color: ${(props) => props.theme.colors.text.secondary};
`

const Row = styled.div`
  width: 100%;
  display: flex;
  height: 2rem;
  align-items: stretch;
  padding: 0 0.3rem 0.3rem 0.3rem;
  box-sizing: border-box;
`
