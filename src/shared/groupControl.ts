import type { FixtureChannel, FlattenedFixture } from './dmxFixtures'
import { DMX_MAX_VALUE, DMX_MIN_VALUE } from './dmxFixtures'
import { getFixturesInGroups } from './dmxUtil'

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
   * Solo. While any group is exclusive, fixtures outside every exclusive group are
   * held dark. Momentary by design — this is a "hit it for the drop" control.
   */
  exclusiveEnabled: boolean
}

/** Fresh groups flash at full rather than at nothing. */
export const DEFAULT_STROBE_FLASH_LEVEL = 255

export interface GroupControlState {
  byGroup: { [group: string]: GroupControl | undefined }
}

export function initGroupControl(): GroupControl {
  return {
    brightness: 1,
    strobeEnabled: false,
    strobe: 0,
    strobeFlashLevel: DEFAULT_STROBE_FLASH_LEVEL,
    exclusiveEnabled: false,
  }
}

/** Brightness at full is the released state — nothing to undo. */
export function isGroupBrightnessActive(
  control: GroupControl | null | undefined
): boolean {
  const brightness = control?.brightness
  return Number.isFinite(brightness) && (brightness as number) < 1
}

export function initGroupControlState(): GroupControlState {
  return { byGroup: {} }
}

export function isGroupControlActive(
  control: GroupControl | null | undefined
): boolean {
  if (control === null || control === undefined) return false
  return (
    isGroupBrightnessActive(control) ||
    control.strobeEnabled === true ||
    control.exclusiveEnabled === true
  )
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
      if (isGroupBrightnessActive(control)) {
        const brightness = clamp01(control.brightness)
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
 * Apply the armed group controls to a finished universe buffer.
 *
 * Runs after the scene has been rendered and before the DMX mixer's per-channel
 * overwrites, so the mixer stays the final word.
 */
export function applyGroupControlsToUniverse(
  channels: number[],
  universeFixtures: FlattenedFixture[],
  groupControl: GroupControlState | null | undefined
): void {
  if (activeGroupControlNames(groupControl).length === 0) return

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

  // Last, so solo wins over any level the faders above just set.
  applyExclusiveBlackout(channels, universeFixtures, groupControl)
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
