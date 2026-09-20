import type { ChannelAxis, FixtureChannel, FlattenedFixture } from './dmxFixtures'
import { DMX_MAX_VALUE, DMX_MIN_VALUE } from './dmxFixtures'
import {
  fixtureMatchesGroup,
  getFixturesInGroups,
  getIndexedMapSlotOutputDmx,
  isVirtualFixtureGroup,
  listColorMapSlots,
} from './dmxUtil'
import { inferColorKind } from './dmxColors'

/**
 * Per-group live controls, applied to the finished scene output on the way to the
 * wire. Grouping here is independent of scenes and splits.
 *
 * The three faders deliberately differ:
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
 * - **Disco ball is a positional blend, and only touches pan/tilt and the gobo.** It
 *   pulls every head in the group that has a mirror-ball aim of its own away from
 *   whatever the scene is aiming it at and onto the ball, 0 being the scene untouched
 *   and 1 the head locked on, and clears the gobo and prism so the beams reaching the
 *   ball are clean. Like brightness it is always live, because 0 *is* the released state;
 *   unlike brightness it rests at the bottom of its travel, since the scene — not the
 *   fader — is the thing it hands back to.
 *
 *   The bottom tenth of its travel is dead, because unlike the other two faders this
 *   one moves the rig physically: a knock, or a controller spilling fader positions
 *   when it connects, must not start swinging heads across the room.
 * - **Gobo is an override that arms on touch, and carries the prism with it.** Like
 *   the strobe it replaces a scene value outright rather than scaling one, so it
 *   needs an explicit release; unlike the strobe there is no pad to arm it, so moving
 *   the fader is what does. While it is up the group's wheels are the operator's: the
 *   gobo, prism and prism-rotation faders drive them together, since a beam look is
 *   the three of them at once and picking a gobo with the prism left wherever the
 *   scene had it is not a look anyone asks for.
 *
 *   The prism and rotation faders are settings for that override, not overrides of
 *   their own: they can be dialled with it down — the readouts bracket to say so —
 *   and nothing reaches the rig until the gobo fader arms it. Release hands all three
 *   back and drops the gobo fader to open, and so does the next light scene, which is
 *   what stops a beam look from quietly outliving the look it was built for.
 */
export interface GroupControl {
  /** 0..1, multiplied into the scene's level. 1 = no change. Always applied. */
  brightness: number
  /**
   * Raw fader position, 0..1. Read it through {@link groupDiscoBallLevel} rather than
   * directly: the bottom {@link DISCO_BALL_DEAD_ZONE} of the travel is dead, and the
   * rest is rescaled across it, so the position and the blend it produces are not the
   * same number. This field is the one the fader — hardware or on-screen — sits on.
   *
   * The blend runs from the scene's aim to each head's own mirror-ball aim: released
   * leaves the scene alone, full locks the heads on the ball, and anything between
   * sits them proportionally along the way.
   *
   * Position, gobo and prism only. Levels and colour stay with the scene, so the
   * movers keep doing whatever they were doing; they just do it pointing at the ball
   * with a clean beam. Heads with no aim captured on the Movers page are left alone
   * entirely.
   */
  discoBall: number
  /**
   * Whether the group's wheels are on the operator rather than the scene.
   *
   * Armed by moving the Gobo fader — there is no pad for it — and cleared by Release,
   * by Release all, or by the next light scene. It has to be armed rather than always
   * live because there is no released position: gobo 0 is a real slot (Open), so a
   * fader resting at the bottom would be a permanent "force every head open".
   */
  goboEnabled: boolean
  /**
   * 0..1 across the gobo wheel, mapped to a slot the same way a scene's `gobo` param
   * is: nearest of `count` evenly spaced detents. Fixtures with different wheels each
   * resolve it against their own slot list, so one fader reaches a mixed rig.
   *
   * Only ever non-zero while {@link goboEnabled} is up: every release drops it back to
   * open, so a disarmed card reads the way the rig looks.
   */
  gobo: number
  /** 0..1 across the prism wheel, resolved to a slot like {@link gobo}. */
  prism: number
  /** 0..1 across the prism rotation channel. 0 = stopped on most heads. */
  prismSpeed: number
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
   * Blackout. While held, every light in the group is driven dark whatever the scene,
   * the group's own faders or a solo are doing — the inverse of the blinder, and the
   * one control that answers "not these, not now". Momentary by default, and lockable
   * on the same gesture as the strobe, the solo and the blinder.
   *
   * The one thing it does not answer to is the scene. A locked strobe, solo or blinder
   * is a flourish on the look being played, so the next light scene drops it; a
   * blackout is a statement about the rig — a dead fixture, a bar nobody wants lit
   * through the speeches — and handing it back on a scene change would light exactly
   * the lights that were deliberately killed. Release and Release all are the only
   * ways down.
   */
  blackoutActive: boolean
  /**
   * True only while a *press* is holding Black down. The strobe's `strobeFlashHeld`
   * in every respect; see it for why an on-screen click deliberately does not count.
   */
  blackoutHeld: boolean
  /**
   * Keeps the blackout up after the pad is let go. Set by tapping Release while
   * holding Black, or the other way round.
   *
   * Alone among the locks it outlives a light-scene change — see {@link
   * blackoutActive} — so the card keeps its ring and the Release lamp stays lit for as
   * long as it stands, which is what stops a killed group being quietly forgotten.
   */
  blackoutLocked: boolean
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
   * Whether this group is gated by a timed Go button rather than left free-running.
   *
   * A valve, not a look: while it is off the group's lights are held at nothing, and
   * pressing Go opens them for {@link timedSeconds} and then shuts them again on its
   * own. Built for the things you fire rather than program — a fogger, a confetti
   * blast, a strobe bank nobody should be able to leave running — where the failure
   * mode of forgetting about it is worse than the failure mode of it stopping early.
   *
   * A setting, so it persists: a group configured as a fogger is still a fogger next
   * time the show opens. What does not persist is whether it happens to be running.
   */
  timedEnabled: boolean
  /**
   * How long one press of Go runs for, in seconds. Only meaningful with
   * {@link timedEnabled} up, and clamped to {@link MIN_TIMED_SECONDS}..{@link
   * MAX_TIMED_SECONDS}.
   */
  timedSeconds: number
  /**
   * Wall-clock ms at which the current run ends, or 0 when the group is shut.
   *
   * A deadline rather than a flag and a timer, because the thing that has to agree
   * about it is the DMX engine in another process: it reads this state every frame and
   * can simply compare, where a `setTimeout` living in one window would leave the other
   * to guess — and would strand the gate open if the window holding it went away.
   *
   * `Date.now()` rather than `performance.now()` for the same reason: the engine's
   * monotonic clock starts at a different epoch in each process, so only the wall clock
   * means the same thing on both sides. {@link isGroupTimedActive} is the only thing
   * that should read this; it carries the guard for a clock that moves underneath.
   */
  timedUntilMs: number
  /**
   * Flash the Go button — and the pad it is mapped to — once this many seconds have
   * passed since it was last pressed. 0 is off.
   *
   * A nag rather than an alarm: hazer output falls off over a few minutes and the
   * operator has no other way to notice, so the control that fixes it asks to be
   * pressed instead of waiting to be remembered. It reports on the button itself
   * because that is the thing the answer is: nothing else has to be found or read.
   */
  timedReminderSeconds: number
  /**
   * Wall-clock ms of the last press of Go, or 0 when it has not been pressed.
   *
   * Zero deliberately disarms the reminder rather than reading as "overdue since the
   * epoch": a project reopens with this cleared, and a pad flashing the moment a show
   * is loaded — before anyone has touched anything — is noise, not a reminder. The
   * first press starts the cycle, as does setting the reminder while the gate is on.
   *
   * Same clock and the same cross-process reasoning as {@link timedUntilMs}.
   */
  timedLastFiredAtMs: number
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
    discoBall: 0,
    goboEnabled: false,
    gobo: 0,
    prism: 0,
    prismSpeed: 0,
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
    blackoutActive: false,
    blackoutHeld: false,
    blackoutLocked: false,
    releaseHeld: false,
    releaseUsedForLock: false,
    followMasterHotkeys: true,
    overrideScene: false,
    timedEnabled: false,
    timedSeconds: DEFAULT_TIMED_SECONDS,
    timedUntilMs: 0,
    timedReminderSeconds: 0,
    timedLastFiredAtMs: 0,
  }
}

export const DEFAULT_TIMED_SECONDS = 5
export const MIN_TIMED_SECONDS = 0.5
export const MAX_TIMED_SECONDS = 600

export function clampGroupTimedSeconds(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_TIMED_SECONDS
  return Math.min(MAX_TIMED_SECONDS, Math.max(MIN_TIMED_SECONDS, value))
}

export const MIN_TIMED_REMINDER_SECONDS = 1
export const MAX_TIMED_REMINDER_SECONDS = 3600

/** 0 means off; anything else is pulled into the usable range. */
export function clampGroupTimedReminderSeconds(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0
  return Math.min(
    MAX_TIMED_REMINDER_SECONDS,
    Math.max(MIN_TIMED_REMINDER_SECONDS, value)
  )
}

/**
 * Half the flash period, so the on-screen button and the pad lamp blink together.
 *
 * The lamp can only be told "on" or "off", so its flashing has to be a function of the
 * clock rather than a CSS animation, and this is the quantum both sides round to.
 */
export const TIMED_FLASH_HALF_PERIOD_MS = 500

/** Which half of the flash cycle `nowMs` falls in. */
export function timedFlashPhaseOn(nowMs: number): boolean {
  return Math.floor(nowMs / TIMED_FLASH_HALF_PERIOD_MS) % 2 === 0
}

/**
 * How far past the deadline a clock jump is tolerated before the gate is called shut.
 *
 * The wall clock can move under a running gate — an NTP correction, a laptop waking up
 * — and a jump backwards would otherwise leave a fogger running for however long the
 * clock lost. Anything claiming more time left than a full run could ever have is read
 * as a jump and shut, so the damage from a moving clock is always in the safe
 * direction: the gate closes early rather than late.
 */
const TIMED_CLOCK_SLACK_MS = 1000

/** Whether this group's timed gate is open right now. */
export function isGroupTimedActive(
  control: GroupControl | null | undefined,
  nowMs: number
): boolean {
  if (control === null || control === undefined) return false
  if (control.timedEnabled !== true) return false
  const until = control.timedUntilMs
  if (!Number.isFinite(until) || until <= 0) return false
  const remaining = until - nowMs
  if (remaining <= 0) return false
  const runMs = clampGroupTimedSeconds(control.timedSeconds) * 1000
  return remaining <= runMs + TIMED_CLOCK_SLACK_MS
}

/**
 * Whether this group's reminder is running — configured, and with a press to count from.
 *
 * Armed is not the same as overdue: an armed reminder is the reason to keep looking at
 * the clock at all, which is what the lamp refresh needs to know.
 */
export function isGroupTimedReminderArmed(
  control: GroupControl | null | undefined
): boolean {
  if (control === null || control === undefined) return false
  if (control.timedEnabled !== true) return false
  if (!Number.isFinite(control.timedReminderSeconds)) return false
  if (control.timedReminderSeconds <= 0) return false
  return Number.isFinite(control.timedLastFiredAtMs) && control.timedLastFiredAtMs > 0
}

/** Whether this group's Go button is asking to be pressed. */
export function isGroupTimedOverdue(
  control: GroupControl | null | undefined,
  nowMs: number
): boolean {
  if (!isGroupTimedReminderArmed(control)) return false
  // A gate that is running was pressed to start it, so it is never also overdue —
  // and a button already lit solid has nothing left to say by flashing.
  if (isGroupTimedActive(control, nowMs)) return false
  const since = nowMs - (control as GroupControl).timedLastFiredAtMs
  // A clock that moved backwards under us is no reason to nag; wait for it to catch up.
  if (!Number.isFinite(since) || since < 0) return false
  return since >= (control as GroupControl).timedReminderSeconds * 1000
}

/** Seconds since Go was last pressed, or 0 when it never has been. For the tooltip. */
export function groupTimedSinceLastFiredMs(
  control: GroupControl | null | undefined,
  nowMs: number
): number {
  const lastFired = control?.timedLastFiredAtMs
  if (!Number.isFinite(lastFired) || (lastFired as number) <= 0) return 0
  return Math.max(0, nowMs - (lastFired as number))
}

/** Whether any group's reminder is running, so the lamps have to keep being asked. */
export function anyGroupTimedReminderArmed(
  state: GroupControlState | null | undefined
): boolean {
  const byGroup = safeByGroup(state)
  for (const control of Object.values(byGroup)) {
    if (isGroupTimedReminderArmed(control)) return true
  }
  return false
}

/**
 * Whether any group's timed gate is open right now.
 *
 * A gate closes because a deadline passed, not because anything dispatched, so the
 * things that only refresh on a state change — the controller lamps above all — have to
 * be told to look again while one is running, and once more on the way down.
 *
 * Asked against the clock rather than off `timedUntilMs` alone: an expired deadline is
 * left in state until something clears it, so a "has a deadline" test would stay true
 * for the rest of the session after a single run.
 */
export function anyGroupTimedActive(
  state: GroupControlState | null | undefined,
  nowMs: number
): boolean {
  const byGroup = safeByGroup(state)
  for (const control of Object.values(byGroup)) {
    if (isGroupTimedActive(control, nowMs)) return true
  }
  return false
}

/** Milliseconds left on an open gate, or 0 when it is shut. For the countdown. */
export function groupTimedRemainingMs(
  control: GroupControl | null | undefined,
  nowMs: number
): number {
  if (!isGroupTimedActive(control, nowMs)) return 0
  return Math.max(0, (control as GroupControl).timedUntilMs - nowMs)
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

/**
 * Dead travel at the bottom of the disco fader, as a fraction of its throw.
 *
 * The other two faders are safe to knock — brightness only trims a level and strobe
 * is inert until Flash arms it. This one physically swings heads across the room, so
 * it takes a deliberate push to leave zero, and a controller that spills its fader
 * positions when it connects lands harmlessly inside the dead band.
 */
export const DISCO_BALL_DEAD_ZONE = 0.1

/** Where the fader is sitting, dead zone included. For drawing the cap. */
export function groupDiscoBallPosition(
  control: GroupControl | null | undefined
): number {
  const position = control?.discoBall
  if (!Number.isFinite(position)) return 0
  return Math.min(1, Math.max(0, position as number))
}

/**
 * How far this group's movers are actually pulled onto the ball. 0 = not at all.
 *
 * The live travel above the dead zone is rescaled across the full 0..1 blend, so the
 * top of the fader still means locked on rather than 90% of the way there.
 */
export function groupDiscoBallLevel(
  control: GroupControl | null | undefined
): number {
  const position = groupDiscoBallPosition(control)
  if (position <= DISCO_BALL_DEAD_ZONE) return 0
  return (position - DISCO_BALL_DEAD_ZONE) / (1 - DISCO_BALL_DEAD_ZONE)
}

/** Disco ball inside its dead zone is the released state. */
export function isGroupDiscoBallActive(
  control: GroupControl | null | undefined
): boolean {
  return groupDiscoBallLevel(control) > 0
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
    // Same for a timed group: shut is not idle, it is holding its lights at nothing.
    control.timedEnabled === true ||
    isGroupBrightnessActive(control) ||
    isGroupDiscoBallActive(control) ||
    control.goboEnabled === true ||
    control.strobeEnabled === true ||
    control.exclusiveEnabled === true ||
    control.blinderActive === true ||
    control.blackoutActive === true
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

/** Group names currently blacked out, in stable order. */
export function blackedOutGroupNames(
  state: GroupControlState | null | undefined
): string[] {
  const byGroup = safeByGroup(state)
  return Object.keys(byGroup)
    .filter((group) => byGroup[group]?.blackoutActive === true)
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
 * Which *light* a partition belongs to — the unit a blackout has to reach all of.
 *
 * `flatten_fixture` cuts every fixture into partitions by channel family, so a head's
 * pan/tilt, its dimmer and its emitters are three separate entries sharing one
 * `fixtureId`. A subfixture is a light in its own right, though: it can be put in a
 * group on its own, so it keeps its own key rather than folding into the parent's.
 *
 * Null for a fixture with no id, which can only be matched partition by partition.
 */
function lightKeyOf(fixture: FlattenedFixture): string | null {
  const id = fixture.fixtureId?.trim()
  if (id === undefined || id.length === 0) return null
  return `${id}\u0000${fixture.subFixtureIndex ?? -1}`
}

/**
 * Hold the blacked-out groups dark.
 *
 * Membership is resolved per light rather than per partition, the mirror of the solo
 * blackout above and for the same reason: a virtual group like `Movers` matches only
 * the partition carrying pan/tilt, and darkening that one alone would write nothing at
 * all — the dimmer and the emitters live in partitions of their own. Resolving per
 * *light* rather than per fixture is what keeps a group naming one head of a bar from
 * blacking out the whole bar.
 *
 * Written after the solo, so a blacked-out group stays dark even when it is the group
 * being soloed: the operator asked for both, and only one of them can be honoured.
 * Nothing is stored — drop the blackout and the scene shows through again.
 */
function applyGroupBlackout(
  channels: number[],
  universeFixtures: FlattenedFixture[],
  groupControl: GroupControlState | null | undefined
): void {
  const groups = blackedOutGroupNames(groupControl)
  if (groups.length === 0) return

  const darkPartitions = new Set<FlattenedFixture>()
  const darkLights = new Set<string>()
  const fixturesInGroup = fixturesByGroupName(universeFixtures, groups)
  for (const group of groups) {
    for (const fixture of fixturesInGroup.get(group) ?? []) {
      darkPartitions.add(fixture)
      const key = lightKeyOf(fixture)
      if (key !== null) darkLights.add(key)
    }
  }

  for (const fixture of universeFixtures) {
    if (!darkPartitions.has(fixture)) {
      const key = lightKeyOf(fixture)
      if (key === null || !darkLights.has(key)) continue
    }
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
 * Where this axis channel can legally sit, low end first.
 *
 * A fixture profile can hold a reversed range (`max` below `min`) to flip a head, so
 * the bounds cannot be read off the field names.
 */
function axisChannelBounds(channel: ChannelAxis): { low: number; high: number } {
  const min = Number.isFinite(channel.min) ? channel.min : DMX_MIN_VALUE
  const max = Number.isFinite(channel.max) ? channel.max : DMX_MAX_VALUE
  return { low: Math.min(min, max), high: Math.max(min, max) }
}

/** Slot 0 of a gobo or prism map — "Open" / "Off" on every profile that lists one. */
function firstWheelSlotDmx(channel: FixtureChannel): number | null {
  if (channel.type === 'goboMap') {
    if (channel.gobos.length <= 0) return null
    return getIndexedMapSlotOutputDmx(channel.gobos, 0)
  }
  if (channel.type === 'prismMap') {
    if (channel.prisms.length <= 0) return null
    return getIndexedMapSlotOutputDmx(channel.prisms, 0)
  }
  return null
}

/**
 * What to write to clear this channel's gobo and prism wheels, or null if it drives
 * neither.
 *
 * Clear is slot 0 — the same slot a scene's gobo or prism fader selects at the bottom
 * of its travel — emitted mid-range rather than at its edge, and clamped into its own
 * band when the wheel shares a channel with something else.
 */
function clearWheelValueOf(channel: FixtureChannel): number | null {
  const direct = firstWheelSlotDmx(channel)
  if (direct !== null) return direct

  if (channel.type === 'split') {
    for (const range of channel.ranges) {
      const nested = firstWheelSlotDmx(range.channel)
      if (nested === null) continue
      return Math.min(range.max, Math.max(range.min, nested))
    }
  }
  return null
}

/**
 * Slide every mover in a disco-balled group from the aim the scene gave it onto its
 * own mirror-ball aim, clearing its gobo and prism on the way.
 *
 * Blended on the wire rather than back in the scene's pad maths, for the same reason
 * the rest of this file works here: the fader has to reach movers the active scene
 * never addresses, and it has to mean the same thing whatever produced the aim it is
 * pulling away from — a split's pad, phase-offset follow, the Movers page override.
 *
 * Interpolation is per axis in DMX, which is what "halfway to the ball" has to mean
 * for a head: pan and tilt each cross half the distance, so the beam sweeps an arc
 * onto the ball rather than tracking a line across the room. The wheels do not
 * interpolate — a gobo or prism has no half-position — so they snap to their first
 * slot the moment the fader leaves its dead zone and stay there until it comes back.
 * Only heads with an aim captured for them are touched at all: one that is not going
 * to the ball keeps the gobo and prism the scene gave it.
 */
function applyDiscoBallAim(
  channels: number[],
  universeFixtures: FlattenedFixture[],
  groupControl: GroupControlState | null | undefined,
  /** Head currently being aimed by hand on the Movers page, if any. */
  calibratingFixtureId: string | undefined
): void {
  const byGroup = safeByGroup(groupControl)
  const discoGroups = Object.keys(byGroup).filter((group) =>
    isGroupDiscoBallActive(byGroup[group])
  )
  if (discoGroups.length === 0) return

  const fixturesInGroup = fixturesByGroupName(universeFixtures, discoGroups)
  const levelByFixture = new Map<FlattenedFixture, number>()

  for (const group of discoGroups) {
    const level = groupDiscoBallLevel(byGroup[group])
    for (const fixture of fixturesInGroup.get(group) ?? []) {
      // A head in two disco-balled groups follows whichever fader is further up, the
      // same way overlapping brightness faders resolve.
      levelByFixture.set(
        fixture,
        Math.max(levelByFixture.get(fixture) ?? 0, level)
      )
    }
  }

  for (const [fixture, level] of levelByFixture) {
    const aim = fixture.moverDiscoBall
    if (aim === null || aim === undefined) continue
    // The head on the calibration dialog is being pointed somewhere deliberately;
    // dragging it part-way to the ball would fight the operator sighting it.
    if (
      calibratingFixtureId !== undefined &&
      fixture.fixtureId === calibratingFixtureId
    ) {
      continue
    }

    for (const [channelIdx, channel] of fixture.channels) {
      if (channel.type !== 'axis') {
        const clearWheel = clearWheelValueOf(channel)
        if (clearWheel !== null) writeChannel(channels, channelIdx, clearWheel)
        continue
      }

      if (channel.isFine) {
        // Coarse owns the blend, so park fine rather than leaving a 16-bit head
        // carrying residue from wherever the scene had it.
        writeChannel(channels, channelIdx, channel.min)
        continue
      }

      const rawTarget = channel.dir === 'x' ? aim.pan : aim.tilt
      if (!Number.isFinite(rawTarget)) continue

      const { low, high } = axisChannelBounds(channel)
      const target = Math.min(high, Math.max(low, rawTarget))
      const current = readChannel(channels, channelIdx)
      writeChannel(channels, channelIdx, current + (target - current) * level)
    }
  }
}

/** Nearest slot for a 0..1 fader across `count` evenly spaced detents. */
export function wheelSlotIndex(value: number, count: number): number {
  if (count <= 1) return 0
  return Math.min(count - 1, Math.max(0, Math.round(clamp01(value) * (count - 1))))
}

/**
 * True for a custom channel that spins the prism rather than selecting one.
 *
 * Prism rotation has no channel type of its own — profiles carry it as a named custom
 * channel — so it has to be found by name, the same way the Atmosphere group finds
 * its fog and haze channels.
 */
function isPrismRotationChannel(channel: FixtureChannel): boolean {
  if (channel.type !== 'custom') return false
  const name = channel.name.trim().toLowerCase()
  if (!name.includes('prism')) return false
  return ['rot', 'spin', 'speed'].some((token) => name.includes(token))
}

/**
 * DMX this channel should carry while the group's wheel override is up, or null if it
 * drives no wheel.
 *
 * On a `split` channel the first range any of the three faders can address wins.
 * Profiles list ranges in DMX order, so on a channel carrying both prism slots and
 * prism rotation the slot selection is what the override reaches — the same single
 * choice the fixture itself forces on anyone driving that channel.
 */
function overrideWheelValueOf(
  channel: FixtureChannel,
  control: GroupControl
): number | null {
  if (channel.type === 'goboMap') {
    if (channel.gobos.length <= 0) return null
    return getIndexedMapSlotOutputDmx(
      channel.gobos,
      wheelSlotIndex(control.gobo, channel.gobos.length)
    )
  }
  if (channel.type === 'prismMap') {
    if (channel.prisms.length <= 0) return null
    return getIndexedMapSlotOutputDmx(
      channel.prisms,
      wheelSlotIndex(control.prism, channel.prisms.length)
    )
  }
  if (isPrismRotationChannel(channel) && channel.type === 'custom') {
    return channel.min + (channel.max - channel.min) * clamp01(control.prismSpeed)
  }
  if (channel.type === 'split') {
    for (const range of channel.ranges) {
      const nested = overrideWheelValueOf(range.channel, control)
      if (nested === null) continue
      return Math.min(range.max, Math.max(range.min, nested))
    }
  }
  return null
}

/**
 * Hand a group's gobo, prism and prism rotation to the operator's faders.
 *
 * Written last of the wheel writers, so an armed override beats the disco fader's
 * automatic clear: pulling heads onto the ball opens their gobos on its own, but an
 * operator who has explicitly dialled a gobo has said what they want and gets it,
 * ball or no ball.
 *
 * A fixture sitting in two armed groups follows the first by name. There is no
 * meaningful way to merge two wheel selections the way overlapping brightness faders
 * merge — a wheel is on one slot or another — so the rule is simply stable.
 */
function applyWheelOverride(
  channels: number[],
  universeFixtures: FlattenedFixture[],
  groupControl: GroupControlState | null | undefined
): void {
  const byGroup = safeByGroup(groupControl)
  const armedGroups = Object.keys(byGroup)
    .filter((group) => byGroup[group]?.goboEnabled === true)
    .sort()
  if (armedGroups.length === 0) return

  const fixturesInGroup = fixturesByGroupName(universeFixtures, armedGroups)
  const controlByFixture = new Map<FlattenedFixture, GroupControl>()

  for (const group of armedGroups) {
    const control = byGroup[group]
    if (control === null || control === undefined) continue
    for (const fixture of fixturesInGroup.get(group) ?? []) {
      if (!controlByFixture.has(fixture)) controlByFixture.set(fixture, control)
    }
  }

  for (const [fixture, control] of controlByFixture) {
    for (const [channelIdx, channel] of fixture.channels) {
      const value = overrideWheelValueOf(channel, control)
      if (value === null) continue
      writeChannel(channels, channelIdx, value)
    }
  }
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
 * Write one fixture's master/dimmer channels at `level`, leaving everything else alone.
 *
 * Deliberately narrower than `driveFixtureWhite`: the timed gate is a valve on a
 * fixture's output rather than a look. A fogger has a level channel and nothing else to
 * say, and on a group of lamps the scene keeps its colour and position while the gate
 * decides only whether they are on at all.
 *
 * A fixture with no dimmer has nowhere to put a level, so an open gate leaves it to the
 * scene — see {@link applyTimedGate}, which still holds it dark while the gate is shut.
 */
function driveFixtureMasterLevel(
  channels: number[],
  fixture: FlattenedFixture,
  level: number
): void {
  for (const [channelIdx, channel] of fixture.channels) {
    const master = masterRangeOf(channel)
    if (master === null) continue
    writeChannel(
      channels,
      channelIdx,
      master.isOnOff
        ? level > 0.5
          ? master.max
          : master.min
        : master.min + (master.max - master.min) * level
    )
  }
}

/**
 * Open or shut the timed groups.
 *
 * Shut, the group is held at nothing, the same write the Black button makes. Open, its
 * own fader drives the master channel directly — not scaled against the scene, because
 * the fixtures this is for are the ones no scene addresses: a fader scaling a scene
 * value of zero would leave a fogger dead at every position.
 *
 * Membership resolves per light, as the blackout does, so a gate on a virtual group
 * like `Movers` reaches the dimmer partition rather than only the one carrying pan and
 * tilt. A fixture gated by two timed groups is open if either is running and takes the
 * brighter level, the highest-takes-precedence rule the faders already use.
 *
 * Placed beside `applySceneOverrides`, before the master: a gate is one more way of
 * driving a group off its own fader, and the master dimmer trims it like the rest of
 * the rig. Solo, Black and the blinder all still land on top of it.
 */
function applyTimedGate(
  channels: number[],
  universeFixtures: FlattenedFixture[],
  groupControl: GroupControlState | null | undefined,
  nowMs: number
): void {
  const byGroup = safeByGroup(groupControl)
  const groups = Object.keys(byGroup)
    .filter((group) => byGroup[group]?.timedEnabled === true)
    .sort()
  if (groups.length === 0) return

  const levelByFixture = new Map<FlattenedFixture, number>()
  const levelByLight = new Map<string, number>()
  const fixturesInGroup = fixturesByGroupName(universeFixtures, groups)

  for (const group of groups) {
    const control = byGroup[group]
    if (control === null || control === undefined) continue
    // `effectiveGroupBrightness` rather than the raw fader, so Flash and Solo pull an
    // open gate to full the way they pull any other group.
    const level = isGroupTimedActive(control, nowMs)
      ? effectiveGroupBrightness(control)
      : 0
    for (const fixture of fixturesInGroup.get(group) ?? []) {
      const seen = levelByFixture.get(fixture)
      if (seen === undefined || level > seen) levelByFixture.set(fixture, level)
      const key = lightKeyOf(fixture)
      if (key === null) continue
      const seenLight = levelByLight.get(key)
      if (seenLight === undefined || level > seenLight) levelByLight.set(key, level)
    }
  }

  for (const fixture of universeFixtures) {
    let level = levelByFixture.get(fixture)
    if (level === undefined) {
      const key = lightKeyOf(fixture)
      if (key === null) continue
      level = levelByLight.get(key)
      if (level === undefined) continue
    }
    if (level <= 0) {
      blackoutFixtureIntensity(channels, fixture)
      continue
    }
    driveFixtureMasterLevel(channels, fixture, level)
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
  blinderLevels: { [group: string]: number } = {},
  options: {
    /** Head being aimed by hand on the Movers page — left out of the disco blend. */
    calibratingFixtureId?: string
    /**
     * Wall clock the timed gates are judged against, passed in so every universe in a
     * frame agrees on it. `Date.now()`, never `performance.now()` — see
     * `GroupControl.timedUntilMs`.
     */
    nowMs?: number
  } = {}
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

  // A timed group is driven off its own fader too, and held dark between runs.
  applyTimedGate(
    channels,
    universeFixtures,
    groupControl,
    options.nowMs ?? Date.now()
  )

  // The master layers on top of the per-group faders, never replacing them.
  applyMaster(channels, universeFixtures, groupControl)

  // Pan/tilt only, so it neither reads nor disturbs anything the level writers
  // above and below touch.
  applyDiscoBallAim(
    channels,
    universeFixtures,
    groupControl,
    options.calibratingFixtureId
  )

  // Last of the wheel writers, so a dialled gobo survives the disco fader's clear.
  applyWheelOverride(channels, universeFixtures, groupControl)

  // Solo wins over any level the faders above just set...
  applyExclusiveBlackout(channels, universeFixtures, groupControl)
  // ...a blacked-out group is dark even inside the solo that kept it...
  applyGroupBlackout(channels, universeFixtures, groupControl)
  // ...and the blinder wins over everything, either blackout included.
  applyBlinder(channels, universeFixtures, groupControl, blinderLevels)
}

/** One wheel a group's fixtures carry, and what its slots are called. */
export interface GroupWheel {
  /** Slots on the widest wheel in the group, or 0 when no fixture has one. */
  slotCount: number
  /** Slot names off that same wheel, for the fader readout. */
  labels: string[]
}

/** What the wheel override can reach on one group, for laying out its card. */
export interface GroupWheelSupport {
  gobo: GroupWheel
  prism: GroupWheel
  /** Whether any fixture carries a prism rotation channel. */
  hasPrismSpeed: boolean
}

function emptyWheel(): GroupWheel {
  return { slotCount: 0, labels: [] }
}

function readWheelSlots(
  wheel: GroupWheel,
  items: Array<{ name: string }>,
  fallbackPrefix: string
): void {
  // Widest wheel wins, matching the scene's gobo and prism faders: a fader with a
  // detent per slot has to have one for every slot some fixture in the group can
  // reach, and narrower wheels resolve the same 0..1 against their own list.
  if (items.length <= wheel.slotCount) return
  wheel.slotCount = items.length
  wheel.labels = items.map((item, index) => {
    const name = item.name.trim()
    return name.length > 0 ? name : `${fallbackPrefix} ${index + 1}`
  })
}

function collectWheels(channel: FixtureChannel, support: GroupWheelSupport): void {
  if (channel.type === 'goboMap') {
    readWheelSlots(support.gobo, channel.gobos, 'Gobo')
    return
  }
  if (channel.type === 'prismMap') {
    readWheelSlots(support.prism, channel.prisms, 'Prism')
    return
  }
  if (isPrismRotationChannel(channel)) {
    support.hasPrismSpeed = true
    return
  }
  if (channel.type === 'split') {
    for (const range of channel.ranges) collectWheels(range.channel, support)
  }
}

/** Which wheel faders a group's card should show, and how they are labelled. */
export function describeGroupWheels(
  fixtures: FlattenedFixture[],
  group: string
): GroupWheelSupport {
  const support: GroupWheelSupport = {
    gobo: emptyWheel(),
    prism: emptyWheel(),
    hasPrismSpeed: false,
  }
  for (const fixture of getFixturesInGroups(fixtures, { [group]: true })) {
    for (const [, channel] of fixture.channels) collectWheels(channel, support)
  }
  return support
}

/**
 * How many heads in this group the disco fader would actually move, for the UI.
 *
 * Counts heads with an aim captured for them rather than movers in general: a card
 * whose movers have never been pointed at the ball has a fader that does nothing, and
 * the count is what says so.
 */
export function countDiscoBallAimedFixturesInGroup(
  fixtures: FlattenedFixture[],
  group: string
): number {
  const ids = new Set<string>()
  let unnamed = 0
  for (const fixture of getFixturesInGroups(fixtures, { [group]: true })) {
    if (fixture.moverDiscoBall === null || fixture.moverDiscoBall === undefined) {
      continue
    }
    if (!fixture.channels.some(([, channel]) => channel.type === 'axis')) {
      continue
    }
    const id = fixture.fixtureId?.trim()
    if (id === undefined || id.length === 0) {
      unnamed += 1
      continue
    }
    ids.add(id)
  }
  return ids.size + unnamed
}

/** Whether this group holds any pan/tilt head at all, aimed at the ball or not. */
export function groupHasMovers(
  fixtures: FlattenedFixture[],
  group: string
): boolean {
  for (const fixture of getFixturesInGroups(fixtures, { [group]: true })) {
    if (fixture.channels.some(([, channel]) => channel.type === 'axis')) {
      return true
    }
  }
  return false
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
