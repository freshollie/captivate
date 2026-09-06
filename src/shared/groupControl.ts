import type { FixtureChannel, FlattenedFixture } from './dmxFixtures'
import { DMX_MAX_VALUE, DMX_MIN_VALUE } from './dmxFixtures'
import {
  fixtureMatchesGroup,
  getFixturesInGroups,
  isVirtualFixtureGroup,
  listColorMapSlots,
} from './dmxUtil'
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
 *   so it is always live and a full fader changes nothing. `overrideScene` turns
 *   that on its head for one group at a time: the fader stops scaling the scene and
 *   drives the fixtures itself, dark at 0 and full white at 1.
 * - **Strobe is a true override.** It writes a raw DMX value the scene engine has no
 *   way to express — `ChannelStrobe` only holds a solid and a strobe constant — so
 *   there is no scene value to scale against. Because 0 is a meaningful strobe value
 *   rather than "off", it needs an explicit armed flag and an explicit release.
 *
 *   Only Flash arms it. The fader trims a strobe that is already live and is inert
 *   otherwise, so a knocked fader — or a controller spilling its positions when it
 *   connects — cannot start the rig strobing. Flash plus Release locks the strobe on,
 *   which is what frees a hand to dial the fader.
 */
export interface GroupControl {
  /** 0..1, multiplied into the scene's level. 1 = no change. Always applied. */
  brightness: number
  /**
   * Armed by Flash — never by the fader — and cleared by Release, by letting go of an
   * unlocked flash, or, if it was locked, by a light-scene change.
   */
  strobeEnabled: boolean
  /** Raw DMX 0..255 written to the group's strobe channels. */
  strobe: number
  /**
   * Level the Flash button fires at, remembered from the last value dialled on the
   * fader. Survives Release and scene changes — those can clear the *live* strobe, but
   * the flash needs something to fire or the button would be inert.
   */
  strobeFlashLevel: number
  /**
   * True while Flash is engaged, as opposed to the strobe standing on a lock. Both
   * light the same channels; only an engaged flash forces brightness to full, so they
   * have to be told apart.
   */
  strobeFlashActive: boolean
  /**
   * True only while a *press* is holding Flash — a MIDI pad down, and nothing else.
   * An on-screen click latches instead, because no release will ever be reported for
   * it. Implies `strobeFlashActive`.
   *
   * Its own flag because the lock gesture is "Release while the pad is down": read
   * off `strobeFlashActive` instead, an on-screen latch would turn every Release
   * click into a lock toggle and leave no way to hand the strobe back.
   */
  strobeFlashHeld: boolean
  /**
   * Keeps the strobe up after Flash is let go, until Release. Set by tapping Release
   * while holding Flash — or by pressing Flash while Release is held — and cleared by
   * the same gesture, by any release, or by the next light scene.
   *
   * The point is the fader: it only moves a live strobe, so without a lock the level
   * could only be dialled with a pad held down.
   */
  strobeLocked: boolean
  /**
   * Solo. While any group is exclusive, fixtures outside every exclusive group are
   * held dark. Momentary by default — this is a "hit it for the drop" control — but
   * it can be locked on the same way the strobe can.
   */
  exclusiveEnabled: boolean
  /**
   * True only while a *press* is holding Solo down, so Release can tell a pad being
   * held from a solo latched off the card. The strobe's `strobeFlashHeld` in every
   * respect; see it for why an on-screen click deliberately does not count.
   */
  exclusiveHeld: boolean
  /**
   * Keeps the solo up after the pad is let go, until Release or the next light scene.
   * Set by tapping Release while holding Solo, or pressing Solo while Release is held.
   *
   * Unlike a locked strobe, a locked solo keeps pulling its own group to full: that
   * is not a flourish on top of the solo, it *is* the solo — everything else is dark
   * and this is the thing being shown. A latched solo off the card has always behaved
   * that way, and a lock is the same state reached from a pad.
   */
  exclusiveLocked: boolean
  /**
   * Blinder. While held, the group is driven to pulsing white regardless of the
   * scene — including fixtures the scene never addresses. Momentary by default;
   * nothing about the programming changes, so letting go restores it exactly. Can be
   * locked on, same gesture as the strobe and the solo.
   */
  blinderActive: boolean
  /**
   * True only while a *press* is holding Blind down. The strobe's `strobeFlashHeld`
   * in every respect; see it for why an on-screen click deliberately does not count.
   */
  blinderHeld: boolean
  /**
   * Keeps the blinder up after the pad is let go, until Release or the next light
   * scene. Set by tapping Release while holding Blind, or the other way round.
   *
   * The loudest thing a lock can hold — a group pinned to pulsing white — so it is
   * worth remembering that Release all drops it, and that a locked blinder keeps
   * fading out over `blinderFadeBeats` when it finally does come down.
   */
  blinderLocked: boolean
  /**
   * True while this group's Release pad is down. Held, Release stops meaning release
   * and becomes the lock modifier: whatever is pressed while it is down locks on.
   */
  releaseHeld: boolean
  /**
   * Whether the Release pad currently down has locked anything — either a pad pressed
   * while it was held, or a pad already held when it was tapped.
   *
   * A release fires when the pad comes *up*, not when it goes down, so that reaching
   * for Release first and a second pad after does not drop the locks the operator is
   * in the middle of adding to. This flag is how the note-off tells a lock gesture
   * from a plain tap.
   */
  releaseUsedForLock: boolean
  /**
   * Whether the master's *momentary* controls — strobe and blinder — reach this
   * group. The master dimmer is deliberately not gated: it is the rig's trim, so a
   * fader move has to mean the same thing everywhere or the balance between groups
   * changes depending on a checkbox. Opt-out rather than opt-in, so a newly created
   * group behaves like the rest of the rig; clear it for anything that must never be
   * strobed or blinded from the master (house lights, practicals).
   */
  followMasterHotkeys: boolean
  /**
   * Take the group off the scene entirely: the brightness fader stops scaling what
   * the scene produced and drives the fixtures directly, to white at whatever level
   * it is parked at — whether or not any split addresses them.
   *
   * The blinder is the same shape of takeover, but it only lasts while a button is
   * held. This is that takeover standing on the fader instead, for a group nobody
   * wants to program: house lights, a wash over the bar, a practical.
   *
   * It changes what the fader *means*, which is why it is a setting rather than
   * something the fader can reach on its own. Normally full is the released
   * position and the scene shows through untouched; on an overriding group full is
   * full white and 0 is dark, with none of the scene left at either end.
   */
  overrideScene: boolean
}

/**
 * Controls that sit on top of the groups below them.
 *
 * The dimmer is a second multiplier rather than a replacement — group 50% under
 * master 50% gives 25% — so the master trims the rig without disturbing the balance
 * between groups. It reaches every group; only the momentary strobe and blinder
 * honour `followMasterHotkeys`.
 */
export interface GroupMasterControl {
  /** 0..1, multiplied on top of every group's own dimmer. Reaches every group. */
  brightness: number
  /**
   * Momentary: held while the master strobe button is down. Fires the own flash of
   * every group that follows the master hotkeys, rather than a level of its own, so
   * each group strobes at the value dialled on its card.
   */
  strobeActive: boolean
  /** Momentary: held while the master blinder button is down. */
  blinderActive: boolean
}

export function initGroupMasterControl(): GroupMasterControl {
  return {
    brightness: 1,
    strobeActive: false,
    blinderActive: false,
  }
}

/**
 * Runtime key for the master's blinder, kept alongside the per-group ones.
 *
 * Prefixed with a character no fixture group name can contain, so it can never
 * collide with a real group.
 */
export const MASTER_BLINDER_KEY = '\u0000master'

/** Fresh groups flash at full rather than at nothing. */
export const DEFAULT_STROBE_FLASH_LEVEL = 255

export interface GroupControlState {
  byGroup: { [group: string]: GroupControl | undefined }
  /** How long a blinder takes to fade out after release, in beats. Global. */
  blinderFadeBeats: number
  master: GroupMasterControl
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
    MASTER_BLINDER_KEY,
  ])

  for (const group of groups) {
    // The master rides the same fade machinery as a group, under a reserved key.
    const held =
      group === MASTER_BLINDER_KEY
        ? safeMaster(groupControl).blinderActive === true
        : byGroup[group]?.blinderActive === true

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
    strobeFlashHeld: false,
    strobeLocked: false,
    exclusiveEnabled: false,
    exclusiveHeld: false,
    exclusiveLocked: false,
    blinderActive: false,
    blinderHeld: false,
    blinderLocked: false,
    releaseHeld: false,
    releaseUsedForLock: false,
    followMasterHotkeys: true,
    overrideScene: false,
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
  return {
    byGroup: {},
    blinderFadeBeats: DEFAULT_BLINDER_FADE_BEATS,
    master: initGroupMasterControl(),
  }
}

function safeMaster(
  state: GroupControlState | null | undefined
): GroupMasterControl {
  const master = state?.master
  if (master === null || master === undefined || typeof master !== 'object') {
    return initGroupMasterControl()
  }
  return master
}

/**
 * Fixtures the master strobe and blinder must not touch.
 *
 * Membership is resolved per physical fixture: opting a group out means those lights
 * ignore the master hotkeys, even if they also sit in a group that follows them. The
 * safer reading — an explicit opt-out should not be undone by an unrelated
 * membership.
 */
function masterHotkeyExemptFixtures(
  universeFixtures: FlattenedFixture[],
  groupControl: GroupControlState | null | undefined
): Set<FlattenedFixture> {
  const byGroup = safeByGroup(groupControl)
  const exempt = new Set<FlattenedFixture>()
  const exemptIds = new Set<string>()

  const exemptGroups = Object.keys(byGroup).filter(
    (group) => byGroup[group]?.followMasterHotkeys === false
  )
  const fixturesInGroup = fixturesByGroupName(universeFixtures, exemptGroups)

  for (const group of exemptGroups) {
    for (const fixture of fixturesInGroup.get(group) ?? []) {
      exempt.add(fixture)
      const id = fixture.fixtureId?.trim()
      if (id !== undefined && id.length > 0) exemptIds.add(id)
    }
  }

  if (exemptIds.size > 0) {
    for (const fixture of universeFixtures) {
      const id = fixture.fixtureId?.trim()
      if (id !== undefined && id.length > 0 && exemptIds.has(id)) exempt.add(fixture)
    }
  }

  return exempt
}

/** Fixtures the master strobe and blinder apply to. */
function masterHotkeyFixtures(
  universeFixtures: FlattenedFixture[],
  groupControl: GroupControlState | null | undefined
): FlattenedFixture[] {
  const exempt = masterHotkeyExemptFixtures(universeFixtures, groupControl)
  if (exempt.size === 0) return universeFixtures
  return universeFixtures.filter((fixture) => !exempt.has(fixture))
}

/** Whether this group's fader has taken its fixtures off the scene. */
export function isGroupOverridingScene(
  control: GroupControl | null | undefined
): boolean {
  return control?.overrideScene === true
}

export function isGroupControlActive(
  control: GroupControl | null | undefined
): boolean {
  if (control === null || control === undefined) return false
  return (
    // An overriding group is holding its fixtures off the scene at every fader
    // position, full included, so it is always doing something.
    isGroupOverridingScene(control) ||
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

/** Group names driving their fixtures straight off the fader, in stable order. */
export function overridingGroupNames(
  state: GroupControlState | null | undefined
): string[] {
  const byGroup = safeByGroup(state)
  return Object.keys(byGroup)
    .filter((group) => isGroupOverridingScene(byGroup[group]))
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
 * Which fixtures sit in each of the named groups, resolved in one pass over the rig.
 *
 * The obvious shape — ask `getFixturesInGroups` once per group — walks every fixture
 * for every group, and `evaluateSceneGroups` allocates three arrays for each fixture
 * it tests. That is O(groups x fixtures) with an allocation per test, on every DMX
 * frame of every universe, which is why adding groups to a show made the engine
 * steadily slower rather than costing a flat amount. Reading each fixture's own group
 * list instead makes it one pass.
 *
 * Virtual groups keep the predicate: a fixture is in `Movers` or `Atmosphere` by what
 * channels it has, not by its group list, and there are only ever a few of them.
 */
function fixturesByGroupName(
  fixtures: FlattenedFixture[],
  groups: string[]
): Map<string, FlattenedFixture[]> {
  const byGroup = new Map<string, FlattenedFixture[]>()
  if (groups.length === 0) return byGroup

  const named = new Set<string>()
  const virtual: string[] = []
  for (const group of groups) {
    byGroup.set(group, [])
    if (isVirtualFixtureGroup(group)) virtual.push(group)
    else named.add(group)
  }

  for (const fixture of fixtures) {
    if (named.size > 0) {
      for (const group of fixture.groups) {
        // `named` excludes the virtual names, so a fixture can never be added twice
        // — matching `fixtureMatchesGroup`, which ignores the fixture's own list for
        // those.
        if (named.has(group)) byGroup.get(group)?.push(fixture)
      }
    }
    for (const group of virtual) {
      if (fixtureMatchesGroup(fixture, group)) byGroup.get(group)?.push(fixture)
    }
  }

  return byGroup
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
  groupControl: GroupControlState | null | undefined,
  /** Armed groups, already worked out by the caller's early-out check. */
  activeGroups: string[]
): Map<FlattenedFixture, ResolvedOverride> {
  const resolved = new Map<FlattenedFixture, ResolvedOverride>()
  const byGroup = safeByGroup(groupControl)
  const fixturesInGroup = fixturesByGroupName(fixtures, activeGroups)

  for (const group of activeGroups) {
    const control = byGroup[group]
    if (control === null || control === undefined) continue

    for (const fixture of fixturesInGroup.get(group) ?? []) {
      const current = resolved.get(fixture) ?? {}
      // A group forcing full still has to contribute, not just skip: a fixture it
      // shares with a dimmed group has to come up to full, and HTP only sees values
      // that were actually offered.
      const forcesFull = isGroupBrightnessForcedFull(control)
      // An overriding group's fader is not a scaling of the scene, so it has no
      // business here: it is written whole further down. Offering it to HTP would
      // both scale the scene it is supposed to be replacing and drag any group it
      // overlaps up with it.
      if (
        !isGroupOverridingScene(control) &&
        (forcesFull || isGroupBrightnessActive(control))
      ) {
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

/**
 * Where a fixture's level lives on this channel: a master channel, or the master
 * range of a split that folds the dimmer in with something else.
 *
 * Only for the full-takeover writers below, which replace the channel outright. The
 * proportional fader has to be fussier — it may only touch a split while the scene
 * has it inside the dimmer range — so it keeps its own reading.
 */
function masterRangeOf(
  channel: FixtureChannel
): { min: number; max: number; isOnOff: boolean } | null {
  if (channel.type === 'master') {
    return { min: channel.min, max: channel.max, isOnOff: channel.isOnOff === true }
  }
  if (channel.type === 'split') {
    for (const range of channel.ranges) {
      if (range.channel.type === 'master') {
        return {
          min: range.min,
          max: range.max,
          isOnOff: range.channel.isOnOff === true,
        }
      }
    }
  }
  return null
}

function fixtureHasDimmer(fixture: FlattenedFixture): boolean {
  for (const [, channel] of fixture.channels) {
    if (masterRangeOf(channel) !== null) return true
  }
  return false
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
  const fixturesInGroup = fixturesByGroupName(universeFixtures, soloGroups)
  for (const group of soloGroups) {
    for (const fixture of fixturesInGroup.get(group) ?? []) {
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
  groupControl: GroupControlState | null | undefined,
  blinderLevels: { [group: string]: number }
): void {
  const groups = Object.keys(blinderLevels)
  if (groups.length === 0) return

  // A fixture blinding from two sources takes the brighter of the two.
  const levelByFixture = new Map<FlattenedFixture, number>()
  const fixturesInGroup = fixturesByGroupName(
    universeFixtures,
    groups.filter((group) => group !== MASTER_BLINDER_KEY)
  )
  for (const group of groups) {
    const level = clamp01(blinderLevels[group] ?? 0)
    if (level <= 0) continue
    const targets =
      group === MASTER_BLINDER_KEY
        ? masterHotkeyFixtures(universeFixtures, groupControl)
        : fixturesInGroup.get(group) ?? []
    for (const fixture of targets) {
      const existing = levelByFixture.get(fixture)
      if (existing === undefined || level > existing) {
        levelByFixture.set(fixture, level)
      }
    }
  }

  for (const [fixture, level] of levelByFixture) {
    driveFixtureWhite(channels, fixture, level, true)
  }
}

/**
 * Drive one fixture to white at `level`, over the top of whatever the scene left on
 * its channels. Shared by the blinder and by an overriding group's fader.
 *
 * `scaleEmitters` decides where the level lands on a fixture that has a dimmer. The
 * blinder scales the colour emitters as well as the dimmer, which costs nothing for
 * a button that lives at full and fades out over a beat. A fader parked at 60% is a
 * different matter — scaling both would land it near 36% — so an override holds the
 * emitters at full and lets the dimmer carry the level on its own. A fixture with no
 * dimmer scales its emitters either way; there is nowhere else to put a level.
 */
function driveFixtureWhite(
  channels: number[],
  fixture: FlattenedFixture,
  level: number,
  scaleEmitters: boolean
): void {
  const emitterLevel = scaleEmitters || !fixtureHasDimmer(fixture) ? level : 1

  for (const [channelIdx, channel] of fixture.channels) {
    const master = masterRangeOf(channel)
    if (master !== null) {
      writeChannel(
        channels,
        channelIdx,
        master.isOnOff
          ? level > 0.5
            ? master.max
            : master.min
          : master.min + (master.max - master.min) * level
      )
      continue
    }
    if (blinderWhiteContribution(channel) === 'full') {
      writeChannel(channels, channelIdx, DMX_MAX_VALUE * emitterLevel)
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

/**
 * Drive the overriding groups straight from their own faders.
 *
 * Everything a blinder does, held on a fader instead of a button: white at the
 * fader's level, on every fixture in the group, whether or not the scene addresses
 * them. Fixtures in two overriding groups take the brighter of the two, matching how
 * the blinder and the proportional faders resolve an overlap.
 *
 * Placed after the proportional faders — whose work it replaces — and before the
 * master, so the master dimmer still trims these groups the way it trims the rest of
 * the rig, and before the solo blackout, so an overriding group outside a solo goes
 * dark with everything else.
 */
function applySceneOverrides(
  channels: number[],
  universeFixtures: FlattenedFixture[],
  groupControl: GroupControlState | null | undefined,
  /** Overriding groups, already worked out by the caller. */
  overridingGroups: string[]
): void {
  if (overridingGroups.length === 0) return

  const byGroup = safeByGroup(groupControl)
  const fixturesInGroup = fixturesByGroupName(universeFixtures, overridingGroups)
  const levelByFixture = new Map<FlattenedFixture, number>()

  for (const group of overridingGroups) {
    // `effectiveGroupBrightness` rather than the raw fader, so Flash and Solo pull
    // an overriding group to full white the same way they pull a normal one to full.
    const level = effectiveGroupBrightness(byGroup[group])
    for (const fixture of fixturesInGroup.get(group) ?? []) {
      const existing = levelByFixture.get(fixture)
      if (existing === undefined || level > existing) {
        levelByFixture.set(fixture, level)
      }
    }
  }

  for (const [fixture, level] of levelByFixture) {
    driveFixtureWhite(channels, fixture, level, false)
  }
}

/**
 * Layer the master dimmer and strobe over the groups below them.
 *
 * The dimmer multiplies whatever the group faders already produced, so the two
 * compose: 50% under 50% is 25%. It runs after group brightness for exactly that
 * reason, and touches only master/dimmer channels, matching the group rule.
 *
 * The two halves cover different fixtures on purpose: the dimmer is the rig's trim
 * and reaches everything, while the strobe is a momentary hotkey and honours
 * `followMasterHotkeys`.
 */
function applyMaster(
  channels: number[],
  universeFixtures: FlattenedFixture[],
  groupControl: GroupControlState | null | undefined
): void {
  const master = safeMaster(groupControl)
  const brightness = clamp01(
    Number.isFinite(master.brightness) ? master.brightness : 1
  )
  const strobing = master.strobeActive === true
  const dimming = brightness < 1
  if (!strobing && !dimming) return

  if (dimming) {
    for (const fixture of universeFixtures) {
      for (const [channelIdx, channel] of fixture.channels) {
        applyBrightnessToChannel(channels, channelIdx, channel, brightness)
      }
    }
  }

  if (!strobing) return

  const following = masterHotkeyFixtures(universeFixtures, groupControl)
  const strobeLevels = masterStrobeLevelByFixture(following, groupControl)

  for (const fixture of following) {
    const strobeValue = strobeLevels.get(fixture)
    if (strobeValue === undefined) continue
    for (const [channelIdx, channel] of fixture.channels) {
      applyStrobeToChannel(channels, channelIdx, channel, strobeValue)
    }
  }
}

/**
 * What each fixture strobes at when the master strobe is held.
 *
 * The master fires the groups' own flashes rather than a level of its own, so a
 * fixture strobes at the level dialled on its card. A fixture in several groups takes
 * the brightest of them; one in no configured group still strobes, at the same
 * default a fresh card would flash at.
 */
function masterStrobeLevelByFixture(
  followingFixtures: FlattenedFixture[],
  groupControl: GroupControlState | null | undefined
): Map<FlattenedFixture, number> {
  const byGroup = safeByGroup(groupControl)
  const levels = new Map<FlattenedFixture, number>()

  const groups = Object.keys(byGroup).filter(
    (group) => byGroup[group]?.followMasterHotkeys !== false
  )
  const fixturesInGroup = fixturesByGroupName(followingFixtures, groups)

  for (const group of groups) {
    const control = byGroup[group]
    if (control === null || control === undefined) continue
    const level = clampGroupStrobeValue(control.strobeFlashLevel)
    for (const fixture of fixturesInGroup.get(group) ?? []) {
      const existing = levels.get(fixture)
      if (existing === undefined || level > existing) levels.set(fixture, level)
    }
  }

  for (const fixture of followingFixtures) {
    if (!levels.has(fixture)) levels.set(fixture, DEFAULT_STROBE_FLASH_LEVEL)
  }

  return levels
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
  const master = safeMaster(groupControl)
  const hasMaster =
    master.strobeActive === true ||
    (Number.isFinite(master.brightness) && master.brightness < 1)
  // A blinder mid-fade keeps rendering after its button is up, and the master acts
  // on groups that may have no entry at all, so the early-out cannot rely on the
  // armed-control list alone.
  const activeGroups = activeGroupControlNames(groupControl)
  if (!hasBlinder && !hasMaster && activeGroups.length === 0) {
    return
  }

  const resolved = resolveOverrides(universeFixtures, groupControl, activeGroups)

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

  // Groups taken off the scene are written whole, replacing both the scene and the
  // proportional faders above.
  applySceneOverrides(
    channels,
    universeFixtures,
    groupControl,
    overridingGroupNames(groupControl)
  )

  // The master layers on top of the per-group faders, never replacing them.
  applyMaster(channels, universeFixtures, groupControl)

  // Solo wins over any level the faders above just set...
  applyExclusiveBlackout(channels, universeFixtures, groupControl)
  // ...and the blinder wins over everything, including a solo blackout.
  applyBlinder(channels, universeFixtures, groupControl, blinderLevels)
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
