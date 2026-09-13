import { clampNormalized, clamp, lerp } from '../math/util'
import { getParam, type Params } from './params'

/**
 * Colour chase: a split steps through a short colour sequence on the beat, handing a
 * different entry to different lights so the sequence travels across the rig instead
 * of changing every fixture in unison.
 *
 * Shape deliberately mirrors the split randomizer — persisted options on the split
 * scene, a tiny runtime block recomputed per frame in the engine, and the pattern maths
 * living here so the DMX engine, the LED output and the previews all agree.
 */

export type ColorChasePattern = 'rotate' | 'runner' | 'blocks'

/**
 * How fixtures are ranked before a pattern is applied. Position orderings use the
 * fixture-config stage window, so "next to each other" means physically adjacent
 * rather than adjacent in the patch.
 */
export type ColorChaseOrdering =
  | 'columns'
  | 'columnsSnake'
  | 'rows'
  | 'rowsSnake'
  | 'perimeter'
  | 'centerOut'
  | 'dmx'

/** Pre-2D orderings, mapped so saved chases keep the closest behaviour. */
const LEGACY_ORDERINGS: { [key: string]: ColorChaseOrdering } = {
  positionX: 'columns',
  positionY: 'rows',
}

export interface ColorChaseColor {
  hue: number
  saturation: number
}

export interface ColorChaseConfig {
  enabled: boolean
  pattern: ColorChasePattern
  ordering: ColorChaseOrdering
  colors: ColorChaseColor[]
  /** Beats per chase step. */
  period: number
  /**
   * `rotate` only: fixtures per colour run, so 1 is strict odd/even. Unused by
   * `blocks`, which always cuts the rig into one block per colour.
   */
  blockSize: number
  /**
   * `runner` only: how many fixtures the moving window lights at once.
   *
   * Kept separate from `blockSize` because the two mean different things — a tail of
   * four is a good runner, but as a rotate run it colours four fixtures the same and
   * loses the alternation — and sharing one field carried the value across when you
   * switched pattern.
   */
  tail: number
  /** Travel the pattern backwards along the ordering. */
  reverse: boolean
  /**
   * Fold the pattern about the middle of the chase order, so it runs outward in both
   * directions at once: a runner becomes two runners leaving the centre, a rotate
   * becomes symmetric bands. Combine with `reverse` to travel inward instead.
   */
  mirror: boolean
  /** Fraction of a step spent crossfading in from the previous step. 0 = hard cut. */
  fade: number
  /**
   * Hold the pattern still instead of stepping it on the beat. The spatial assignment
   * still applies, so this is how you get a fixed odd/even (or block) colour layout
   * across the rig rather than a moving chase.
   */
  static: boolean
  /**
   * Opt in to reading swatches as offsets from the first one, applied on top of the
   * split's own hue/saturation, so the HSV pad and any hue modulation move the whole
   * palette together.
   *
   * Off by default: a chase normally *replaces* the split colour, which is what makes
   * the swatch you picked the colour that actually comes out.
   */
  followSplitHue: boolean
}

/**
 * Independent defaults for new swatches.
 *
 * Deliberately a fixed list rather than a step away from the previous swatch: deriving
 * each new colour from the last one means the palette you end up with depends on the
 * order you edited it in, which is not something you can predict or undo.
 *
 * White is in the list because chasing a colour against white is one of the most
 * useful two-colour combinations, and on a colour wheel saturation 0 is what selects
 * the wheel's white slot.
 */
export const COLOR_CHASE_PALETTE: Array<ColorChaseColor & { label: string }> = [
  { label: 'Red', hue: 0.0, saturation: 1.0 },
  { label: 'Blue', hue: 0.6, saturation: 1.0 },
  { label: 'Green', hue: 0.33, saturation: 1.0 },
  { label: 'Amber', hue: 0.09, saturation: 1.0 },
  { label: 'White', hue: 0.0, saturation: 0.0 },
  { label: 'Magenta', hue: 0.85, saturation: 1.0 },
  { label: 'Cyan', hue: 0.5, saturation: 1.0 },
  { label: 'Yellow', hue: 0.16, saturation: 1.0 },
]

/** Palette entry for a swatch position, wrapping once the palette runs out. */
export function chasePaletteEntry(index: number): ColorChaseColor {
  const safeIndex = Number.isFinite(index) ? Math.floor(index) : 0
  const entry = COLOR_CHASE_PALETTE[mod(safeIndex, COLOR_CHASE_PALETTE.length)]
  return { hue: entry.hue, saturation: entry.saturation }
}

/** Saturation at or below this reads as white, matching the colour-wheel matcher. */
export const COLOR_CHASE_WHITE_SATURATION_THRESHOLD = 0.02

export function colorChaseEntryIsWhite(entry: ColorChaseColor): boolean {
  return entry.saturation <= COLOR_CHASE_WHITE_SATURATION_THRESHOLD
}

export const COLOR_CHASE_MIN_PERIOD = 0.125
export const COLOR_CHASE_MAX_PERIOD = 16
export const COLOR_CHASE_MAX_COLORS = 8
export const COLOR_CHASE_MAX_BLOCK_SIZE = 16

export function initColorChase(): ColorChaseConfig {
  return {
    enabled: false,
    pattern: 'rotate',
    ordering: 'columns',
    colors: [chasePaletteEntry(0), chasePaletteEntry(1)],
    period: 1,
    blockSize: 1,
    tail: 1,
    reverse: false,
    mirror: false,
    fade: 0,
    static: false,
    followSplitHue: false,
  }
}

export function cloneColorChase(config: ColorChaseConfig): ColorChaseConfig {
  return {
    ...config,
    colors: config.colors.map((color) => ({ ...color })),
  }
}

/**
 * Coerces a persisted chase block into something the engine can safely run.
 *
 * Project files are editable on disk and travel between versions, so a chase can
 * arrive with a pattern this build does not know or a `colors` value that is not an
 * array at all. The engine indexes into `colors` every frame, so anything malformed
 * has to be repaired here rather than thrown — losing a chase is recoverable, a dark
 * rig mid-show is not.
 */
export function normalizeColorChase(value: unknown): ColorChaseConfig | undefined {
  if (value === null || typeof value !== 'object') {
    return undefined
  }
  const raw = value as Partial<ColorChaseConfig>
  const defaults = initColorChase()

  const colors = Array.isArray(raw.colors)
    ? raw.colors
        .filter(
          (color): color is ColorChaseColor =>
            color !== null && typeof color === 'object'
        )
        .slice(0, COLOR_CHASE_MAX_COLORS)
        .map((color) => ({
          hue: Number.isFinite(color.hue) ? clampNormalized(color.hue) : 0,
          saturation: Number.isFinite(color.saturation)
            ? clampNormalized(color.saturation)
            : 1,
        }))
    : []

  return {
    enabled: raw.enabled === true,
    pattern: colorChasePatterns.includes(raw.pattern as ColorChasePattern)
      ? (raw.pattern as ColorChasePattern)
      : defaults.pattern,
    ordering: normalizeChaseOrdering(raw.ordering, defaults.ordering),
    colors: colors.length > 0 ? colors : defaults.colors,
    period: Number.isFinite(raw.period)
      ? clamp(raw.period as number, COLOR_CHASE_MIN_PERIOD, COLOR_CHASE_MAX_PERIOD)
      : defaults.period,
    blockSize: Number.isFinite(raw.blockSize)
      ? Math.round(clamp(raw.blockSize as number, 1, COLOR_CHASE_MAX_BLOCK_SIZE))
      : defaults.blockSize,
    tail: Number.isFinite(raw.tail)
      ? Math.round(clamp(raw.tail as number, 1, COLOR_CHASE_MAX_BLOCK_SIZE))
      : defaults.tail,
    reverse: raw.reverse === true,
    mirror: raw.mirror === true,
    fade: Number.isFinite(raw.fade) ? clampNormalized(raw.fade as number) : defaults.fade,
    static: raw.static === true,
    followSplitHue: raw.followSplitHue === true,
  }
}

export const colorChasePatterns: ColorChasePattern[] = ['rotate', 'runner', 'blocks']

export const colorChaseOrderings: ColorChaseOrdering[] = [
  'columns',
  'columnsSnake',
  'rows',
  'rowsSnake',
  'perimeter',
  'centerOut',
  'dmx',
]

const patternDisplayNames: { [key in ColorChasePattern]: string } = {
  rotate: 'Rotate',
  runner: 'Runner',
  blocks: 'Blocks',
}

const orderingDisplayNames: { [key in ColorChaseOrdering]: string } = {
  columns: 'Cols',
  columnsSnake: 'Cols \u2193\u2191',
  rows: 'Rows',
  rowsSnake: 'Rows \u2192\u2190',
  perimeter: 'Loop',
  centerOut: 'Centre',
  dmx: 'DMX',
}

const orderingDescriptions: { [key in ColorChaseOrdering]: string } = {
  columns:
    'Down each column, top to bottom, working left to right across the rig',
  columnsSnake:
    'Down the first column, back up the next, down the one after - a continuous snake',
  rows: 'Across each row, left to right, working down the rig',
  rowsSnake:
    'Left to right across the first row, right to left back along the next',
  perimeter:
    'Round the outside of the rig: up one side, across the top, down the other. With Mirror it starts at the top centre and runs down both sides at once.',
  centerOut: 'Outwards from the middle of the rig',
  dmx: 'Patch order, ignoring where fixtures are rigged',
}

/** Valid ordering, mapping the pre-2D names, else the supplied fallback. */
export function normalizeChaseOrdering(
  value: unknown,
  fallback: ColorChaseOrdering
): ColorChaseOrdering {
  if (colorChaseOrderings.includes(value as ColorChaseOrdering)) {
    return value as ColorChaseOrdering
  }
  return LEGACY_ORDERINGS[value as string] ?? fallback
}

export function colorChaseOrderingDescription(
  ordering: ColorChaseOrdering
): string {
  return orderingDescriptions[ordering] ?? ''
}

export function colorChasePatternName(pattern: ColorChasePattern): string {
  return patternDisplayNames[pattern] ?? pattern
}

export function colorChaseOrderingName(ordering: ColorChaseOrdering): string {
  return orderingDisplayNames[ordering] ?? ordering
}

/** Label for the span control, or null when the pattern has no use for one. */
export function colorChaseBlockSizeLabel(
  pattern: ColorChasePattern
): string | null {
  if (pattern === 'rotate') return 'Run'
  if (pattern === 'runner') return 'Tail'
  return null
}

export interface ColorChaseRuntime {
  /** Monotonic step counter, derived from the beat clock rather than accumulated. */
  step: number
  /** 0–1 position within the current step. */
  stepProgress: number
}

export function initColorChaseRuntime(): ColorChaseRuntime {
  return { step: 0, stepProgress: 0 }
}

/**
 * Step derived straight from the beat clock, not incremented on a period edge.
 *
 * The randomizer accumulates, which is fine for it — a randomly retriggered envelope
 * has no absolute position to lose. A chase does: accumulating means a dropped frame
 * or a scene change permanently shifts which fixture is on which colour relative to
 * the bar. Deriving keeps the chase phase-locked to Link.
 */
export function computeColorChaseRuntime(
  beats: number,
  period: number,
  isStatic: boolean = false
): ColorChaseRuntime {
  // A static chase is just step 0 held forever: the pattern's spatial assignment
  // still applies, nothing advances, and every consumer reads it the same way.
  if (isStatic) {
    return { step: 0, stepProgress: 0 }
  }
  const safePeriod = Number.isFinite(period)
    ? clamp(period, COLOR_CHASE_MIN_PERIOD, COLOR_CHASE_MAX_PERIOD)
    : 1
  const safeBeats = Number.isFinite(beats) ? beats : 0
  const position = safeBeats / safePeriod
  const step = Math.floor(position)
  return {
    step,
    stepProgress: clampNormalized(position - step),
  }
}

export function colorChaseRuntimeEqual(
  a: ColorChaseRuntime,
  b: ColorChaseRuntime
): boolean {
  return a.step === b.step && a.stepProgress === b.stepProgress
}

function mod(value: number, modulus: number): number {
  if (modulus <= 0) return 0
  return ((value % modulus) + modulus) % modulus
}

/** Widest span across a set of values, used to spot an unpositioned rig. */
function spread(values: number[]): number {
  if (values.length === 0) return 0
  let min = values[0]
  let max = values[0]
  for (const value of values) {
    if (value < min) min = value
    if (value > max) max = value
  }
  return max - min
}

/**
 * Below this the rig has no meaningful spread on the chosen axis — every fixture
 * still sits at the default window position. Ranking by it would produce an
 * arbitrary order, so position orderings fall back to patch order instead.
 */
const POSITION_SPREAD_EPSILON = 0.001

export interface ColorChasePosition {
  x: number
  y: number
}

/**
 * Fixtures sharing a column (or row) are never at exactly the same coordinate, so an
 * axis is clustered rather than compared for equality. Single-linkage: a run of small
 * gaps stays one column, and a gap wider than the tolerance starts the next.
 */
function clusterIndexes(values: number[], tolerance: number): number[] {
  const order = values.map((_, index) => index)
  order.sort((a, b) => (values[a] === values[b] ? a - b : values[a] - values[b]))

  const clusters = new Array<number>(values.length)
  let cluster = 0
  let previous = values[order[0]]
  clusters[order[0]] = 0

  for (let i = 1; i < order.length; i++) {
    const index = order[i]
    if (values[index] - previous > tolerance) {
      cluster += 1
    }
    clusters[index] = cluster
    previous = values[index]
  }

  return clusters
}

/** Smallest gap that still separates two columns, however tightly packed the rig is. */
const AXIS_CLUSTER_TOLERANCE_FLOOR = 0.02

function axisClusterTolerance(values: number[]): number {
  return Math.max(AXIS_CLUSTER_TOLERANCE_FLOOR, spread(values) * 0.08)
}

/**
 * Walks the rig as a loop, by angle about its centroid.
 *
 * The walk deliberately *starts at the bottom* and goes round through the top: up one
 * side, across the top, down the other. That puts the top centre at the middle of the
 * order and the two lowest fixtures at its ends, which is what makes `mirror` do
 * something useful here — folding about the middle starts the pattern at the top centre
 * and runs it down both sides at once, finishing at the bottom.
 *
 * Angle rather than clustering because a perimeter has no rows or columns to find, and
 * a rig shaped like a top row with legs down each side still walks in one continuous
 * path with no jumps.
 */
function perimeterRanks(xs: number[], ys: number[]): number[] {
  const count = xs.length
  const centreX = xs.reduce((sum, x) => sum + x, 0) / count
  const centreY = ys.reduce((sum, y) => sum + y, 0) / count

  const TWO_PI = Math.PI * 2
  // atan2(dx, -dy) reads 0 straight down, a quarter turn to the right, half at the
  // top. `y` is 1 at the top of the stage, hence the negation.
  const angles = xs.map((x, i) =>
    mod(Math.atan2(x - centreX, -(ys[i] - centreY)), TWO_PI)
  )

  const order = xs.map((_, index) => index)
  order.sort((a, b) => (angles[a] === angles[b] ? a - b : angles[a] - angles[b]))

  const ranks = new Array<number>(count)
  order.forEach((slotIndex, rank) => {
    ranks[slotIndex] = rank
  })
  return ranks
}

/**
 * `ranks[slotIndex] = rank`, where slots arrive in patch order and rank is the
 * fixture's place along the chosen ordering.
 *
 * Position orderings are genuinely two-dimensional: one axis is clustered into columns
 * (or rows) and the other orders the fixtures *within* each one. Sorting on a single
 * axis and leaving the rest to patch order — which is what this did first — puts the
 * fixtures of a column in whatever order they happen to be patched, so a chase down a
 * column jumps about.
 *
 * Ties keep patch order, so a rig with two fixtures at the same point stays stable
 * rather than shuffling frame to frame.
 */
export function colorChaseRanks(
  positions: ReadonlyArray<ColorChasePosition>,
  ordering: ColorChaseOrdering
): number[] {
  const count = positions.length
  const identity = () => positions.map((_, index) => index)
  if (count <= 1 || ordering === 'dmx') {
    return identity()
  }

  const xs = positions.map((position) =>
    Number.isFinite(position.x) ? position.x : 0.5
  )
  const ys = positions.map((position) =>
    Number.isFinite(position.y) ? position.y : 0.5
  )

  // Nothing to order by: every fixture still sits at the default window position, so
  // ranking on it would be arbitrary. Patch order is at least predictable.
  if (
    spread(xs) < POSITION_SPREAD_EPSILON &&
    spread(ys) < POSITION_SPREAD_EPSILON
  ) {
    return identity()
  }

  if (ordering === 'perimeter') {
    return perimeterRanks(xs, ys)
  }

  const byColumn = ordering === 'columns' || ordering === 'columnsSnake'
  const snake = ordering === 'columnsSnake' || ordering === 'rowsSnake'

  // `y` is 1 at the top of the stage and 0 at the floor, so "down" is descending y.
  // Negating lets everything below sort ascending.
  //
  // Centre-out clusters on distance from the middle instead of raw x, so the two
  // columns either side of centre form one ring and are walked together. Ranking on
  // that distance alone leaves each ring in patch order — the same flat-sort problem
  // columns and rows had.
  let primary: number[]
  let secondary: number[]
  if (ordering === 'centerOut') {
    const centre = xs.reduce((sum, x) => sum + x, 0) / count
    primary = xs.map((x) => Math.abs(x - centre))
    secondary = ys.map((y) => -y)
  } else {
    primary = byColumn ? xs : ys.map((y) => -y)
    secondary = byColumn ? ys.map((y) => -y) : xs
  }

  const clusters = clusterIndexes(primary, axisClusterTolerance(primary))

  const order = positions.map((_, index) => index)
  order.sort((a, b) => {
    if (clusters[a] !== clusters[b]) {
      return clusters[a] - clusters[b]
    }
    // Snake reverses every other column so the chase carries on from where the
    // previous one ended instead of jumping back to the top.
    const descending = snake && clusters[a] % 2 === 1
    const delta = secondary[a] - secondary[b]
    if (delta !== 0) {
      return descending ? -delta : delta
    }
    return a - b
  })

  const ranks = new Array<number>(count)
  order.forEach((slotIndex, rank) => {
    ranks[slotIndex] = rank
  })
  return ranks
}

/**
 * Folds the chase order in half about its middle, so the two fixtures either side of
 * centre share a rank, then the next two out, and so on.
 *
 * Everything downstream then runs on half as many ranks, which is what turns one
 * travelling pattern into two symmetric ones. A runner lights the pair at the centre,
 * then the pair outside it — two runners leaving the middle in opposite directions.
 *
 * An odd fixture count leaves the middle fixture alone at rank 0, with no partner.
 */
export function foldRankAboutCentre(
  rank: number,
  count: number
): { rank: number; count: number } {
  const foldedCount = Math.ceil(count / 2)
  const folded =
    rank < count / 2
      ? Math.floor((count - 1) / 2) - rank
      : rank - Math.ceil((count - 1) / 2)
  return { rank: folded, count: foldedCount }
}

/** Pattern shape, with no notion of what the buckets are used for. */
export interface ChaseShape {
  pattern: ColorChasePattern
  blockSize: number
  reverse: boolean
  mirror: boolean
}

/**
 * Which bucket the fixture at `rank` falls into this step, or -1 for "leave alone".
 *
 * Deliberately knows nothing about colour: buckets are just numbered groups. The colour
 * chase maps them to swatches, the randomizer's chase mode maps bucket 0 to "trigger
 * this light", and both get the same patterns, mirroring and ordering for free.
 */
export function chaseBucketIndex(
  rank: number,
  count: number,
  step: number,
  bucketCount: number,
  shape: ChaseShape
): number {
  if (bucketCount <= 0 || count <= 0 || rank < 0 || rank >= count) {
    return -1
  }

  // Folded here rather than in the ordering so mirroring composes with every pattern
  // and every ordering, instead of needing a mirrored variant of each.
  if (shape.mirror) {
    const folded = foldRankAboutCentre(rank, count)
    rank = folded.rank
    count = folded.count
  }

  const direction = shape.reverse ? -1 : 1
  const blockSize = Math.max(1, Math.floor(shape.blockSize))

  switch (shape.pattern) {
    case 'rotate':
      return mod(Math.floor(rank / blockSize) + direction * step, bucketCount)

    case 'runner': {
      // A window of `blockSize` fixtures travels the ordering in bucket 0; everything
      // else falls in bucket 1. With a single bucket the rest is left alone, so the
      // runner reads against whatever is already happening.
      const head = mod(direction * step, count)
      const tail = Math.min(blockSize, count)
      const offset = mod(rank - head, count)
      if (offset < tail) return 0
      return bucketCount > 1 ? 1 : -1
    }

    case 'blocks': {
      // Contiguous spatial blocks, one per bucket, rotating together.
      const blockIndex = Math.min(
        bucketCount - 1,
        Math.floor((rank * bucketCount) / count)
      )
      return mod(blockIndex + direction * step, bucketCount)
    }

    default:
      return -1
  }
}

/**
 * Index into the colour sequence for the fixture at `rank`, or -1 to leave the
 * fixture on the split's own colour.
 */
export function colorChaseColorIndex(
  rank: number,
  count: number,
  step: number,
  config: ColorChaseConfig
): number {
  return chaseBucketIndex(rank, count, step, config.colors.length, {
    ...config,
    blockSize: config.pattern === 'runner' ? config.tail : config.blockSize,
  })
}

/** Shortest way round the wheel, so red to magenta never sweeps through green. */
export function lerpHue(from: number, to: number, amount: number): number {
  let delta = to - from
  if (delta > 0.5) delta -= 1
  else if (delta < -0.5) delta += 1
  return mod(from + delta * amount, 1)
}

/**
 * The colour the fixture at `rank` should show right now, or null when the chase
 * leaves it on the split's own colour.
 */
export function resolveColorChaseEntry(
  rank: number,
  count: number,
  runtime: ColorChaseRuntime,
  config: ColorChaseConfig
): ColorChaseColor | null {
  const current = colorChaseColorIndex(rank, count, runtime.step, config)
  const fade = clampNormalized(config.fade)

  if (fade <= 0.0005 || runtime.stepProgress >= fade) {
    return current < 0 ? null : config.colors[current] ?? null
  }

  const previous = colorChaseColorIndex(rank, count, runtime.step - 1, config)
  if (previous === current) {
    return current < 0 ? null : config.colors[current] ?? null
  }

  const from = previous < 0 ? null : config.colors[previous] ?? null
  const to = current < 0 ? null : config.colors[current] ?? null
  // A crossfade needs two colours to sit between. When one side is "leave the split
  // alone" there is nothing to interpolate towards, so the step just cuts.
  if (from === null || to === null) {
    return to
  }

  const blend = clampNormalized(runtime.stepProgress / fade)
  return {
    hue: lerpHue(from.hue, to.hue, blend),
    saturation: lerp(from.saturation, to.saturation, blend),
  }
}

/**
 * Chase entry resolved into the colour a fixture should actually show.
 *
 * By default the swatch *is* the output: the split's own hue and saturation are
 * replaced outright, so what you picked is what comes out. `followSplitHue` opts into
 * the other reading, where swatches are offsets from the first one and the HSV pad
 * still moves the whole palette.
 */
export function colorChaseHsv(
  entry: ColorChaseColor | null,
  config: ColorChaseConfig,
  baseHue: number,
  baseSaturation: number
): ColorChaseColor {
  if (entry === null) {
    return { hue: baseHue, saturation: baseSaturation }
  }

  if (!config.followSplitHue) {
    return {
      hue: clampNormalized(entry.hue),
      saturation: clampNormalized(entry.saturation),
    }
  }

  const anchor = config.colors[0]
  if (anchor === undefined) {
    return { hue: baseHue, saturation: baseSaturation }
  }

  return {
    hue: mod(baseHue + (entry.hue - anchor.hue), 1),
    saturation: clampNormalized(
      baseSaturation + (entry.saturation - anchor.saturation)
    ),
  }
}

/**
 * Chase colour folded into a split's params.
 *
 * Brightness is deliberately untouched: intensity stays with the split's own
 * brightness param, its modulators and the randomizer, so a chase changes colour and
 * nothing else.
 */
export function applyColorChaseToParams(
  params: Params,
  entry: ColorChaseColor | null,
  config: ColorChaseConfig
): Params {
  if (entry === null) {
    return params
  }

  const resolved = colorChaseHsv(
    entry,
    config,
    getParam(params, 'hue'),
    getParam(params, 'saturation')
  )

  return {
    ...params,
    hue: resolved.hue,
    saturation: resolved.saturation,
    // A colour-wheel channel reads `colorWheel` and returns that slot before it ever
    // looks at hue, so leaving the split's wheel selection in place made the chase
    // silently inert on exactly the fixtures it was most wanted for. Clearing it drops
    // the channel through to hue/saturation matching, which picks the nearest slot —
    // and picks the wheel's white slot when a swatch is desaturated.
    colorWheel: undefined,
    // Dedicated white/amber/UV emitters are the same story. When the split has those
    // aux sliders, `dedicatedColorParam` returns the slider value and the channel never
    // looks at hue — so a white swatch could not light the white LED, however
    // desaturated it was. Cleared, each emitter derives from the chase's own
    // hue/saturation: a desaturated swatch opens the white channel fully, a saturated
    // one closes it, and an amber swatch reaches an amber emitter.
    white: undefined,
    warmWhite: undefined,
    amber: undefined,
    uv: undefined,
  }
}

/** True when the chase is configured to actually do something. */
export function colorChaseIsActive(
  config: ColorChaseConfig | undefined
): config is ColorChaseConfig {
  return (
    config !== undefined && config.enabled === true && config.colors.length > 0
  )
}
