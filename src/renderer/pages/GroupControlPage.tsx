import styled, { keyframes, css } from 'styled-components'
import { useEffect, useMemo, useState } from 'react'
import { useDispatch } from 'react-redux'
import { Button } from '@mui/material'
import SliderBase from '../base/SliderBase'
import { ButtonMidiOverlay, SliderMidiOverlay } from '../base/MidiOverlay'
import { BriefTooltip } from '../base/appTooltip'
import StatusBar from '../menu/StatusBar'
import { useDmxSelector, useTypedSelector } from '../redux/store'
import {
  releaseAllLiveOverrides,
  releaseGroupStrobe,
  setGroupBrightness,
  setGroupDiscoBall,
  setGroupGobo,
  setGroupPrism,
  setGroupPrismSpeed,
  setGroupStrobe,
  setBlinderFadeBeats,
  setGroupFollowMasterHotkeys,
  setGroupOverrideScene,
  setMasterBrightness,
  toggleMasterBlinder,
  toggleMasterStrobe,
  toggleGroupBlinder,
  toggleGroupBlackout,
  toggleGroupExclusive,
  toggleGroupStrobeFlash,
  setGroupTimedEnabled,
  setGroupTimedSeconds,
  setGroupTimedReminderSeconds,
  fireGroupTimed,
} from '../redux/groupControlSlice'
import {
  countDiscoBallAimedFixturesInGroup,
  countFixturesInGroup,
  describeGroupWheels,
  DISCO_BALL_DEAD_ZONE,
  effectiveGroupBrightness,
  groupDiscoBallLevel,
  groupDiscoBallPosition,
  groupHasMovers,
  initGroupControl,
  isGroupBrightnessActive,
  isGroupBrightnessForcedFull,
  isGroupControlActive,
  isGroupDiscoBallActive,
  isGroupOverridingScene,
  isGroupTimedActive,
  isGroupTimedOverdue,
  isGroupTimedReminderArmed,
  groupTimedRemainingMs,
  groupTimedSinceLastFiredMs,
  clampGroupTimedSeconds,
  clampGroupTimedReminderSeconds,
  MIN_TIMED_SECONDS,
  MAX_TIMED_SECONDS,
  MAX_TIMED_REMINDER_SECONDS,
  TIMED_FLASH_HALF_PERIOD_MS,
  wheelSlotIndex,
  type GroupControl,
  type GroupWheel,
  type GroupWheelSupport,
} from '../../shared/groupControl'
import { flatten_fixtures, getSortedGroupsFromPlacedFixtures } from '../../shared/dmxUtil'
import type { SetGroupControlKind } from '../redux/deviceState'
import { DMX_MAX_VALUE, universeHasMovers } from '../../shared/dmxFixtures'

const FADER_RADIUS_REM = 0.5
/** Virtual group matched by pan/tilt channels rather than group assignment. */
const MOVERS_GROUP = 'Movers'
const BLINDER_FADE_OPTIONS = [0, 0.25, 0.5, 1, 2, 4, 8]
/**
 * Shared fallback for groups with no state yet. Must be a stable reference: building
 * one per selector call makes every untouched card re-render on every store action.
 */
const EMPTY_GROUP_CONTROL: GroupControl = Object.freeze(initGroupControl())

/**
 * A clock that runs only while this card's gate has something to count.
 *
 * Both of the gate's states change without anything being dispatched — a run ends
 * because a deadline passed, a reminder comes due because enough time went by — so
 * without a tick the countdown would freeze and the button would never start flashing.
 *
 * Reseeded whenever the deadline changes, so the first render after a press is judged
 * against a fresh reading rather than whenever this card last happened to tick. A
 * running gate is followed closely enough for a countdown; an armed reminder only needs
 * the flash quantum, and a card with neither stops ticking altogether.
 */
function useTimedGateNow(control: GroupControl): number {
  const until = control.timedUntilMs
  const [nowMs, setNowMs] = useState(() => Date.now())

  useEffect(() => {
    setNowMs(Date.now())
  }, [until])

  const running = isGroupTimedActive(control, nowMs)
  const intervalMs = running
    ? 100
    : isGroupTimedReminderArmed(control)
    ? TIMED_FLASH_HALF_PERIOD_MS
    : 0
  useEffect(() => {
    if (intervalMs === 0) return
    const handle = setInterval(() => setNowMs(Date.now()), intervalMs)
    return () => clearInterval(handle)
  }, [intervalMs])

  return nowMs
}

/** MIDI binding for one fader on a group card. */
type MidiFaderAction = {
  type: 'setGroupControl'
  group: string
  control: SetGroupControlKind
}
/** Same stable-reference reasoning as `EMPTY_GROUP_CONTROL`. */
const EMPTY_WHEELS: GroupWheelSupport = Object.freeze({
  gobo: { slotCount: 0, labels: [] },
  prism: { slotCount: 0, labels: [] },
  hasPrismSpeed: false,
})

export default function GroupControlPage({
  hideStatusBar = false,
}: {
  hideStatusBar?: boolean
}) {
  // Select the stable slice references and derive below, so the page does not
  // re-render on every unrelated store action.
  const universe = useDmxSelector((dmx) => dmx.universe)
  const fixtureTypesByID = useDmxSelector((dmx) => dmx.fixtureTypesByID)
  const moverGroupByFixtureId = useDmxSelector((dmx) => dmx.moverGroupByFixtureId)

  const flattened = useMemo(
    () => flatten_fixtures(universe, fixtureTypesByID, moverGroupByFixtureId),
    [universe, fixtureTypesByID, moverGroupByFixtureId]
  )

  const groups = useMemo(() => {
    const names = new Set(
      getSortedGroupsFromPlacedFixtures(universe, fixtureTypesByID)
    )
    // `Movers` is a system group: fixtures land in it by having pan/tilt, not by
    // being assigned to it, so the fixture-group picker never lists it. The split
    // group picker surfaces it the same way.
    if (universeHasMovers(universe, fixtureTypesByID)) {
      names.add(MOVERS_GROUP)
    }
    return [...names].sort((a, b) =>
      a.localeCompare(b, undefined, { sensitivity: 'base' })
    )
  }, [universe, fixtureTypesByID])

  const fixtureCountByGroup = useMemo(() => {
    const counts: { [group: string]: number } = {}
    for (const group of groups) {
      counts[group] = countFixturesInGroup(flattened, group)
    }
    return counts
  }, [groups, flattened])

  // The disco fader only earns its place on cards holding movers, and only says
  // something useful once those heads have been aimed at the ball.
  const discoBallByGroup = useMemo(() => {
    const info: { [group: string]: { hasMovers: boolean; aimedCount: number } } = {}
    for (const group of groups) {
      info[group] = {
        hasMovers: groupHasMovers(flattened, group),
        aimedCount: countDiscoBallAimedFixturesInGroup(flattened, group),
      }
    }
    return info
  }, [groups, flattened])

  // Wheel faders appear only where there is a wheel to turn, so a card of pars keeps
  // the two faders it has always had.
  const wheelsByGroup = useMemo(() => {
    const info: { [group: string]: GroupWheelSupport } = {}
    for (const group of groups) {
      info[group] = describeGroupWheels(flattened, group)
    }
    return info
  }, [groups, flattened])

  return (
    <Root>
      {!hideStatusBar ? <StatusBar /> : null}
      <Header groupCount={groups.length} />
      <MasterBar />
      {groups.length === 0 ? (
        <EmptyState>
          No fixture groups yet. Assign groups to your fixtures on the Universe page
          and they will appear here.
        </EmptyState>
      ) : (
        <GroupGrid>
          {groups.map((group) => (
            <GroupCard
              key={group}
              group={group}
              fixtureCount={fixtureCountByGroup[group] ?? 0}
              hasMovers={discoBallByGroup[group]?.hasMovers === true}
              discoBallAimedCount={discoBallByGroup[group]?.aimedCount ?? 0}
              wheels={wheelsByGroup[group] ?? EMPTY_WHEELS}
            />
          ))}
        </GroupGrid>
      )}
    </Root>
  )
}

function Header({ groupCount }: { groupCount: number }) {
  const dispatch = useDispatch()
  const activeCount = useTypedSelector(
    (state) =>
      Object.values(state.groupControl.byGroup).filter((control) =>
        isGroupControlActive(control)
      ).length
  )
  const blinderFadeBeats = useTypedSelector(
    (state) => state.groupControl.blinderFadeBeats
  )
  const liveCount = useTypedSelector(
    (state) =>
      Object.values(state.groupControl.byGroup).filter(
        (control) =>
          control?.strobeEnabled === true ||
          control?.exclusiveEnabled === true ||
          control?.blinderActive === true ||
          control?.blackoutActive === true ||
          // A deadline still outstanding, judged without a clock: this only decides
          // whether Release all is enabled, and clearing a gate that has just shut on
          // its own costs nothing.
          (control?.timedEnabled === true && (control?.timedUntilMs ?? 0) > 0)
      ).length
  )
  // Selected as a joined string, not an array: a fresh array compares unequal every
  // time and would re-render the header on every action in the app.
  const soloGroupKey = useTypedSelector((state) =>
    Object.entries(state.groupControl.byGroup)
      .filter(([, control]) => control?.exclusiveEnabled === true)
      .map(([group]) => group)
      .sort()
      .join('\n')
  )
  const soloGroups = useMemo(
    () => (soloGroupKey.length === 0 ? [] : soloGroupKey.split('\n')),
    [soloGroupKey]
  )
  // Same joined-string trick, and worth the second selector: a locked blackout is the
  // one override a scene change leaves standing, so the page has to say so rather than
  // leaving a dead group to be discovered from the room.
  const blackoutGroupKey = useTypedSelector((state) =>
    Object.entries(state.groupControl.byGroup)
      .filter(([, control]) => control?.blackoutActive === true)
      .map(([group]) => group)
      .sort()
      .join('\n')
  )
  const blackoutGroups = useMemo(
    () => (blackoutGroupKey.length === 0 ? [] : blackoutGroupKey.split('\n')),
    [blackoutGroupKey]
  )

  return (
    <HeaderRoot>
      <HeaderTitleRow>
        <HeaderTitle>Group Control</HeaderTitle>
        <HeaderSubtitle>
          Brightness scales against the scene, strobe overrides it — {groupCount} group
          {groupCount === 1 ? '' : 's'}
          {activeCount > 0 ? `, ${activeCount} active` : ''}
        </HeaderSubtitle>
      </HeaderTitleRow>
      <BlinderSpeedCluster>
        <BlinderSpeedLabel>Blinder fade</BlinderSpeedLabel>
        <BriefTooltip title="How long a blinder takes to fade out after you let go. Shared by every group.">
          <BlinderSpeedSelect
            value={blinderFadeBeats}
            onChange={(event) =>
              dispatch(setBlinderFadeBeats(Number(event.target.value)))
            }
            aria-label="Blinder fade-out length in beats"
          >
            {BLINDER_FADE_OPTIONS.map((beats) => (
              <option key={beats} value={beats}>
                {beats === 0
                  ? 'instant'
                  : `${beats < 1 ? `1/${Math.round(1 / beats)}` : beats} beat${
                      beats === 1 ? '' : 's'
                    }`}
              </option>
            ))}
          </BlinderSpeedSelect>
        </BriefTooltip>
      </BlinderSpeedCluster>
      {soloGroups.length > 0 ? (
        <SoloWarning title={`Soloing: ${soloGroups.join(', ')} — everything else is held dark`}>
          SOLO: {soloGroups.join(', ')}
        </SoloWarning>
      ) : null}
      {blackoutGroups.length > 0 ? (
        <BlackoutWarning
          title={`Blacked out: ${blackoutGroups.join(
            ', '
          )} — held dark, and a locked blackout stays down across scene changes until you Release it`}
        >
          BLACK: {blackoutGroups.join(', ')}
        </BlackoutWarning>
      ) : null}
      <ButtonMidiOverlay action={{ type: 'releaseAllGroupOverrides' }}>
        <BriefTooltip title="Drop every live override on every group — strobes, solos, blinders, blackouts, running timed gates and any locks holding them. Brightness trims are left alone. Assign it to a MIDI pad: this is the panic button.">
          <span>
            <Button
              disabled={liveCount === 0}
              variant="contained"
              size="small"
              color={soloGroups.length > 0 ? 'warning' : 'primary'}
              onClick={() => dispatch(releaseAllLiveOverrides())}
            >
              Release all
            </Button>
          </span>
        </BriefTooltip>
      </ButtonMidiOverlay>
    </HeaderRoot>
  )
}

function MasterBar() {
  const dispatch = useDispatch()
  const master = useTypedSelector((state) => state.groupControl.master)
  const exemptGroupKey = useTypedSelector((state) =>
    Object.entries(state.groupControl.byGroup)
      .filter(([, control]) => control?.followMasterHotkeys === false)
      .map(([group]) => group)
      .sort()
      .join('\n')
  )
  const exemptGroups = useMemo(
    () => (exemptGroupKey.length === 0 ? [] : exemptGroupKey.split('\n')),
    [exemptGroupKey]
  )

  return (
    <MasterRoot>
      <MasterTitle>MASTER</MasterTitle>

      <MasterFaderCluster>
        <MasterLabel>Dimmer</MasterLabel>
        <SliderMidiOverlay
          action={{ type: 'setGroupMasterDimmer' }}
          style={{ width: '9rem', height: '1.4rem' }}
        >
          <BriefTooltip title="Trims the whole rig — layered on top of each group's own dimmer, so 50% here under a group at 50% gives 25%. Reaches every group, including any that ignore the master hotkeys.">
            <MasterTrack>
              <SliderBase
                radius={0.42}
                orientation="horizontal"
                onChange={(value) => dispatch(setMasterBrightness(value))}
                ariaLabel="Master dimmer"
              >
                <MasterCap
                  $dim={master.brightness < 1}
                  style={{ left: `${master.brightness * 100}%` }}
                  aria-hidden
                />
              </SliderBase>
            </MasterTrack>
          </BriefTooltip>
        </SliderMidiOverlay>
        <MasterReadout $dim={master.brightness < 1}>
          {Math.round(master.brightness * 100)}%
        </MasterReadout>
      </MasterFaderCluster>

      <ButtonMidiOverlay action={{ type: 'setGroupMasterBlinder' }}>
        <BriefTooltip title="Hold to blind every group that follows the master hotkeys. Assign to a MIDI pad.">
          <BlinderButton
            $active={master.blinderActive}
            size="small"
            onClick={() => dispatch(toggleMasterBlinder())}
          >
            Blind
          </BlinderButton>
        </BriefTooltip>
      </ButtonMidiOverlay>

      <ButtonMidiOverlay action={{ type: 'setGroupMasterStrobe' }}>
        <BriefTooltip title="Hold to fire the Flash on every group that follows the master hotkeys, each at its own level. Assign to a MIDI pad.">
          <FlashButton
            $active={master.strobeActive}
            size="small"
            onClick={() => dispatch(toggleMasterStrobe())}
          >
            Strobe
          </FlashButton>
        </BriefTooltip>
      </ButtonMidiOverlay>

      {exemptGroups.length > 0 ? (
        <MasterExempt
          title={`Ignoring the master strobe and blinder (the dimmer still applies): ${exemptGroups.join(
            ', '
          )}`}
        >
          no hotkeys: {exemptGroups.join(', ')}
        </MasterExempt>
      ) : null}
    </MasterRoot>
  )
}

function GroupCard({
  group,
  fixtureCount,
  hasMovers,
  discoBallAimedCount,
  wheels,
}: {
  group: string
  fixtureCount: number
  /** Whether the group holds any pan/tilt head, which is what the disco fader needs. */
  hasMovers: boolean
  /** Heads in the group with a mirror-ball aim captured for them. */
  discoBallAimedCount: number
  /** Gobo / prism wheels the group's fixtures carry, for the second fader row. */
  wheels: GroupWheelSupport
}) {
  const dispatch = useDispatch()
  const control: GroupControl = useTypedSelector(
    (state) => state.groupControl.byGroup[group] ?? EMPTY_GROUP_CONTROL
  )

  const isActive = isGroupControlActive(control)
  const locked =
    control.strobeLocked ||
    control.exclusiveLocked ||
    control.blinderLocked ||
    control.blackoutLocked
  const wheelsArmed = control.goboEnabled === true
  // Bright and Strobe are always there; everything else depends on what the group
  // holds. The card widens per fader rather than stacking a second row, so every
  // fader keeps a usable column and a card of pars stays the size it always was.
  const faderCount =
    2 +
    (hasMovers ? 1 : 0) +
    (wheels.gobo.slotCount > 0 ? 1 : 0) +
    (wheels.prism.slotCount > 0 ? 1 : 0) +
    (wheels.hasPrismSpeed ? 1 : 0)
  // Flash / Excl pull the group up to full while held; show that rather than the
  // fader's resting position, or the readout would contradict the lights.
  const brightnessForcedFull = isGroupBrightnessForcedFull(control)
  const overriding = isGroupOverridingScene(control)
  // The cap sits where the fader was left; the readout reports what the rig is
  // actually doing, so a fader parked in the dead zone reads 0%.
  const discoBallPosition = groupDiscoBallPosition(control)
  const discoBallLevel = groupDiscoBallLevel(control)
  const timedNowMs = useTimedGateNow(control)
  const timedRunning = isGroupTimedActive(control, timedNowMs)
  const timedRemainingMs = groupTimedRemainingMs(control, timedNowMs)
  const timedOverdue = isGroupTimedOverdue(control, timedNowMs)
  const timedSinceMs = groupTimedSinceLastFiredMs(control, timedNowMs)

  return (
    <Card $active={isActive} $faderCount={faderCount}>
      <CardHeader>
        <GroupName title={group}>
          {group}
          {group === MOVERS_GROUP ? <SystemTag>system</SystemTag> : null}
        </GroupName>
        <FixtureCount>
          {fixtureCount} fixture{fixtureCount === 1 ? '' : 's'}
        </FixtureCount>
      </CardHeader>

      <BriefTooltip title="Whether the master Blind and Strobe buttons reach this group. The master dimmer always applies.">
        <OptionRow>
          <OptionBox
            type="checkbox"
            checked={control.followMasterHotkeys !== false}
            onChange={(event) =>
              dispatch(
                setGroupFollowMasterHotkeys({
                  group,
                  follow: event.target.checked,
                })
              )
            }
            aria-label={`${group} follows the master hotkeys`}
          />
          <OptionLabel $alert={control.followMasterHotkeys === false}>
            follow master hotkeys
          </OptionLabel>
        </OptionRow>
      </BriefTooltip>

      <BriefTooltip title="Take this group off the scene and drive it straight from the fader below: dark at 0%, full white at 100%, whether or not any split addresses these fixtures. For lights you would rather not program, like house lights or a wash over the bar. The master dimmer still trims them, Solo still blacks them out, and Blind still wins.">
        <OptionRow>
          <OptionBox
            type="checkbox"
            checked={overriding}
            onChange={(event) =>
              dispatch(
                setGroupOverrideScene({
                  group,
                  override: event.target.checked,
                })
              )
            }
            aria-label={`${group} fader overrides the scene`}
          />
          <OptionLabel $alert={overriding}>fader overrides scene</OptionLabel>
        </OptionRow>
      </BriefTooltip>

      <BriefTooltip title="Gate this group behind a timed Go button: it is held dark until you fire it, runs from its own fader for the time set here, and shuts itself again. For the things you fire rather than programme — a fogger, a confetti blast — where being left running is the failure that matters. The fader drives the master/dimmer channel directly, so it works on fixtures no scene addresses.">
        <OptionRow>
          <OptionBox
            type="checkbox"
            checked={control.timedEnabled === true}
            onChange={(event) =>
              dispatch(
                setGroupTimedEnabled({
                  group,
                  enabled: event.target.checked,
                  nowMs: Date.now(),
                })
              )
            }
            aria-label={`${group} is gated by a timer`}
          />
          <OptionLabel $alert={control.timedEnabled === true}>
            timed gate
          </OptionLabel>
          {control.timedEnabled === true ? (
            <>
              <TimedSecondsInput
                type="number"
                min={MIN_TIMED_SECONDS}
                max={MAX_TIMED_SECONDS}
                step={0.5}
                value={control.timedSeconds}
                onChange={(event) =>
                  dispatch(
                    setGroupTimedSeconds({
                      group,
                      seconds: clampGroupTimedSeconds(Number(event.target.value)),
                    })
                  )
                }
                onClick={(event) => event.stopPropagation()}
                aria-label={`${group} timed run length in seconds`}
              />
              <OptionLabel $alert={false}>s</OptionLabel>
            </>
          ) : null}
        </OptionRow>
      </BriefTooltip>

      {control.timedEnabled === true ? (
        <BriefTooltip title="Flash the Go button, and any MIDI pad it is mapped to, once this long has passed since Go was last pressed. For output that fades without anything on screen saying so — a hazer needing a top-up between songs. 0 turns it off. The clock starts when you tick the gate on, or set this, and restarts on every press.">
          <OptionRow>
            <OptionLabel $alert={timedOverdue}>flash after</OptionLabel>
            <TimedSecondsInput
              type="number"
              min={0}
              max={MAX_TIMED_REMINDER_SECONDS}
              step={10}
              value={control.timedReminderSeconds}
              onChange={(event) =>
                dispatch(
                  setGroupTimedReminderSeconds({
                    group,
                    seconds: clampGroupTimedReminderSeconds(
                      Number(event.target.value)
                    ),
                    nowMs: Date.now(),
                  })
                )
              }
              onClick={(event) => event.stopPropagation()}
              aria-label={`${group} flashes Go after this many seconds`}
            />
            <OptionLabel $alert={false}>
              {control.timedReminderSeconds > 0 ? 's' : 's (off)'}
            </OptionLabel>
          </OptionRow>
        </BriefTooltip>
      ) : null}

      <FaderRow>
        <Fader
          // Two different jobs, so two different names: one scales the scene, the
          // other replaces it.
          label={overriding ? 'Level' : 'Bright'}
          readout={`${Math.round(effectiveGroupBrightness(control) * 100)}%${
            brightnessForcedFull ? '*' : ''
          }`}
          value={effectiveGroupBrightness(control)}
          enabled={
            overriding || brightnessForcedFull || isGroupBrightnessActive(control)
          }
          midiAction={{ type: 'setGroupControl', group, control: 'brightness' }}
          tooltip={
            overriding
              ? 'This group is off the scene: the fader drives it directly, from dark at 0% to full white at 100%, whether or not a split addresses these fixtures. Flash and Excl hold it at 100% while engaged (*).'
              : 'Scales the master/dimmer channel against the scene — 100% leaves it untouched, a scene at 0 stays dark, and fixtures without a dimmer are unaffected. Flash and Excl hold it at 100% while engaged (*).'
          }
          onChange={(value) => dispatch(setGroupBrightness({ group, value }))}
        />
        <Fader
          label="Strobe"
          // Parked at the level Flash will fire at while the strobe is down, so the
          // cap does not jump when it comes up — and bracketed to say it is not live.
          readout={
            control.strobeEnabled
              ? `${control.strobe}`
              : `(${control.strobeFlashLevel})`
          }
          value={
            (control.strobeEnabled ? control.strobe : control.strobeFlashLevel) /
            DMX_MAX_VALUE
          }
          enabled={control.strobeEnabled}
          midiAction={{ type: 'setGroupControl', group, control: 'strobe' }}
          tooltip="Raw DMX value written to this group's strobe channels (0–255). Only trims a strobe that is already up — Flash arms it, and locking Flash on (hold it, tap Release) keeps it up so this fader can be dialled with the pad let go."
          onChange={(value) =>
            dispatch(setGroupStrobe({ group, value: value * DMX_MAX_VALUE }))
          }
        />
        {hasMovers ? (
          <Fader
            label="Disco"
            readout={`${Math.round(discoBallLevel * 100)}%`}
            value={discoBallPosition}
            enabled={isGroupDiscoBallActive(control) && discoBallAimedCount > 0}
            midiAction={{ type: 'setGroupControl', group, control: 'discoBall' }}
            tooltip={
              discoBallAimedCount > 0
                ? `Pulls this group's movers off the scene's aim and onto the mirror ball: 0% leaves them alone, 100% locks them on it, and anything between sits them proportionally along the way. The gobo and prism clear as soon as it leaves 0; levels and colour stay with the scene. The bottom ${Math.round(
                    DISCO_BALL_DEAD_ZONE * 100
                  )}% of the throw is dead, so the heads cannot be swung by a knocked fader. ${discoBallAimedCount} head${
                    discoBallAimedCount === 1 ? '' : 's'
                  } aimed at the ball.`
                : 'No head in this group has been aimed at the mirror ball yet, so this fader does nothing. Open the Movers page, click a fixture, and capture its Disco Ball aim.'
            }
            onChange={(value) => dispatch(setGroupDiscoBall({ group, value }))}
          />
        ) : null}
        {wheels.gobo.slotCount > 0 ? (
          <WheelFader
            label="Gobo"
            wheel={wheels.gobo}
            value={control.gobo}
            armed={wheelsArmed}
            midiAction={{ type: 'setGroupControl', group, control: 'gobo' }}
            tooltip="Takes this group's wheels off the scene and picks the gobo itself. Moving this fader is what arms the override — there is no released position, because the bottom slot is a real gobo — and Release, Release all or the next light scene hands the wheels back and drops this fader to open. The Prism and Spin faders beside it fire with it, and keep their positions when it is released."
            onChange={(value) => dispatch(setGroupGobo({ group, value }))}
          />
        ) : null}
        {wheels.prism.slotCount > 0 ? (
          <WheelFader
            label="Prism"
            wheel={wheels.prism}
            value={control.prism}
            armed={wheelsArmed}
            midiAction={{ type: 'setGroupControl', group, control: 'prism' }}
            tooltip="Prism the wheel override fires at. It sets the value rather than arming anything, so dial it whenever you like — bracketed while the override is down, and live the moment the Gobo fader arms it."
            onChange={(value) => dispatch(setGroupPrism({ group, value }))}
          />
        ) : null}
        {wheels.hasPrismSpeed ? (
          <Fader
            label="Spin"
            readout={
              wheelsArmed
                ? `${Math.round(control.prismSpeed * 100)}%`
                : `(${Math.round(control.prismSpeed * 100)}%)`
            }
            value={control.prismSpeed}
            enabled={wheelsArmed}
            midiAction={{ type: 'setGroupControl', group, control: 'prismSpeed' }}
            tooltip="Prism rotation the wheel override fires at, across whatever the fixture's prism rotation channel covers. Like the Prism fader it only sets the value — the Gobo fader is what puts it on the rig."
            onChange={(value) => dispatch(setGroupPrismSpeed({ group, value }))}
          />
        ) : null}
      </FaderRow>

      <CardFooter>
        {control.timedEnabled === true ? (
          <ButtonMidiOverlay action={{ type: 'setGroupTimed', group }}>
            <BriefTooltip
              title={
                timedRunning
                  ? `Running — ${(timedRemainingMs / 1000).toFixed(
                      1
                    )}s left, then this group shuts on its own. Press again to stop it now.`
                  : timedOverdue
                  ? `Not fired for ${Math.round(
                      timedSinceMs / 1000
                    )}s — past the ${control.timedReminderSeconds}s reminder. Press to fire it for ${
                      control.timedSeconds
                    }s.`
                  : `Fire this group for ${control.timedSeconds}s, driven from its own fader, then shut it again. Held dark until you do. Assign to a MIDI pad.`
              }
            >
              <TimedButton
                $active={timedRunning}
                $overdue={timedOverdue}
                size="small"
                onClick={() =>
                  dispatch(fireGroupTimed({ group, nowMs: Date.now() }))
                }
              >
                {timedRunning
                  ? `${(timedRemainingMs / 1000).toFixed(1)}s`
                  : 'Go'}
              </TimedButton>
            </BriefTooltip>
          </ButtonMidiOverlay>
        ) : null}
        <ButtonMidiOverlay action={{ type: 'setGroupExclusive', group }}>
          <BriefTooltip
            title={
              control.exclusiveLocked
                ? 'Solo locked on: it stayed up when the pad was let go. Press Release to unlock and hand the rig back.'
                : 'Solo: hold everything outside this group dark. To lock it on, hold it and tap Release — or hold Release and press it. Assign to a MIDI pad to hold it momentarily.'
            }
          >
            <ExclusiveButton
              $active={control.exclusiveEnabled}
              $locked={control.exclusiveLocked}
              size="small"
              onClick={() => dispatch(toggleGroupExclusive(group))}
            >
              Excl
            </ExclusiveButton>
          </BriefTooltip>
        </ButtonMidiOverlay>
        <ButtonMidiOverlay action={{ type: 'setGroupBlinder', group }}>
          <BriefTooltip
            title={
              control.blinderLocked
                ? 'Blinder locked on: it stayed up when the pad was let go. Press Release to unlock and fade it out.'
                : 'Hold to blind: full pulsing white over the scene, whether or not the scene uses this group. To lock it on, hold it and tap Release — or hold Release and press it. Assign to a MIDI pad to hold it momentarily.'
            }
          >
            <BlinderButton
              $active={control.blinderActive}
              $locked={control.blinderLocked}
              size="small"
              onClick={() => dispatch(toggleGroupBlinder(group))}
            >
              Blind
            </BlinderButton>
          </BriefTooltip>
        </ButtonMidiOverlay>
        <ButtonMidiOverlay action={{ type: 'setGroupBlackout', group }}>
          <BriefTooltip
            title={
              control.blackoutLocked
                ? 'Blackout locked on: this group is dead and stays dead through scene changes, unlike the other locks. Press Release to hand it back.'
                : 'Hold to kill this group: every fixture in it goes dark whatever the scene, its own faders or a solo are doing. To lock it on, hold it and tap Release — or hold Release and press it; a locked blackout survives scene changes, so only Release or Release all takes it back. Assign to a MIDI pad to hold it momentarily.'
            }
          >
            <BlackoutButton
              $active={control.blackoutActive}
              $locked={control.blackoutLocked}
              size="small"
              onClick={() => dispatch(toggleGroupBlackout(group))}
            >
              Black
            </BlackoutButton>
          </BriefTooltip>
        </ButtonMidiOverlay>
        <ButtonMidiOverlay action={{ type: 'setGroupStrobeFlash', group }}>
          <BriefTooltip
            title={`Hold to strobe at ${control.strobeFlashLevel} DMX, let go to drop it. To lock it on, hold it and tap Release — or hold Release and press it. Assign to a MIDI pad to hold it momentarily.`}
          >
            <FlashButton
              $active={control.strobeEnabled}
              size="small"
              onClick={() => dispatch(toggleGroupStrobeFlash(group))}
            >
              Flash
            </FlashButton>
          </BriefTooltip>
        </ButtonMidiOverlay>
        <ButtonMidiOverlay action={{ type: 'releaseGroupStrobe', group }}>
          <BriefTooltip title={releaseTooltip(control)}>
            <ReleaseButton
              $armed={control.strobeEnabled || wheelsArmed || locked}
              $locked={locked}
              size="small"
              onClick={() => dispatch(releaseGroupStrobe(group))}
            >
              {locked ? 'Unlock' : 'Release'}
            </ReleaseButton>
          </BriefTooltip>
        </ButtonMidiOverlay>
      </CardFooter>
    </Card>
  )
}

/** "Strobe", "Strobe and Solo", "Strobe, Solo and Blind". */
function formatList(names: string[]): string {
  if (names.length < 2) return names.join('')
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
}

/**
 * Release carries three jobs — release, lock and unlock — so it has to say which one
 * the next press will do.
 */
function releaseTooltip(control: GroupControl): string {
  const lockedNames = [
    control.strobeLocked ? 'Strobe' : null,
    control.exclusiveLocked ? 'Solo' : null,
    control.blinderLocked ? 'Blind' : null,
    control.blackoutLocked ? 'Black' : null,
  ].filter((name): name is string => name !== null)

  if (lockedNames.length > 0) {
    return `${formatList(lockedNames)} locked on: still up with the pad let go. Tap to unlock and hand it back — or hold this and press another pad to add that one to the lock.${
      control.blackoutLocked
        ? ' A locked blackout is the one that outlives a scene change, so this is the only way it comes down.'
        : ''
    }`
  }
  if (control.goboEnabled === true) {
    return "Tap to hand this group's wheels and strobe back to the scene — the gobo goes back to whatever the scene is playing and the Gobo fader drops to open, while Prism and Spin keep their positions. Held on a pad it locks instead: anything pressed while it is down locks on, as does anything already held when you tap it. Assignable to a MIDI pad."
  }
  return "Tap to release this group's strobe back to the scene. Held on a pad it locks instead: anything pressed while it is down locks on, as does anything already held when you tap it. Assignable to a MIDI pad."
}

/**
 * A fader that lands on wheel slots rather than anywhere in its travel.
 *
 * Detented like the scene's own gobo and prism faders — the cap snaps to the nearest
 * slot and the readout names it, because "40%" says nothing about which gobo is in
 * the gate. Bracketed while the override is down, the way the strobe fader parks at
 * the level Flash will fire at.
 */
function WheelFader({
  label,
  wheel,
  value,
  armed,
  tooltip,
  midiAction,
  onChange,
}: {
  label: string
  wheel: GroupWheel
  /** Raw 0..1 fader value; snapped to a slot for display. */
  value: number
  /** Whether the wheel override is up, so this is reaching the rig. */
  armed: boolean
  tooltip: string
  midiAction: MidiFaderAction
  onChange: (value: number) => void
}) {
  const index = wheelSlotIndex(value, wheel.slotCount)
  const snapped = wheel.slotCount > 1 ? index / (wheel.slotCount - 1) : 0
  const name = wheel.labels[index] ?? `${label} ${index + 1}`

  return (
    <Fader
      label={label}
      readout={armed ? name : `(${name})`}
      value={snapped}
      enabled={armed}
      tooltip={tooltip}
      midiAction={midiAction}
      onChange={(next) => {
        const nextIndex = wheelSlotIndex(next, wheel.slotCount)
        onChange(wheel.slotCount > 1 ? nextIndex / (wheel.slotCount - 1) : 0)
      }}
    />
  )
}

function Fader({
  label,
  readout,
  value,
  enabled,
  tooltip,
  midiAction,
  onChange,
}: {
  label: string
  readout: string
  /** Normalized 0..1 track position. */
  value: number
  /** Purely cosmetic: whether this fader is currently changing the output. */
  enabled: boolean
  tooltip: string
  midiAction: MidiFaderAction
  onChange: (value: number) => void
}) {
  return (
    <FaderCol>
      <BriefTooltip title={tooltip}>
        <FaderLabel $enabled={enabled}>{label}</FaderLabel>
      </BriefTooltip>
      <SliderMidiOverlay
        action={midiAction}
        style={{ flex: '1 1 auto', minHeight: 0, width: '100%' }}
      >
        <FaderTrack>
          <SliderBase
            radius={FADER_RADIUS_REM}
            orientation="vertical"
            onChange={onChange}
            title={tooltip}
            ariaLabel={`${label} override`}
          >
            <FaderCap
              $enabled={enabled}
              style={{ bottom: `${value * 100}%` }}
              aria-hidden
            />
          </SliderBase>
        </FaderTrack>
      </SliderMidiOverlay>
      <Readout $enabled={enabled} title={readout}>
        {readout}
      </Readout>
    </FaderCol>
  )
}

const Root = styled.div`
  height: 100%;
  min-height: 0;
  flex: 1 1 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
`

const HeaderRoot = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  margin: 1rem 1rem 0.75rem 1rem;
  min-width: 0;
`

const HeaderTitleRow = styled.div`
  display: flex;
  flex-direction: column;
  gap: 0.15rem;
  min-width: 0;
`

const HeaderTitle = styled.div`
  font-size: 1.3rem;
`

const HeaderSubtitle = styled.div`
  font-size: 0.8rem;
  color: ${(props) => props.theme.colors.text.secondary};
`

const MasterRoot = styled.div`
  display: flex;
  align-items: center;
  gap: 0.7rem;
  flex-wrap: wrap;
  margin: 0 1rem 0.9rem 1rem;
  padding: 0.5rem 0.7rem;
  border: 1px solid #ffffff26;
  border-radius: 0.3rem;
  background: #ffffff0a;
`

const MasterTitle = styled.div`
  font-size: 0.72rem;
  font-weight: 700;
  letter-spacing: 0.09rem;
  color: ${(props) => props.theme.colors.text.secondary};
`

const MasterFaderCluster = styled.div`
  display: flex;
  align-items: center;
  gap: 0.45rem;
`

const MasterLabel = styled.div`
  font-size: 0.78rem;
  color: ${(props) => props.theme.colors.text.secondary};
`

const MasterTrack = styled.div`
  position: relative;
  width: 9rem;
  height: 1.4rem;
`

/**
 * Position comes in as an inline style, never through the template.
 *
 * styled-components keys its classes on the CSS a render produces, so a fader
 * position interpolated into the template mints a new class and a new stylesheet
 * rule for *every* value the cap passes through — hundreds per drag, never
 * collected, each insertion re-resolving style across a sheet that only grows. That
 * is what made dragging a fader lag the whole app. `SliderCursor` has always done it
 * this way; only the props that pick between fixed looks belong in the template.
 */
const MasterCap = styled.div<{ $dim: boolean }>`
  position: absolute;
  top: 50%;
  width: 0.5rem;
  height: 1.15rem;
  transform: translate(-50%, -50%);
  border-radius: 0.12rem;
  background: ${(p) => (p.$dim ? '#ffd479' : '#e8e8e8')};
  box-shadow: 0 1px 3px #0007;
`

const MasterReadout = styled.div<{ $dim: boolean }>`
  font-size: 0.75rem;
  min-width: 2.6rem;
  text-align: right;
  color: ${(p) => (p.$dim ? '#ffd479' : p.theme.colors.text.secondary)};
`

const MasterExempt = styled.div`
  font-size: 0.7rem;
  color: ${(props) => props.theme.colors.text.secondary};
  max-width: 18rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
`

const OptionRow = styled.label`
  display: flex;
  align-items: center;
  gap: 0.3rem;
  cursor: pointer;
  margin-bottom: 0.15rem;
`

const OptionBox = styled.input`
  margin: 0;
  width: 0.8rem;
  height: 0.8rem;
  accent-color: #ffd479;
  cursor: pointer;
`

/** `$alert` is the state worth noticing at a glance, which differs per setting. */
const OptionLabel = styled.span<{ $alert: boolean }>`
  font-size: 0.62rem;
  letter-spacing: 0.02rem;
  white-space: nowrap;
  color: ${(p) => (p.$alert ? '#ff8a4c' : p.theme.colors.text.secondary)};
`

const SoloWarning = styled.div`
  font-size: 0.72rem;
  font-weight: 600;
  letter-spacing: 0.04rem;
  color: #1a1a1a;
  background: #ff8a4c;
  border-radius: 0.2rem;
  padding: 0.1rem 0.4rem;
  margin-right: 0.5rem;
  max-width: 16rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
`

/**
 * Reads as the thing it does — a dead group — rather than borrowing the solo's orange.
 * Same chip geometry, so the two sit together in the header without arguing.
 */
const BlackoutWarning = styled.div`
  font-size: 0.72rem;
  font-weight: 600;
  letter-spacing: 0.04rem;
  color: #e6ebf2;
  background: #202429;
  border: 1px solid #c2c9d4;
  border-radius: 0.2rem;
  padding: 0.1rem 0.4rem;
  margin-right: 0.5rem;
  max-width: 16rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
`

const BlinderSpeedCluster = styled.div`
  display: flex;
  align-items: center;
  gap: 0.35rem;
  margin-left: auto;
  margin-right: 0.6rem;
`

const BlinderSpeedLabel = styled.div`
  font-size: 0.8rem;
  color: ${(props) => props.theme.colors.text.secondary};
  white-space: nowrap;
`

const BlinderSpeedSelect = styled.select`
  background: #ffffff14;
  color: inherit;
  border: 1px solid #ffffff33;
  border-radius: 0.2rem;
  font-size: 0.78rem;
  padding: 0.15rem 0.3rem;
`

const EmptyState = styled.div`
  margin: 2rem;
  max-width: 28rem;
  font-size: 0.9rem;
  line-height: 1.5;
  color: ${(props) => props.theme.colors.text.secondary};
`

const GroupGrid = styled.div`
  display: flex;
  flex-wrap: wrap;
  align-content: flex-start;
  gap: 0.75rem;
  flex: 1 1 0;
  min-height: 0;
  overflow-y: auto;
  overflow-x: hidden;
  padding: 0 1rem 1rem 1rem;
  scrollbar-width: thin;
  scrollbar-color: #7a7a7a33 #0000;
`

/** Column each fader needs to keep its label, cap and readout legible. */
const FADER_COLUMN_REM = 3.2
const FADER_GAP_REM = 0.4
const CARD_PADDING_REM = 1
const CARD_MIN_WIDTH_REM = 12.5

function cardWidthRem(faderCount: number): number {
  const faders = Math.max(1, faderCount)
  const width = Math.max(
    CARD_MIN_WIDTH_REM,
    CARD_PADDING_REM + faders * FADER_COLUMN_REM + (faders - 1) * FADER_GAP_REM
  )
  // Rounded so the emitted CSS is not 22.200000000000003rem.
  return Math.round(width * 100) / 100
}

const Card = styled.div<{ $active: boolean; $faderCount: number }>`
  width: ${(p) => cardWidthRem(p.$faderCount)}rem;
  height: 17.5rem;
  display: flex;
  flex-direction: column;
  box-sizing: border-box;
  padding: 0.6rem 0.5rem 0.4rem 0.5rem;
  border-radius: 0.4rem;
  border: 1px solid ${(p) => (p.$active ? '#78dc82' : '#ffffff22')};
  background: ${(p) =>
    p.$active
      ? 'linear-gradient(180deg, rgba(120, 220, 130, 0.12), rgba(120, 220, 130, 0.03))'
      : '#ffffff08'};
`

const CardHeader = styled.div`
  display: flex;
  flex-direction: column;
  gap: 0.1rem;
  min-width: 0;
  margin-bottom: 0.4rem;
`

const GroupName = styled.div`
  font-size: 0.95rem;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  display: flex;
  align-items: center;
  gap: 0.35rem;
`

const SystemTag = styled.span`
  flex-shrink: 0;
  font-size: 0.55rem;
  letter-spacing: 0.03rem;
  text-transform: uppercase;
  padding: 0.05rem 0.25rem;
  border-radius: 0.15rem;
  border: 1px solid #ffffff33;
  color: ${(props) => props.theme.colors.text.secondary};
`

const FixtureCount = styled.div`
  font-size: 0.7rem;
  color: ${(props) => props.theme.colors.text.secondary};
`

const FaderRow = styled.div`
  display: flex;
  flex: 1 1 auto;
  min-height: 0;
  gap: ${FADER_GAP_REM}rem;
`

const FaderCol = styled.div`
  flex: 1 1 0;
  min-width: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.2rem;
`

const FaderLabel = styled.div<{ $enabled: boolean }>`
  font-size: 0.68rem;
  letter-spacing: 0.03rem;
  text-transform: uppercase;
  color: ${(p) => (p.$enabled ? '#e8ffe9' : p.theme.colors.text.secondary)};
`

const FaderTrack = styled.div`
  position: relative;
  width: 100%;
  height: 100%;
  min-height: 0;
`

/** Position inline, for the reason spelled out on `MasterCap`. */
const FaderCap = styled.div<{ $enabled: boolean }>`
  position: absolute;
  left: 50%;
  width: 1.6rem;
  height: 0.72rem;
  transform: translate(-50%, 50%);
  border-radius: 0.18rem;
  border: 1px solid ${(p) => (p.$enabled ? '#a8f0b0' : '#8a8a8a')};
  background: ${(p) =>
    p.$enabled
      ? 'linear-gradient(180deg, #eaffec 0%, #9fe0a8 45%, #5aa365 100%)'
      : 'linear-gradient(180deg, #ececec 0%, #b4b4b4 45%, #757575 100%)'};
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.45);
`

const Readout = styled.div<{ $enabled: boolean }>`
  font-size: 0.72rem;
  color: ${(p) => (p.$enabled ? '#e8ffe9' : p.theme.colors.text.secondary)};
  /* Gobo and prism readouts are slot names, which can be longer than the column. */
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
`

const CardFooter = styled.div`
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  align-items: center;
  gap: 0.25rem;
  margin-top: 0.25rem;
`

const ReleaseButton = styled(Button)<{ $armed: boolean; $locked: boolean }>`
  && {
    min-width: 0;
    font-size: 0.7rem;
    padding: 0.05rem 0.45rem;
    opacity: ${(p) => (p.$armed ? 1 : 0.45)};
    /* A locked strobe outlives the pad that started it, so it has to read as a
       standing override rather than an idle button. */
    color: ${(p) => (p.$locked ? '#1a1a1a' : undefined)};
    background: ${(p) => (p.$locked ? '#ffd479' : undefined)};
    border: ${(p) => (p.$locked ? '1px solid #ffd479' : undefined)};

    &:hover {
      background: ${(p) => (p.$locked ? '#ffe0a0' : undefined)};
    }
  }
`

const BlinderButton = styled(Button)<{ $active: boolean; $locked?: boolean }>`
  && {
    min-width: 0;
    font-size: 0.7rem;
    padding: 0.05rem 0.45rem;
    color: ${(p) => (p.$active ? '#1a1a1a' : '#f0f0f0')};
    background: ${(p) => (p.$active ? '#ffffff' : '#ffffff1f')};
    /* Locked takes the lock amber ring, so a standing blinder reads differently
       from a pad being held. */
    border: 1px solid
      ${(p) => (p.$locked === true ? '#ffd479' : p.$active ? '#ffffff' : '#ffffff66')};

    &:hover {
      background: ${(p) => (p.$active ? '#ffffff' : '#ffffff33')};
    }
  }
`

const TimedSecondsInput = styled.input`
  width: 3rem;
  margin-left: 0.3rem;
  background: #ffffff14;
  color: inherit;
  border: 1px solid #ffffff33;
  border-radius: 0.2rem;
  font-size: 0.62rem;
  padding: 0.05rem 0.2rem;
`

/**
 * Green while running, because the one thing this button has to answer across a dark
 * room is whether the thing is currently going. The countdown sits in the label, so the
 * card says how long is left without a second readout.
 */
/**
 * Steps between the two states rather than easing between them, so it reads as a pad
 * blinking rather than as a glow, and runs at the same rate the lamp does.
 *
 * Not phase-locked to the lamp: this starts whenever the button goes overdue, while the
 * lamp rounds to a fixed half-second quantum. Matching them would mean re-rendering the
 * card at the flash rate to drive the style by hand, which buys nothing — the two are
 * never in the same field of view, and only the rate reads as "the same signal".
 */
const timedOverdueFlash = keyframes`
  0%, 49.9% {
    color: #0e1a10;
    background: #6fdc86;
    border-color: #6fdc86;
  }
  50%, 100% {
    color: #9fe0a8;
    background: #6fdc8622;
    border-color: #6fdc8666;
  }
`

const TimedButton = styled(Button)<{ $active: boolean; $overdue: boolean }>`
  && {
    min-width: 2.6rem;
    font-size: 0.7rem;
    padding: 0.05rem 0.45rem;
    font-variant-numeric: tabular-nums;
    color: ${(p) => (p.$active ? '#0e1a10' : '#9fe0a8')};
    background: ${(p) => (p.$active ? '#6fdc86' : '#6fdc8622')};
    border: 1px solid ${(p) => (p.$active ? '#6fdc86' : '#6fdc8666')};

    &:hover {
      background: ${(p) => (p.$active ? '#8be79c' : '#6fdc8633')};
    }

    ${(p) =>
      p.$overdue
        ? css`
            animation: ${timedOverdueFlash}
              ${(TIMED_FLASH_HALF_PERIOD_MS * 2) / 1000}s steps(1, end) infinite;
          `
        : null}
  }
`

/**
 * The blinder's opposite, and drawn that way: engaged it goes to near-black with a
 * light ring, where every other button on the card inverts to a bright fill. A control
 * that kills lights must not be the brightest thing on the card.
 */
const BlackoutButton = styled(Button)<{ $active: boolean; $locked: boolean }>`
  && {
    min-width: 0;
    font-size: 0.7rem;
    padding: 0.05rem 0.45rem;
    color: ${(p) => (p.$active ? '#ffffff' : '#c2c9d4')};
    background: ${(p) => (p.$active ? '#101216' : '#c2c9d422')};
    /* Locked takes the lock amber ring the other pads use, so a standing blackout
       reads differently from a pad being held — and it is the one lock that can still
       be there several scenes later. */
    border: 1px solid
      ${(p) => (p.$locked ? '#ffd479' : p.$active ? '#c2c9d4' : '#c2c9d466')};

    &:hover {
      background: ${(p) => (p.$active ? '#1c2026' : '#c2c9d433')};
    }
  }
`

const FlashButton = styled(Button)<{ $active: boolean }>`
  && {
    min-width: 0;
    font-size: 0.7rem;
    padding: 0.05rem 0.45rem;
    color: ${(p) => (p.$active ? '#1a1a1a' : '#cfe3ff')};
    background: ${(p) => (p.$active ? '#7fb2ff' : '#7fb2ff22')};
    border: 1px solid ${(p) => (p.$active ? '#7fb2ff' : '#7fb2ff66')};

    &:hover {
      background: ${(p) => (p.$active ? '#9cc4ff' : '#7fb2ff33')};
    }
  }
`

const ExclusiveButton = styled(Button)<{ $active: boolean; $locked: boolean }>`
  && {
    min-width: 0;
    font-size: 0.7rem;
    padding: 0.05rem 0.45rem;
    color: ${(p) => (p.$active ? '#1a1a1a' : '#ffcf9e')};
    background: ${(p) => (p.$active ? '#ff8a4c' : '#ff8a4c22')};
    /* Locked keeps the solo orange but takes the lock amber ring the Unlock button
       uses, so a standing solo reads differently from a pad being held. */
    border: 1px solid
      ${(p) => (p.$locked ? '#ffd479' : p.$active ? '#ff8a4c' : '#ff8a4c66')};

    &:hover {
      background: ${(p) => (p.$active ? '#ff9d68' : '#ff8a4c33')};
    }
  }
`
