import { useMemo } from 'react'
import styled from 'styled-components'
import { useRealtimeSelector } from 'renderer/redux/realtimeStore'
import {
  useActiveLightScene,
  useBaseParam,
  useDmxSelector,
} from 'renderer/redux/store'
import { applyRandomization } from 'shared/randomizer'
import { flatten_fixtures } from 'shared/dmxUtil'
import { buildRandomizerChaseRanks } from 'shared/splitRandomizer'
import { initRandomizerOptions } from 'shared/randomizer'

interface Props {
  splitIndex: number
}

const gapRatio = 0.5

export default function RandomizerVisualizer({ splitIndex }: Props) {
  return (
    <Root>
      <Visualizer splitIndex={splitIndex} />
    </Root>
  )
}

/**
 * Height has to be intrinsic, not borrowed.
 *
 * `flex: 1 0 0` gave the bars a zero basis, so they only had height when something
 * else in the row — the expanded colour chase panel — stretched this panel and left
 * free space behind. With that panel collapsed the bars vanished entirely.
 */
const Root = styled.div`
  flex: 1 0 auto;
  min-height: 3rem;
  padding: 0.3rem;
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
`

function Visualizer({ splitIndex }: Props) {
  const randomizerMix = useBaseParam('randomize', splitIndex) ?? 0
  const { splitStates } = useRealtimeSelector((rtState) => rtState)
  const dmx = useDmxSelector((state) => state)
  const stored = useActiveLightScene(
    (scene) => scene.splitScenes[splitIndex]?.randomizer
  )
  const splitGroups = useActiveLightScene(
    (scene) => scene.splitScenes[splitIndex]?.groups
  )

  const levels =
    splitStates[splitIndex]?.randomizer?.map((point) => point.level) ?? []
  const options = { ...initRandomizerOptions(), ...stored }
  const intensityCeiling =
    splitStates[splitIndex]?.outputParams?.intensity ?? 1

  /**
   * Bars are drawn in chase order, not slot order.
   *
   * Slots are built in patch order, but a chase runs in stage order — so drawing the
   * raw slot array made a perfectly good chase look like it was still firing lights at
   * random, because the lit bar jumped around wherever that fixture happened to be
   * patched. Reordering by the same ranks the engine uses means the preview sweeps the
   * way the rig does.
   */
  const displayLevels = useMemo(() => {
    if (options.mode !== 'chase' || splitGroups === undefined) {
      return levels
    }
    const ranks = buildRandomizerChaseRanks(
      flatten_fixtures(dmx.universe, dmx.fixtureTypesByID),
      splitGroups,
      intensityCeiling,
      levels.length,
      options.chaseOrdering
    )
    const ordered = new Array<number>(levels.length).fill(0)
    for (let slot = 0; slot < levels.length; slot++) {
      const rank = ranks[slot]
      if (rank >= 0 && rank < ordered.length) {
        ordered[rank] = levels[slot]
      }
    }
    return ordered
  }, [
    levels,
    options.mode,
    options.chaseOrdering,
    splitGroups,
    dmx,
    intensityCeiling,
  ])

  const divsAndGaps =
    displayLevels.length === 0 ? (
      <Gap />
    ) : (
      Array(displayLevels.length * 2 - 1)
        .fill(0)
        .map((_v, i) => {
          if (i % 2 === 0) {
            let level = displayLevels[i / 2]
            let randomizedLevel = applyRandomization(1.0, level, randomizerMix)
            return (
              <Div
                key={i}
                style={{
                  backgroundColor: `hsl(0, 0%, ${randomizedLevel * 100}%)`,
                }}
              />
            )
          } else {
            return <Gap key={i} />
          }
        })
    )
  return <VRoot>{divsAndGaps}</VRoot>
}

const VRoot = styled.div`
  display: flex;
  flex: 1 0 auto;
`

const Div = styled.div`
  flex: 1 0 0;
  background-color: #555;
`

const Gap = styled.div`
  flex: ${gapRatio} 0 0;
  max-width: 0.5rem;
`
