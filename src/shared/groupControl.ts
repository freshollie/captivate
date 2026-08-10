import type { FixtureChannel, FlattenedFixture } from './dmxFixtures'
import { DMX_MAX_VALUE, DMX_MIN_VALUE } from './dmxFixtures'
import { getFixturesInGroups, listColorMapSlots } from './dmxUtil'
import { inferColorKind } from './dmxColors'

/**
 * Per-group live controls, applied to the finished scene output on the way to the
 * wire. Grouping here is independent of scenes and splits.
 *
 * The two faders deliberately differ:
 *
 * - **Brightness is proportional, and only touches the master/dimmer channel.** The
 *   scene sets the ceiling and the fader works down from it, so a scene at 50% caps
 *   the group at 50% and a scene at 0 stays dark. Fixtures with no dimmer do not
 *   respond to it. It needs no arming or releasing: 1.0 *is* the released state,
 *   so it is always live and a full fader changes nothing.
 * - **Strobe is a true override.** It writes a raw DMX value the scene engine has no
 *   way to express — `ChannelStrobe` only holds a solid and a strobe constant — so
 *   there is no scene value to scale against. Because 0 is a meaningful strobe value
 *   rather than "off", it needs an explicit armed flag and an explicit release.
 */
export interface GroupControl {
  /** 0..1, multiplied into the scene's level. 1 = no change. Always applied. */
  brightness: number
  /** Armed by touching the fader, cleared by Release or a light-scene change. */
  strobeEnabled: boolean
  /** Raw DMX 0..255 written to the group's strobe channels. */
  strobe: number
  /**
   * Level the Flash button fires at, remembered from the last value dialled on the
   * fader. Survives Release and scene changes — those clear the *live* strobe, but
   * the flash needs something to fire or the button would be inert.
   */
  strobeFlashLevel: number
  /**
   * True only while the Flash button holds the strobe, as opposed to the fader
   * having armed it. Both light the same channels; only the flash forces brightness
   * to full, so they have to be told apart.
   */
  strobeFlashActive: boolean
  /**
   * Solo. While any group is exclusive, fixtures outside every exclusive group are
   * held dark. Momentary by design — this is a "hit it for the drop" control.
   */
  exclusiveEnabled: boolean
  /**
   * Blinder. While held, the group is driven to pulsing white regardless of the
   * scene — including fixtures the scene never addresses. Momentary; nothing about
   * the programming changes, so letting go restores it exactly.
   */
  blinderActive: boolean
}

/** Fresh groups flash at full rather than at nothing. */
export const DEFAULT_STROBE_FLASH_LEVEL = 255

export interface GroupControlState {
  byGroup: { [group: string]: GroupControl | undefined }
  /** How long a blinder takes to fade out after release, in beats. Global. */
  blinderFadeBeats: number
}

/** Matches the saturation threshold the scene renderer uses to pick a white slot. */
const COLOR_WHEEL_WHITE_MAX_SATURATION = 0.02

export const DEFAULT_BLINDER_FADE_BEATS = 1
export const MIN_BLINDER_FADE_BEATS = 0
export const MAX_BLINDER_FADE_BEATS = 16

export function clampBlinderFadeBeats(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_BLINDER_FADE_BEATS
  return Math.min(MAX_BLINDER_FADE_BEATS, Math.max(MIN_BLINDER_FADE_BEATS, value))
}

/**
 * Fade state for blinders that have been let go.
 *
 * The fade outlives the button press, so it cannot be derived from the current beat
 * alone — the moment of release has to be remembered. Held by the caller rather than
 * in module scope so it stays testable and so the per-universe DMX loop cannot
 * advance it more than once per frame.
 *
 * Timed on the wall clock, not the beat clock. The beat clock freezes when the
 * transport stops, which would strand a released blinder at whatever level it had
 * reached — on forever, overriding the group's own faders. The configured length is
 * still musical: it is converted to milliseconds at the tempo in force when the
 * button is released.
 */
export interface BlinderRuntime {
  /** Wall-clock ms at which each releasing group started fading. */
  fadeStartMs: { [group: string]: number }
  /** How long each in-progress fade runs for, in ms. */
  fadeDurationMs: { [group: string]: number }
  /** Groups whose button was down on the previous frame. */
  heldLastFrame: { [group: string]: boolean }
}

export function initBlinderRuntime(): BlinderRuntime {
  return { fadeStartMs: {}, fadeDurationMs: {}, heldLastFrame: {} }
}

const FALLBACK_BPM = 120

function beatsToMs(beats: number, bpm: number): number {
  const tempo = Number.isFinite(bpm) && bpm > 0 ? bpm : FALLBACK_BPM
  return (beats * 60000) / tempo
}

/** Blinder level per group this frame: 1 while held, ramping to 0 after release. */
export function advanceBlinderLevels(
  runtime: BlinderRuntime,
  groupControl: GroupControlState | null | undefined,
  /** Monotonic wall clock in ms. */
  nowMs: number,
  /** Tempo used to turn the configured beat count into a duration. */
  bpm: number
): { [group: string]: number } {
  const byGroup = safeByGroup(groupControl)
  const fadeBeats = clampBlinderFadeBeats(
    groupControl?.blinderFadeBeats ?? DEFAULT_BLINDER_FADE_BEATS
  )
  const levels: { [group: string]: number } = {}

  const groups = new Set([
    ...Object.keys(byGroup),
    ...Object.keys(runtime.fadeStartMs),
    ...Object.keys(runtime.heldLastFrame),
  ])

  for (const group of groups) {
    const held = byGroup[group]?.blinderActive === true

    if (held) {
      runtime.heldLastFrame[group] = true
      delete runtime.fadeStartMs[group]
      delete runtime.fadeDurationMs[group]
      levels[group] = 1
      continue
    }

    if (runtime.heldLastFrame[group] === true) {
      delete runtime.heldLastFrame[group]
      const durationMs = beatsToMs(fadeBeats, bpm)
      if (fadeBeats <= 0 || !Number.isFinite(durationMs) || durationMs <= 0) {
        continue
      }
      runtime.fadeStartMs[group] = nowMs
      runtime.fadeDurationMs[group] = durationMs
    }

    const startedAt = runtime.fadeStartMs[group]
    const durationMs = runtime.fadeDurationMs[group]
    if (startedAt === undefined || durationMs === undefined) continue

    const elapsed = nowMs - startedAt
    // Negative elapsed means the clock moved under us; drop the fade rather than
    // leaving a blinder stuck on.
    if (!Number.isFinite(elapsed) || elapsed < 0 || elapsed >= durationMs) {
      delete runtime.fadeStartMs[group]
      delete runtime.fadeDurationMs[group]
      continue
    }

    levels[group] = 1 - elapsed / durationMs
  }

  return levels
}

export function initGroupControl(): GroupControl {
  return {
    brightness: 1,
    strobeEnabled: false,
    strobe: 0,
    strobeFlashLevel: DEFAULT_STROBE_FLASH_LEVEL,
    strobeFlashActive: false,
    exclusiveEnabled: false,
    blinderActive: false,
  }
}

/**
 * Whether a momentary control is holding this group at full brightness.
 *
 * Flash and Exclusive are both "hit it for the drop" gestures — pulling the group up
 * to whatever the scene is giving rather than leaving it trimmed down by its own
 * fader. The fader keeps its position throughout and takes over again on release.
 */
export function isGroupBrightnessForcedFull(
  control: GroupControl | null | undefined
): boolean {
  if (control === null || control === undefined) return false
  return control.strobeFlashActive === true || control.exclusiveEnabled === true
}

/** Brightness multiplier actually applied, momentary overrides included. */
export function effectiveGroupBrightness(
  control: GroupControl | null | undefined
): number {
  if (isGroupBrightnessForcedFull(control)) return 1
  const brightness = control?.brightness
  if (!Number.isFinite(brightness)) return 1
  return Math.min(1, Math.max(0, brightness as number))
}

/** Brightness at full is the released state — nothing to undo. */
export function isGroupBrightnessActive(
  control: GroupControl | null | undefined
): boolean {
  const brightness = control?.brightness
  return Number.isFinite(brightness) && (brightness as number) < 1
}

export function initGroupControlState(): GroupControlState {
  return { byGroup: {}, blinderFadeBeats: DEFAULT_BLINDER_FADE_BEATS }
}

export function isGroupControlActive(
  control: GroupControl | null | undefined
): boolean {
  if (control === null || control === undefined) return false
  return (
    isGroupBrightnessActive(control) ||
    control.strobeEnabled === true ||
    control.exclusiveEnabled === true ||
    control.blinderActive === true
  )
}

/** Group names currently blinding, in stable order. */
export function blindingGroupNames(
  state: GroupControlState | null | undefined
): string[] {
  const byGroup = safeByGroup(state)
  return Object.keys(byGroup)
    .filter((group) => byGroup[group]?.blinderActive === true)
    .sort()
}

/** Group names currently soloing, in stable order. */
export function exclusiveGroupNames(
  state: GroupControlState | null | undefined
): string[] {
  const byGroup = safeByGroup(state)
  return Object.keys(byGroup)
    .filter((group) => byGroup[group]?.exclusiveEnabled === true)
    .sort()
}

/**
 * The group map, whatever shape the caller actually has.
 *
 * This runs inside the per-frame DMX calculation, where a thrown error takes out
 * every universe rather than just this feature. State reaching it can be a project
 * file written by an older build, a peer's state over IPC, or a hand-edited save —
 * so nothing here may assume a shape.
 */
function safeByGroup(
  state: GroupControlState | null | undefined
): { [group: string]: GroupControl | undefined } {
  const byGroup = state?.byGroup
  if (byGroup === null || byGroup === undefined || typeof byGroup !== 'object') {
    return {}
  }
  return byGroup
}

/** Group names with at least one armed fader, in stable order. */
export function activeGroupControlNames(
  state: GroupControlState | null | undefined
): string[] {
  const byGroup = safeByGroup(state)
  return Object.keys(byGroup)
    .filter((group) => isGroupControlActive(byGroup[group]))
    .sort()
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(1, Math.max(0, value))
}

export function clampGroupStrobeValue(value: number): number {
  if (!Number.isFinite(value)) return DMX_MIN_VALUE
  return Math.min(DMX_MAX_VALUE, Math.max(DMX_MIN_VALUE, Math.round(value)))
}

/** Resolved override for one fixture partition after merging every group it belongs to. */
interface ResolvedOverride {
  brightness?: number
  strobe?: number
}

/**
 * Merge every armed group a fixture belongs to into one override per partition.
 *
 * Overlapping groups resolve highest-takes-precedence, the way submasters do on a
 * desk: order-independent, and turning one group down never darkens a fixture that
 * another group is holding up.
 */
function resolveOverrides(
  fixtures: FlattenedFixture[],
  groupControl: GroupControlState | null | undefined
): Map<FlattenedFixture, ResolvedOverride> {
  const resolved = new Map<FlattenedFixture, ResolvedOverride>()
  const byGroup = safeByGroup(groupControl)

  for (const group of activeGroupControlNames(groupControl)) {
    const control = byGroup[group]
    if (control === null || control === undefined) continue

    for (const fixture of getFixturesInGroups(fixtures, { [group]: true })) {
      const current = resolved.get(fixture) ?? {}
      // A group forcing full still has to contribute, not just skip: a fixture it
      // shares with a dimmed group has to come up to full, and HTP only sees values
      // that were actually offered.
      const forcesFull = isGroupBrightnessForcedFull(control)
      if (forcesFull || isGroupBrightnessActive(control)) {
        const brightness = forcesFull ? 1 : clamp01(control.brightness)
        current.brightness =
          current.brightness === undefined
            ? brightness
            : Math.max(current.brightness, brightness)
      }
      if (control.strobeEnabled === true) {
        const strobe = clampGroupStrobeValue(control.strobe)
        current.strobe =
          current.strobe === undefined ? strobe : Math.max(current.strobe, strobe)
      }
      resolved.set(fixture, current)
    }
  }

  return resolved
}

function writeChannel(channels: number[], channelIdx: number, value: number): void {
  const index = channelIdx - 1
  if (index < 0 || index >= channels.length) return
  channels[index] = Math.min(DMX_MAX_VALUE, Math.max(DMX_MIN_VALUE, value))
}

function readChannel(channels: number[], channelIdx: number): number {
  const index = channelIdx - 1
  if (index < 0 || index >= channels.length) return 0
  return channels[index] ?? 0
}

/** Scale a dimmer's current level within its own DMX range. */
function scaleMasterRange(
  channels: number[],
  channelIdx: number,
  min: number,
  max: number,
  brightness: number
): void {
  const span = max - min
  if (span <= 0) return
  // Scale the scene's *level* inside the channel's range rather than its raw DMX
  // value, so a dimmer whose range starts above 0 cannot be pushed under its own
  // minimum.
  const sceneLevel = clamp01((readChannel(channels, channelIdx) - min) / span)
  writeChannel(channels, channelIdx, min + span * sceneLevel * brightness)
}

/**
 * Scale a fixture's dimmer by the group fader.
 *
 * Brightness only ever touches master/dimmer channels. Colour channels are left
 * alone deliberately: anything the scene puts on them — randomizer, colour
 * modulation, position gating — has to survive untouched, and scaling emitters
 * would fight it. The cost is that a fixture with no dimmer does not respond to
 * this fader at all, which is the honest answer for a channel layout that has
 * nowhere to put a level.
 *
 * Proportional to the scene, never additive: the scene sets the ceiling and the
 * fader works down from it, so a scene at 0 stays dark.
 */
function applyBrightnessToChannel(
  channels: number[],
  channelIdx: number,
  channel: FixtureChannel,
  brightness: number
): void {
  if (channel.type === 'master') {
    if (channel.isOnOff) {
      // Nothing to scale on a binary dimmer — hold the scene's state until the
      // fader drops past halfway, then drop out.
      const sceneOn = readChannel(channels, channelIdx) > (channel.min + channel.max) / 2
      writeChannel(
        channels,
        channelIdx,
        sceneOn && brightness > 0.5 ? channel.max : channel.min
      )
      return
    }
    scaleMasterRange(channels, channelIdx, channel.min, channel.max, brightness)
    return
  }

  if (channel.type === 'split') {
    // Dimmer folded into a shared channel (commonly dimmer + shutter). Only scale
    // while the scene actually has the channel inside the dimmer range — otherwise
    // it is doing something else entirely and must be left alone.
    for (const range of channel.ranges) {
      if (range.channel.type !== 'master') continue
      const current = readChannel(channels, channelIdx)
      if (current < range.min || current > range.max) return
      scaleMasterRange(channels, channelIdx, range.min, range.max, brightness)
      return
    }
  }
}

/**
 * Whether a custom channel is the fixture's strobe.
 *
 * Most real profiles carry strobe as a `custom` channel rather than the built-in
 * `strobe` type, because that type only stores a solid and a strobe constant and so
 * cannot express a speed — the whole point of driving strobe by DMX value. Matching
 * on the channel name is the same approach the fixture importers use.
 */
function isCustomStrobeChannel(channel: FixtureChannel): boolean {
  if (channel.type !== 'custom') return false
  const name = channel.name.trim().toLowerCase()
  return name.includes('strobe') || name.includes('shutter')
}

function applyStrobeToChannel(
  channels: number[],
  channelIdx: number,
  channel: FixtureChannel,
  strobe: number
): void {
  if (channel.type === 'strobe' || isCustomStrobeChannel(channel)) {
    // Written literally: the fader *is* the DMX value, so what the readout says is
    // what lands on the wire.
    writeChannel(channels, channelIdx, strobe)
    return
  }

  if (channel.type === 'split') {
    // Shutter/strobe folded into a shared channel: place the value inside the
    // range that owns strobe rather than clobbering the whole channel.
    for (const range of channel.ranges) {
      if (range.channel.type !== 'strobe') continue
      const span = range.max - range.min
      writeChannel(
        channels,
        channelIdx,
        range.min + (span * strobe) / DMX_MAX_VALUE
      )
      return
    }
  }
}

/** Drop one fixture's intensity to nothing, leaving position and colour choice alone. */
function blackoutFixtureIntensity(
  channels: number[],
  fixture: FlattenedFixture
): void {
  for (const [channelIdx, channel] of fixture.channels) {
    if (channel.type === 'master') {
      writeChannel(channels, channelIdx, channel.min)
      continue
    }
    if (channel.type === 'color') {
      writeChannel(channels, channelIdx, DMX_MIN_VALUE)
      continue
    }
    if (channel.type === 'split') {
      for (const range of channel.ranges) {
        if (range.channel.type !== 'master') continue
        writeChannel(channels, channelIdx, range.min)
        break
      }
    }
  }
}

/**
 * Hold everything outside the soloed groups dark.
 *
 * Membership is resolved per physical fixture rather than per partition: a group
 * like `Movers` can match only the partition holding the pan/tilt channels, and
 * blacking out the rest of that same head would be exactly wrong.
 */
function applyExclusiveBlackout(
  channels: number[],
  universeFixtures: FlattenedFixture[],
  groupControl: GroupControlState | null | undefined
): void {
  const soloGroups = exclusiveGroupNames(groupControl)
  if (soloGroups.length === 0) return

  const keptPartitions = new Set<FlattenedFixture>()
  const keptFixtureIds = new Set<string>()
  for (const group of soloGroups) {
    for (const fixture of getFixturesInGroups(universeFixtures, { [group]: true })) {
      keptPartitions.add(fixture)
      const id = fixture.fixtureId?.trim()
      if (id !== undefined && id.length > 0) {
        keptFixtureIds.add(id)
      }
    }
  }

  for (const fixture of universeFixtures) {
    if (keptPartitions.has(fixture)) continue
    const id = fixture.fixtureId?.trim()
    if (id !== undefined && id.length > 0 && keptFixtureIds.has(id)) continue
    blackoutFixtureIntensity(channels, fixture)
  }
}

/**
 * Should this channel carry the blinder's white?
 *
 * Anything that makes white light: the colour emitters, plus white / warm-white
 * channels, which some profiles model as a colour channel and others as a custom
 * channel named "White". Amber and UV are left alone — driving them would tint the
 * result rather than brighten it.
 */
/**
 * DMX for the white / open slot of a colour wheel, or null if it has none.
 *
 * Wheel fixtures have no colour emitters to drive, so white has to come from the
 * wheel itself. Same white test the scene renderer uses when it resolves a colour to
 * a slot, and the same mid-slot DMX, so the blinder lands where the engine would.
 */
function colorWheelWhiteDmx(channel: FixtureChannel): number | null {
  if (channel.type !== 'colorMap') return null
  const slots = listColorMapSlots(channel)
  for (const slot of slots) {
    if (inferColorKind(slot) === 'white' || slot.saturation <= COLOR_WHEEL_WHITE_MAX_SATURATION) {
      return slot.outputDmx
    }
  }
  return null
}

function blinderWhiteContribution(channel: FixtureChannel): 'full' | null {
  if (channel.type === 'color') {
    const kind = inferColorKind(channel.color)
    if (kind === 'amber' || kind === 'uv') return null
    return 'full'
  }
  if (channel.type === 'custom') {
    const name = channel.name.trim().toLowerCase()
    if (name.includes('amber')) return null
    if (name.includes('uv') || name.includes('ultraviolet')) return null
    if (name.includes('white')) return 'full'
  }
  return null
}

/**
 * Drive a group to white, overriding whatever the scene put on the wire.
 *
 * Deliberately the last thing written: a blinder is a full takeover of the fixture,
 * so it beats the group's own faders and even a solo blackout. Nothing is stored —
 * once the level reaches zero the scene simply shows through again.
 */
function applyBlinder(
  channels: number[],
  universeFixtures: FlattenedFixture[],
  blinderLevels: { [group: string]: number }
): void {
  const groups = Object.keys(blinderLevels)
  if (groups.length === 0) return

  // A fixture in two blinding groups takes the brighter of the two.
  const levelByFixture = new Map<FlattenedFixture, number>()
  for (const group of groups) {
    const level = clamp01(blinderLevels[group] ?? 0)
    if (level <= 0) continue
    for (const fixture of getFixturesInGroups(universeFixtures, { [group]: true })) {
      const existing = levelByFixture.get(fixture)
      if (existing === undefined || level > existing) {
        levelByFixture.set(fixture, level)
      }
    }
  }

  for (const [fixture, level] of levelByFixture) {
    {
      for (const [channelIdx, channel] of fixture.channels) {
        if (channel.type === 'master') {
          writeChannel(
            channels,
            channelIdx,
            channel.isOnOff
              ? level > 0.5
                ? channel.max
                : channel.min
              : channel.min + (channel.max - channel.min) * level
          )
          continue
        }
        if (blinderWhiteContribution(channel) === 'full') {
          writeChannel(channels, channelIdx, DMX_MAX_VALUE * level)
          continue
        }
        const wheelWhite = colorWheelWhiteDmx(channel)
        if (wheelWhite !== null) {
          // A wheel slot is a position, not a level — it goes to white and stays
          // there for the whole fade. The dimmer above is what actually fades.
          writeChannel(channels, channelIdx, wheelWhite)
        }
      }
    }
  }
}

/**
 * Apply the armed group controls to a finished universe buffer.
 *
 * Runs after the scene has been rendered and before the DMX mixer's per-channel
 * overwrites, so the mixer stays the final word.
 */
export function applyGroupControlsToUniverse(
  channels: number[],
  universeFixtures: FlattenedFixture[],
  groupControl: GroupControlState | null | undefined,
  /** Per-group blinder level from `advanceBlinderLevels`. */
  blinderLevels: { [group: string]: number } = {}
): void {
  const hasBlinder = Object.keys(blinderLevels).length > 0
  // A blinder mid-fade keeps rendering after its button is up, so the early-out
  // cannot rely on the armed-control list alone.
  if (!hasBlinder && activeGroupControlNames(groupControl).length === 0) return

  const resolved = resolveOverrides(universeFixtures, groupControl)

  for (const [fixture, override] of resolved) {
    for (const [channelIdx, channel] of fixture.channels) {
      if (override.brightness !== undefined) {
        applyBrightnessToChannel(channels, channelIdx, channel, override.brightness)
      }
      if (override.strobe !== undefined) {
        applyStrobeToChannel(channels, channelIdx, channel, override.strobe)
      }
    }
  }

  // Solo wins over any level the faders above just set...
  applyExclusiveBlackout(channels, universeFixtures, groupControl)
  // ...and the blinder wins over everything, including a solo blackout.
  applyBlinder(channels, universeFixtures, blinderLevels)
}

/** Fixture count a group control will actually reach, for the UI. */
export function countFixturesInGroup(
  fixtures: FlattenedFixture[],
  group: string
): number {
  const ids = new Set<string>()
  let unnamed = 0
  for (const fixture of getFixturesInGroups(fixtures, { [group]: true })) {
    const id = fixture.fixtureId?.trim()
    if (id === undefined || id.length === 0) {
      unnamed += 1
      continue
    }
    ids.add(id)
  }
  return ids.size + unnamed
}
