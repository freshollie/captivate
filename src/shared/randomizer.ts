import { TimeState, isNewPeriod } from './TimeState'
import { lerp } from '../math/util'
import {
  chaseBucketIndex,
  colorChasePatterns,
  normalizeChaseOrdering,
  type ChaseShape,
  type ColorChaseOrdering,
  type ColorChasePattern,
} from './colorChase'

type Normalized = number

export interface Point {
  level: Normalized
  rising: boolean
}

export type RandomizerState = Point[]

/**
 * How the randomizer decides which lights fire each period.
 *
 * `random` is the original behaviour: a random handful, sized by `triggerDensity`.
 * `chase` hands that decision to the same pattern engine the colour chase uses, so the
 * lights pulse in a deliberate spatial order instead. Either way the envelope, the
 * `randomize` mix and the slot space are unchanged — only the choice of which lights
 * trigger differs.
 */
export type RandomizerMode = 'random' | 'chase'

export function initRandomizerOptions() {
  return {
    triggerPeriod: 1, // beats
    triggerDensity: 0.3,
    envelopeRatio: 0.1,
    envelopeDuration: 1, // beats
    mode: 'random' as RandomizerMode,
    /**
     * Chase settings. `triggerPeriod` doubles as the chase step, so there is one
     * control for "how often something changes" rather than two that can disagree.
     */
    chasePattern: 'runner' as ColorChasePattern,
    chaseOrdering: 'columns' as ColorChaseOrdering,
    /**
     * Number of groups the pattern cycles through; only group 0 fires. Meaningless
     * below 2 for rotate and blocks, where a single group puts every light in group 0
     * and fires the whole rig in unison.
     */
    chaseGroups: 2,
    /** Rotate: how many adjacent lights share a group. */
    chaseBlockSize: 1,
    /** Runner: how many lights the travelling window covers. Kept separate from
     * `chaseBlockSize` because a tail of 4 is a good runner but makes rotate fire
     * four lights at once, which reads as the whole rig flashing. */
    chaseTail: 1,
    chaseReverse: false,
    chaseMirror: false,
  }
}

export type RandomizerOptions = ReturnType<typeof initRandomizerOptions>

export const randomizerModes: RandomizerMode[] = ['random', 'chase']

/**
 * Fills in fields a randomizer saved before chase mode existed does not have, so the
 * engine and the UI never read `undefined` out of an old project.
 */
export function normalizeRandomizerOptions(value: unknown): RandomizerOptions {
  const defaults = initRandomizerOptions()
  if (value === null || typeof value !== 'object') {
    return defaults
  }
  const raw = value as Partial<RandomizerOptions>
  const num = (v: unknown, fallback: number) =>
    Number.isFinite(v) ? (v as number) : fallback

  return {
    triggerPeriod: num(raw.triggerPeriod, defaults.triggerPeriod),
    triggerDensity: num(raw.triggerDensity, defaults.triggerDensity),
    envelopeRatio: num(raw.envelopeRatio, defaults.envelopeRatio),
    envelopeDuration: num(raw.envelopeDuration, defaults.envelopeDuration),
    mode: raw.mode === 'chase' ? 'chase' : 'random',
    chasePattern: colorChasePatterns.includes(raw.chasePattern as ColorChasePattern)
      ? (raw.chasePattern as ColorChasePattern)
      : defaults.chasePattern,
    chaseOrdering: normalizeChaseOrdering(raw.chaseOrdering, defaults.chaseOrdering),
    chaseGroups: Math.max(1, Math.round(num(raw.chaseGroups, defaults.chaseGroups))),
    chaseBlockSize: Math.max(
      1,
      Math.round(num(raw.chaseBlockSize, defaults.chaseBlockSize))
    ),
    chaseTail: Math.max(1, Math.round(num(raw.chaseTail, defaults.chaseTail))),
    chaseReverse: raw.chaseReverse === true,
    chaseMirror: raw.chaseMirror === true,
  }
}

export function randomizerChaseShape(options: RandomizerOptions): ChaseShape {
  // Falls back field by field: a randomizer saved before chase mode existed has none of
  // these, and an unknown pattern matches no bucket at all, which would silently fire
  // nothing rather than chasing.
  const defaults = initRandomizerOptions()
  const pattern = colorChasePatterns.includes(options.chasePattern)
    ? options.chasePattern
    : defaults.chasePattern
  const raw = pattern === 'runner' ? options.chaseTail : options.chaseBlockSize
  return {
    pattern,
    blockSize: Number.isFinite(raw) ? Math.max(1, Math.floor(raw)) : 1,
    reverse: options.chaseReverse === true,
    mirror: options.chaseMirror === true,
  }
}

/**
 * Groups actually used by a pattern.
 *
 * Rotate and blocks divide the rig into groups and fire one, so a single group means
 * every light is in the firing group and the whole rig flashes together — not a chase
 * at all. Runner ignores the count entirely: its window is the firing group.
 */
export function randomizerChaseBuckets(options: RandomizerOptions): number {
  const groups = Number.isFinite(options.chaseGroups)
    ? Math.floor(options.chaseGroups)
    : 2
  if (options.chasePattern === 'runner') {
    return Math.max(1, groups)
  }
  return Math.max(2, groups)
}

function initPoint(): Point {
  return {
    level: 0,
    rising: false,
  }
}

export function initRandomizerState(): RandomizerState {
  return []
}

export function applyRandomization(
  value: number,
  randomizerLevel: number,
  randomizationAmount: number
) {
  return lerp(value, value * randomizerLevel, randomizationAmount)
}

// returns a new randomizerState with the desired size. Growing or shrinking as necessary
export function resizeRandomizer(state: RandomizerState, size: number) {
  const syncedState: Point[] = []
  Array(size)
    .fill(0)
    .forEach((_, i) => {
      let oldState = state[i]
      syncedState[i] = oldState ?? initPoint()
    })
  return syncedState
}

// returns the desired amount of random indexes
// Each chosen index in unique, which is why this function is so specialized
function pickRandomIndexes(randCount: number, size: number) {
  const randomIndexes: number[] = []
  const availableIndexes = Array.from(Array(size).keys())
  for (let i = 0; i < randCount; i++) {
    const index = Math.floor(Math.random() * availableIndexes.length)
    const randomIndex = availableIndexes[index]
    availableIndexes.splice(index, 1)
    randomIndexes.push(randomIndex)
  }
  return randomIndexes
}

/**
 * Chase levels: the pattern says which lights the chase has *just reached*, and each
 * one then runs the same one-shot envelope the random mode fires.
 *
 * The envelope is what `envelopeDuration` measures, so a light is lit for that long
 * whatever the step rate: an on time shorter than the step gives a pulse with a gap
 * behind it, and one longer than the step keeps the light up while the chase moves on,
 * which is the overlap a tail is made of.
 *
 * Deliberately armed on arrival rather than re-armed every step the pattern covers the
 * light: re-arming turns a wide runner tail into a strobe. The exception is a light the
 * pattern never leaves — a tail as wide as the rig, or a single-light split — which
 * sees no arrival at all and would sit dark forever, so a finished envelope re-arms on
 * the next step.
 */
function updateChaseLevels(
  state: RandomizerState,
  beatsLast: number,
  ts: TimeState,
  indexes: number[],
  options: RandomizerOptions,
  ranks: number[] | undefined,
  beatDelta: number,
  riseBeats: number,
  fallBeats: number
): RandomizerState {
  const period = Math.max(options.triggerPeriod, 0.0001)
  const step = Math.floor(ts.beats / period)
  const shape = randomizerChaseShape(options)
  const buckets = randomizerChaseBuckets(options)

  const isOnByIndex = new Map<number, boolean>()
  const arrivedByIndex = new Map<number, boolean>()
  for (let i = 0; i < indexes.length; i++) {
    const rank = ranks?.[i] ?? i
    const isOn = chaseBucketIndex(rank, indexes.length, step, buckets, shape) === 0
    const wasOn =
      chaseBucketIndex(rank, indexes.length, step - 1, buckets, shape) === 0
    isOnByIndex.set(indexes[i], isOn)
    arrivedByIndex.set(indexes[i], isOn && !wasOn)
  }

  const riseStep = beatDelta / Math.max(riseBeats, 0.0001)
  const fallStep = beatDelta / Math.max(fallBeats, 0.0001)

  const nextState = state.map<Point>(({ level, rising }, index) => {
    if (!isOnByIndex.has(index)) {
      return { level, rising }
    }
    if (rising) {
      const newLevel = level + riseStep
      return newLevel > 1
        ? { level: 1, rising: false }
        : { level: newLevel, rising: true }
    }
    const newLevel = level - fallStep
    return { level: newLevel < 0 ? 0 : newLevel, rising: false }
  })

  if (isNewPeriod(beatsLast, ts.beats, period)) {
    isOnByIndex.forEach((isOn, index) => {
      const point = nextState[index]
      if (!isOn || point === undefined) return
      const spent = point.level <= 0 && !point.rising
      if (arrivedByIndex.get(index) || spent) {
        point.rising = true
      }
    })
  }

  return nextState
}

export function updateIndexes(
  beatsLast: number,
  state: RandomizerState,
  ts: TimeState,
  indexes: number[],
  options: RandomizerOptions,
  /**
   * `ranks[i]` is the chase position of `indexes[i]`, from the fixtures' stage
   * positions. Only needed in chase mode; without it a chase falls back to slot order,
   * which is the patch order the slots were built in.
   */
  ranks?: number[]
) {
  const {
    triggerPeriod,
    triggerDensity,
    envelopeRatio,
    envelopeDuration,
  } = options
  const riseBeats = envelopeDuration * envelopeRatio
  const fallBeats = envelopeDuration - riseBeats
  const beatDelta = ts.beats - beatsLast

  if (options.mode === 'chase') {
    return updateChaseLevels(
      state,
      beatsLast,
      ts,
      indexes,
      options,
      ranks,
      beatDelta,
      riseBeats,
      fallBeats
    )
  }

  const indexesSet = new Set(indexes)
  const nextState = state.map<Point>(({ level, rising }, index) => {
    if (indexesSet.has(index)) {
      if (rising) {
        const newLevel = level + beatDelta / riseBeats
        if (newLevel > 1) {
          return {
            level: 1,
            rising: false,
          }
        } else {
          return {
            level: newLevel,
            rising: true,
          }
        }
      } else {
        const newLevel = level - beatDelta / fallBeats
        return {
          level: newLevel < 0 ? 0 : newLevel,
          rising: false,
        }
      }
    } else {
      return {
        level,
        rising,
      }
    }
  })

  if (isNewPeriod(beatsLast, ts.beats, triggerPeriod)) {
    let randCount = Math.ceil(indexes.length * triggerDensity)
    if (randCount === 0 && indexes.length > 0) randCount = 1
    pickRandomIndexes(randCount, indexes.length).forEach((randIndex) => {
      let index = indexes[randIndex]
      nextState[index].rising = true
    })
  }

  return nextState
}
