import { useMemo, useState } from 'react'
import styled from 'styled-components'
import { useDispatch } from 'react-redux'
import { useActiveLightScene, useDmxSelector } from '../redux/store'
import { useRealtimeSelector } from '../redux/realtimeStore'
import {
  addColorChaseColor,
  removeColorChaseColor,
  setColorChase,
  setColorChaseColor,
} from '../redux/controlSlice'
import DraggableNumber from '../base/DraggableNumber'
import Slider from '../base/Slider'
import useDragMapped from '../hooks/useDragMapped'
import { flatten_fixtures } from '../../shared/dmxUtil'
import { getDmxRandomizerFixtures } from '../../shared/splitRandomizer'
import { getColorPreview, getColorChannelDistance } from '../../shared/dmxColors'
import type { ColorWheelSlot } from '../../shared/splitColorCapabilities'
import { clampNormalized } from '../../math/util'
import {
  COLOR_CHASE_MAX_BLOCK_SIZE,
  COLOR_CHASE_MAX_COLORS,
  COLOR_CHASE_MAX_PERIOD,
  COLOR_CHASE_MIN_PERIOD,
  COLOR_CHASE_PALETTE,
  ColorChaseColor,
  ColorChaseConfig,
  colorChaseBlockSizeLabel,
  colorChaseHsv,
  colorChaseOrderingDescription,
  colorChaseOrderingName,
  colorChaseOrderings,
  colorChasePatternName,
  colorChasePatterns,
  initColorChase,
  resolveColorChaseEntry,
} from '../../shared/colorChase'

interface Props {
  splitIndex: number
  /**
   * Colour-wheel slots available to this split, when it has any. Used as the preset
   * palette so a wheel chase is built from colours the fixture can actually make —
   * including its White, Amber and UV slots.
   */
  slots?: ColorWheelSlot[]
  /**
   * Whether the split has its own hue control. Colour-wheel-only splits have `hue` and
   * `saturation` deleted from their base params, so there is no split hue for the
   * chase to offset from and "Follow split hue" is meaningless there.
   */
  hasSplitHue?: boolean
}

/** Slots drawn when the split has no fixtures yet, so the preview is never empty. */
const PLACEHOLDER_SLOT_COUNT = 8

/**
 * Swatch fill. Shares `getColorPreview` with the colour-wheel panel so the same colour
 * looks the same in both, and so a desaturated swatch renders as white rather than the
 * mid-grey a flat 50% lightness would give.
 */
function swatchCss(hue: number, saturation: number): string {
  return getColorPreview({ hue, saturation })
}

export default function ColorChase({
  splitIndex,
  slots,
  hasSplitHue = true,
}: Props) {
  const dispatch = useDispatch()
  const stored = useActiveLightScene(
    (scene) => scene.splitScenes[splitIndex]?.colorChase
  )
  const [selectedColor, setSelectedColor] = useState(0)

  // Shown with defaults before the split has ever had a chase, so the panel reads
  // the same whether or not anything is stored yet.
  const config: ColorChaseConfig = stored ?? initColorChase()
  const patch = (update: Partial<Omit<ColorChaseConfig, 'colors'>>) =>
    dispatch(setColorChase({ splitIndex, patch: update }))

  const colorIndex = Math.min(selectedColor, config.colors.length - 1)
  const selected = config.colors[colorIndex]
  const blockSizeLabel = colorChaseBlockSizeLabel(config.pattern)

  // On a colour-wheel split the wheel's own slots are the only colours the fixture can
  // actually produce, so they make a far better palette than a generic one.
  const presets: Array<{ label: string; color: ColorChaseColor }> =
    slots !== undefined && slots.length > 0
      ? slots.map((slot) => ({
          label: slot.label,
          color: { hue: slot.hue, saturation: slot.saturation },
        }))
      : COLOR_CHASE_PALETTE.map(({ label, hue, saturation }) => ({
          label,
          color: { hue, saturation },
        }))

  return (
    <Root>
      <Header>
        <Title>Colour chase</Title>
        <ToggleButton
          type="button"
          enabled={config.enabled}
          onClick={() => patch({ enabled: !config.enabled })}
        >
          {config.enabled ? 'On' : 'Off'}
        </ToggleButton>
      </Header>

      {config.enabled && (
        <Body>
          <ChasePreview splitIndex={splitIndex} config={config} slots={slots} />

          <SwatchRow>
            {config.colors.map((color, index) => (
              <Swatch
                key={index}
                type="button"
                selected={index === colorIndex}
                style={{ background: swatchCss(color.hue, color.saturation) }}
                onClick={() => setSelectedColor(index)}
                title={`Colour ${index + 1}`}
              />
            ))}
            <SmallButton
              type="button"
              disabled={config.colors.length >= COLOR_CHASE_MAX_COLORS}
              onClick={() => dispatch(addColorChaseColor({ splitIndex }))}
            >
              +
            </SmallButton>
            <SmallButton
              type="button"
              disabled={config.colors.length <= 1}
              onClick={() => {
                dispatch(
                  removeColorChaseColor({ splitIndex, index: colorIndex })
                )
                setSelectedColor(Math.max(0, colorIndex - 1))
              }}
            >
              &minus;
            </SmallButton>
          </SwatchRow>

          {selected !== undefined && (
            <>
              <HueBar
                hue={selected.hue}
                onChange={(hue) =>
                  dispatch(
                    setColorChaseColor({
                      splitIndex,
                      index: colorIndex,
                      color: { ...selected, hue },
                    })
                  )
                }
              />
              <LabelledRow>
                <RowLabel>Sat</RowLabel>
                <SliderWrapper>
                  <Slider
                    value={selected.saturation}
                    orientation="horizontal"
                    onChange={(saturation) =>
                      dispatch(
                        setColorChaseColor({
                          splitIndex,
                          index: colorIndex,
                          color: { ...selected, saturation },
                        })
                      )
                    }
                  />
                </SliderWrapper>
                <SmallButton
                  type="button"
                  title="White - desaturates the swatch, which opens the fixture's white channel"
                  onClick={() =>
                    dispatch(
                      setColorChaseColor({
                        splitIndex,
                        index: colorIndex,
                        color: { hue: selected.hue, saturation: 0 },
                      })
                    )
                  }
                >
                  W
                </SmallButton>
              </LabelledRow>

              <PresetRow>
                {presets.map((preset, index) => (
                  <PresetSwatch
                    key={index}
                    type="button"
                    title={preset.label}
                    style={{
                      background: swatchCss(
                        preset.color.hue,
                        preset.color.saturation
                      ),
                    }}
                    onClick={() =>
                      dispatch(
                        setColorChaseColor({
                          splitIndex,
                          index: colorIndex,
                          color: preset.color,
                        })
                      )
                    }
                  />
                ))}
              </PresetRow>
            </>
          )}

          <ButtonRow>
            {colorChasePatterns.map((pattern) => (
              <ChoiceButton
                key={pattern}
                type="button"
                enabled={config.pattern === pattern}
                onClick={() => patch({ pattern })}
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
                enabled={config.ordering === ordering}
                onClick={() => patch({ ordering })}
              >
                {colorChaseOrderingName(ordering)}
              </ChoiceButton>
            ))}
          </ButtonRow>

          {(!config.static || blockSizeLabel !== null) && (
          <LabelledRow>
            {!config.static && (
              <>
                <RowLabel>Beats</RowLabel>
                <DraggableNumber
                  value={config.period}
                  min={COLOR_CHASE_MIN_PERIOD}
                  max={COLOR_CHASE_MAX_PERIOD}
                  onChange={(period) => patch({ period })}
                  title="Beats between chase steps"
                />
              </>
            )}
            {blockSizeLabel !== null && (
              <>
                <RowLabel>{blockSizeLabel}</RowLabel>
                <DraggableNumber
                  value={
                    config.pattern === 'runner' ? config.tail : config.blockSize
                  }
                  min={1}
                  max={COLOR_CHASE_MAX_BLOCK_SIZE}
                  onChange={(value) =>
                    patch(
                      config.pattern === 'runner'
                        ? { tail: value }
                        : { blockSize: value }
                    )
                  }
                  title={
                    config.pattern === 'rotate'
                      ? 'Fixtures per colour before it changes'
                      : 'Fixtures lit by the moving window'
                  }
                />
              </>
            )}
          </LabelledRow>
          )}

          {!config.static && (
            <LabelledRow>
              <RowLabel>Fade</RowLabel>
              <SliderWrapper>
                <Slider
                  value={config.fade}
                  orientation="horizontal"
                  onChange={(fade) => patch({ fade })}
                  title="Crossfade into each step. 0 is a hard cut."
                />
              </SliderWrapper>
            </LabelledRow>
          )}

          <ButtonRow>
            <ChoiceButton
              type="button"
              title="Hold the pattern still instead of stepping it on the beat"
              enabled={config.static}
              onClick={() => patch({ static: !config.static })}
            >
              Static
            </ChoiceButton>
            <ChoiceButton
              type="button"
              enabled={config.reverse}
              disabled={config.static}
              onClick={() => patch({ reverse: !config.reverse })}
            >
              Reverse
            </ChoiceButton>
            <ChoiceButton
              type="button"
              title="Run the pattern outward from the centre in both directions at once. With Reverse it runs inward instead."
              enabled={config.mirror}
              onClick={() => patch({ mirror: !config.mirror })}
            >
              Mirror
            </ChoiceButton>
            {hasSplitHue && (
              <ChoiceButton
                type="button"
                title="Read swatches as offsets from the first one, so the split colour moves the whole palette"
                enabled={config.followSplitHue}
                onClick={() => patch({ followSplitHue: !config.followSplitHue })}
              >
                Follow split hue
              </ChoiceButton>
            )}
          </ButtonRow>
        </Body>
      )}
    </Root>
  )
}

/**
 * Live strip of what each fixture is showing, in chase order rather than patch
 * order — so the preview reads left to right the way the rig does.
 */
function ChasePreview({
  splitIndex,
  config,
  slots,
}: {
  splitIndex: number
  config: ColorChaseConfig
  slots?: ColorWheelSlot[]
}) {
  const dmx = useDmxSelector((state) => state)
  const splitGroups = useActiveLightScene(
    (scene) => scene.splitScenes[splitIndex]?.groups
  )
  const splitState = useRealtimeSelector(
    (rtState) => rtState.splitStates[splitIndex]
  )
  const outputParams = splitState?.outputParams
  const runtime = splitState?.colorChase

  const slotCount = useMemo(() => {
    if (splitGroups === undefined) return 0
    const fixtures = flatten_fixtures(
      dmx.universe,
      dmx.fixtureTypesByID,
      dmx.moverGroupByFixtureId
    )
    const intensityCeiling = outputParams?.intensity ?? 1
    return getDmxRandomizerFixtures(fixtures, splitGroups, intensityCeiling)
      .length
  }, [dmx, splitGroups, outputParams?.intensity])

  const count = slotCount > 0 ? slotCount : PLACEHOLDER_SLOT_COUNT
  const baseHue = clampNormalized(outputParams?.hue ?? 0.5)
  const baseSaturation = clampNormalized(outputParams?.saturation ?? 1)
  // Ranks are the identity here: the preview is drawn in chase order already, so
  // showing rank 0 first is what makes an odd/even pattern visibly alternate.
  const step = runtime?.step ?? 0
  const stepProgress = runtime?.stepProgress ?? 0

  const swatches = Array.from({ length: count }, (_, rank) => {
    const entry = resolveColorChaseEntry(
      rank,
      count,
      { step, stepProgress },
      config
    )
    const resolved = colorChaseHsv(entry, config, baseHue, baseSaturation)
    const shown = snapToWheelSlot(resolved, slots)
    return swatchCss(shown.hue, shown.saturation)
  })

  return (
    <PreviewRow title={
      slotCount > 0
        ? `${slotCount} fixtures in chase order`
        : 'No fixtures in this split yet'
    }>
      {swatches.map((background, index) => (
        <PreviewCell
          key={index}
          dimmed={slotCount === 0}
          style={{ background }}
        />
      ))}
    </PreviewRow>
  )
}

/**
 * A colour-wheel fixture can only land on one of its slots, so the preview snaps to the
 * slot the engine's own matcher would pick. Without this, dragging the hue bar on a
 * wheel split shows a smooth colour the rig will never actually produce.
 */
function snapToWheelSlot(
  color: ColorChaseColor,
  slots: ColorWheelSlot[] | undefined
): ColorChaseColor {
  if (slots === undefined || slots.length === 0) {
    return color
  }
  let best = slots[0]!
  let bestScore = Number.POSITIVE_INFINITY
  for (const slot of slots) {
    const score = getColorChannelDistance(color.hue, color.saturation, slot)
    if (Number.isFinite(score) && score < bestScore) {
      bestScore = score
      best = slot
    }
  }
  return { hue: best.hue, saturation: best.saturation }
}

function HueBar({
  hue,
  onChange,
}: {
  hue: number
  onChange: (hue: number) => void
}) {
  const [dragContainer, onPointerDown] = useDragMapped(({ x }) => onChange(x))

  return (
    <HueBarRoot ref={dragContainer} onPointerDown={onPointerDown}>
      <HueCursor style={{ left: `${hue * 100}%` }} />
    </HueBarRoot>
  )
}

const Root = styled.div`
  width: 200px;
  border: 1px solid ${(props) => props.theme.colors.divider};
  box-sizing: border-box;
  margin-right: 1rem;
  display: flex;
  flex-direction: column;
`

const Header = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.3rem;
`

const Title = styled.div`
  font-size: 0.75rem;
  color: ${(props) => props.theme.colors.text.secondary};
`

const Body = styled.div`
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
  padding: 0 0.3rem 0.3rem 0.3rem;
`

const ToggleButton = styled.button<{ enabled: boolean }>`
  border: 1px solid ${(props) => (props.enabled ? '#fff' : '#666')};
  background: ${(props) => (props.enabled ? '#ffffff22' : '#00000055')};
  color: ${(props) => (props.enabled ? '#fff' : '#aaa')};
  cursor: pointer;
  font-size: 0.65rem;
  border-radius: 3px;
  padding: 0.15rem 0.5rem;
`

const PreviewRow = styled.div`
  display: flex;
  gap: 1px;
  height: 1.1rem;
`

const PreviewCell = styled.div<{ dimmed: boolean }>`
  flex: 1 0 0;
  opacity: ${(props) => (props.dimmed ? 0.3 : 1)};
`

const SwatchRow = styled.div`
  display: flex;
  align-items: center;
  gap: 0.25rem;
  flex-wrap: wrap;
`

const Swatch = styled.button<{ selected: boolean }>`
  width: 1.4rem;
  height: 1.4rem;
  padding: 0;
  cursor: pointer;
  border-radius: 3px;
  border: 2px solid ${(props) => (props.selected ? '#fff' : 'transparent')};
  box-shadow: 0 0 0 1px #0008;
`

const SmallButton = styled.button`
  width: 1.4rem;
  height: 1.4rem;
  padding: 0;
  cursor: pointer;
  border-radius: 3px;
  border: 1px solid #666;
  background: #00000055;
  color: #ddd;
  font-size: 0.8rem;
  line-height: 1;

  &:disabled {
    opacity: 0.35;
    cursor: default;
  }
`

const ButtonRow = styled.div`
  display: flex;
  gap: 0.2rem;
  flex-wrap: wrap;
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

  &:disabled {
    opacity: 0.35;
    cursor: default;
  }
`

const PresetRow = styled.div`
  display: flex;
  gap: 2px;
  height: 0.9rem;
`

const PresetSwatch = styled.button`
  flex: 1 0 0;
  padding: 0;
  border: none;
  cursor: pointer;
  box-shadow: inset 0 0 0 1px #0006;
`

const LabelledRow = styled.div`
  display: flex;
  align-items: center;
  gap: 0.3rem;
  height: 1.5rem;
`

const RowLabel = styled.div`
  font-size: 0.6rem;
  color: ${(props) => props.theme.colors.text.secondary};
`

const SliderWrapper = styled.div`
  flex: 1 0 0;
  height: 100%;
`

const HueBarRoot = styled.div`
  width: 100%;
  height: 14px;
  position: relative;
  cursor: pointer;
  background: linear-gradient(
    to right,
    #f00 0%,
    #ff0 17%,
    #0f0 33%,
    #0ff 50%,
    #00f 67%,
    #f0f 83%,
    #f00 100%
  );
`

const HueCursor = styled.div`
  width: 0.4rem;
  border: 1.5px solid white;
  border-radius: 4px;
  position: absolute;
  top: -3px;
  bottom: -3px;
  transform: translate(-0.2rem, 0);
  box-sizing: border-box;
`
