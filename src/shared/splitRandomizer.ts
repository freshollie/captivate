import type { FlattenedFixture } from './dmxFixtures'
import { getFixturesInGroups } from './dmxUtil'
import {
  getLedFixturePixelCount,
  type LedFixture,
  normalizeLedFixtureForRuntime,
} from './ledFixtures'
import { applyRandomization, type RandomizerState } from './randomizer'
import {
  colorChaseIsActive,
  colorChaseRanks,
  type ColorChaseConfig,
  type ColorChaseOrdering,
  type ColorChaseRuntime,
} from './colorChase'
import { clampNormalized } from '../math/util'
import type { LedColorChaseContext } from './ledFixtures'
import type { BaseColors } from './baseColors'
import {
  ledFixtureMatchesSceneGroups,
  sceneGroupsHasExplicitInclude,
  type SceneGroups,
} from './sceneGroups'
import { getParam, type Params } from './params'

export function getLedFixturesInSceneGroups(
  ledFixtures: LedFixture[],
  sceneGroups: SceneGroups
): LedFixture[] {
  return ledFixtures
    .map((fixture) => normalizeLedFixtureForRuntime(fixture))
    .filter((fixture) => ledFixtureMatchesSceneGroups(fixture.groups, sceneGroups))
}

export function countLedRandomizerSlots(
  ledFixtures: LedFixture[],
  sceneGroups: SceneGroups
): number {
  return getLedFixturesInSceneGroups(ledFixtures, sceneGroups).reduce(
    (sum, fixture) => sum + getLedFixturePixelCount(fixture),
    0
  )
}

/**
 * Ordered DMX fixtures that own randomizer slots for a split (must match engine consume).
 *
 * One slot per **physical** fixture. `flatten_fixture` splits a fixture into channel-family
 * partitions (RGB / white / everything else), and every partition resolves to the same
 * identity key — so counting partitions inflated the slot array (a 2-mover split showed 4)
 * and left the extra slots permanently dark. Sharing one slot is also the behavior you
 * want: a fixture's emitters dim together rather than drifting apart.
 */
export function getDmxRandomizerFixtures(
  fixtures: FlattenedFixture[],
  sceneGroups: SceneGroups,
  intensityCeiling: number
): FlattenedFixture[] {
  const seen = new Set<string>()
  const owners: FlattenedFixture[] = []

  for (const fixture of getFixturesInGroups(fixtures, sceneGroups)) {
    if (fixture.intensity > intensityCeiling) continue
    const key = flattenedFixtureIdentityKey(fixture)
    if (seen.has(key)) continue
    seen.add(key)
    owners.push(fixture)
  }

  return owners
}

export function countDmxRandomizerSlots(
  fixtures: FlattenedFixture[],
  sceneGroups: SceneGroups,
  intensityCeiling: number
): number {
  return getDmxRandomizerFixtures(fixtures, sceneGroups, intensityCeiling).length
}

/**
 * Identity of the *light* that owns a randomizer slot.
 *
 * Channel-family partitions of one light share a slot, so a fixture's emitters dim
 * together instead of drifting apart. Subfixtures do not: a two-head bar is two
 * lights, and the parent's own channels are a third, so each has to randomize on its
 * own. Keyed on the subfixture index rather than the fixture id alone — collapsing
 * them makes a multi-head fixture randomize as a single lamp.
 */
function flattenedFixtureIdentityKey(fixture: FlattenedFixture): string {
  const part =
    fixture.subFixtureIndex === undefined ? 'main' : `sub${fixture.subFixtureIndex}`
  const fixtureId =
    typeof fixture.fixtureId === 'string' ? fixture.fixtureId.trim() : ''
  if (fixtureId.length > 0) {
    return `id:${fixtureId}:${part}`
  }
  const firstCh = fixture.channels[0]?.[0]
  const typeId =
    typeof fixture.fixtureTypeId === 'string' ? fixture.fixtureTypeId : ''
  return `ch:${Number.isFinite(firstCh) ? firstCh : -1}:type:${typeId}:${part}`
}

/** Slot index in the split randomizer array for a DMX fixture, or -1 if filtered out. */
export function dmxRandomizerSlotIndex(
  randomizerFixtures: FlattenedFixture[],
  fixture: FlattenedFixture
): number {
  const key = flattenedFixtureIdentityKey(fixture)
  return randomizerFixtures.findIndex(
    (entry) => flattenedFixtureIdentityKey(entry) === key
  )
}

export function countSplitRandomizerSlots(
  fixtures: FlattenedFixture[],
  ledFixtures: LedFixture[],
  sceneGroups: SceneGroups,
  intensityCeiling: number
): number {
  return (
    countDmxRandomizerSlots(fixtures, sceneGroups, intensityCeiling) +
    countLedRandomizerSlots(ledFixtures, sceneGroups)
  )
}

/** Pixel offset within the LED portion of a split's randomizer array. */
export function getLedFixtureRandomizerBaseIndex(
  ledFixtures: LedFixture[],
  sceneGroups: SceneGroups,
  fixtureId: string
): number {
  let offset = 0
  for (const fixture of getLedFixturesInSceneGroups(ledFixtures, sceneGroups)) {
    if (fixture.id === fixtureId) {
      return offset
    }
    offset += getLedFixturePixelCount(fixture)
  }
  return offset
}

export function pickPrimarySplitLayerForLed<T extends { splitIndex: number }>(
  layers: T[],
  splitScenes: Array<{ groups: SceneGroups }>
): T | null {
  if (layers.length === 0) {
    return null
  }

  const withExplicitInclude = layers.filter((layer) => {
    const groups = splitScenes[layer.splitIndex]?.groups
    return groups !== undefined && sceneGroupsHasExplicitInclude(groups)
  })

  return withExplicitInclude[0] ?? layers[0]
}

export function buildLedRandomizerContext(
  splitState: { randomizer: RandomizerState; outputParams: Params } | undefined,
  splitScene: { groups: SceneGroups } | undefined,
  ledFixtures: LedFixture[],
  flattenedFixtures: FlattenedFixture[],
  fixtureId: string
): { state: RandomizerState; baseIndex: number; randomize: number } | null {
  if (splitState === undefined || splitScene === undefined) {
    return null
  }

  const randomize = getParam(splitState.outputParams, 'randomize')
  if (randomize <= 0) {
    return null
  }

  const intensityCeiling = splitState.outputParams.intensity ?? 1
  const baseIndex =
    countDmxRandomizerSlots(flattenedFixtures, splitScene.groups, intensityCeiling) +
    getLedFixtureRandomizerBaseIndex(ledFixtures, splitScene.groups, fixtureId)

  return {
    state: splitState.randomizer,
    baseIndex,
    randomize,
  }
}

/**
 * Chase context for an LED fixture, or undefined when the split has no chase running.
 *
 * Unlike the randomizer there is no slot offset to work out: an LED fixture chases
 * along its own pixels (see `LedColorChaseContext`), so the config and the beat-locked
 * runtime position are all a caller needs.
 */
export function buildLedColorChaseContext(
  splitScene: { colorChase?: ColorChaseConfig } | undefined,
  splitState: { colorChase?: ColorChaseRuntime | null } | undefined
): LedColorChaseContext | undefined {
  const config = splitScene?.colorChase
  const runtime = splitState?.colorChase
  if (!colorChaseIsActive(config) || runtime === undefined || runtime === null) {
    return undefined
  }
  return { config, runtime }
}

export function applyLedRandomizerToColors(
  colors: BaseColors[],
  randomizer: RandomizerState | undefined,
  randomizerBaseIndex: number,
  randomizationAmount: number
): BaseColors[] {
  if (randomizationAmount <= 0 || colors.length === 0) {
    return colors
  }

  return colors.map((color, pixelIndex) => {
    const randomizerLevel = randomizer?.[randomizerBaseIndex + pixelIndex]?.level ?? 1
    return {
      red: applyRandomization(color.red, randomizerLevel, randomizationAmount),
      green: applyRandomization(color.green, randomizerLevel, randomizationAmount),
      blue: applyRandomization(color.blue, randomizerLevel, randomizationAmount),
    }
  })
}

/**
 * Chase position for every randomizer slot in a split.
 *
 * Mirrors the slot layout `countSplitRandomizerSlots` builds: one entry per physical
 * DMX light, ranked by stage position, then one per LED pixel left in pixel order and
 * pushed past the DMX block so the two do not interleave.
 *
 * Shared with the renderer so the randomizer preview can draw its bars in the same
 * order the engine fires them. Drawing them in slot order instead makes a working
 * chase look like it is still picking lights at random, because slot order is patch
 * order and the chase runs in stage order.
 */
export function buildRandomizerChaseRanks(
  fixtures: FlattenedFixture[],
  groups: SceneGroups,
  intensityCeiling: number,
  slotCount: number,
  ordering: ColorChaseOrdering
): number[] {
  const dmxFixtures = getDmxRandomizerFixtures(fixtures, groups, intensityCeiling)
  const ranks = colorChaseRanks(
    dmxFixtures.map((fixture) => ({
      x: clampNormalized(fixture.window?.x?.pos ?? 0.5),
      y: clampNormalized(fixture.window?.y?.pos ?? 0.5),
    })),
    ordering
  )

  const all = new Array<number>(slotCount)
  for (let i = 0; i < slotCount; i++) {
    all[i] = i < ranks.length ? ranks[i] : i
  }
  return all
}
