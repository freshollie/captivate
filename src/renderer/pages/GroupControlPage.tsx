import styled from 'styled-components'
import { useMemo } from 'react'
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
  setGroupStrobe,
  setBlinderFadeBeats,
  setGroupFollowMaster,
  setMasterBrightness,
  toggleMasterBlinder,
  toggleMasterStrobe,
  toggleGroupBlinder,
  toggleGroupExclusive,
  toggleGroupStrobeFlash,
} from '../redux/groupControlSlice'
import {
  countFixturesInGroup,
  effectiveGroupBrightness,
  initGroupControl,
  isGroupBrightnessActive,
  isGroupBrightnessForcedFull,
  isGroupControlActive,
  type GroupControl,
} from '../../shared/groupControl'
import { flatten_fixtures, getSortedGroupsFromPlacedFixtures } from '../../shared/dmxUtil'
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
          control?.blinderActive === true
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
      <BriefTooltip title="Drop every live override on every group — strobes, solos and blinders. Brightness trims are left alone.">
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
    </HeaderRoot>
  )
}

function MasterBar() {
  const dispatch = useDispatch()
  const master = useTypedSelector((state) => state.groupControl.master)
  const exemptGroupKey = useTypedSelector((state) =>
    Object.entries(state.groupControl.byGroup)
      .filter(([, control]) => control?.followMaster === false)
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
          <BriefTooltip title="Layered on top of each group's own dimmer — 50% here under a group at 50% gives 25%">
            <MasterTrack>
              <SliderBase
                radius={0.42}
                orientation="horizontal"
                onChange={(value) => dispatch(setMasterBrightness(value))}
                ariaLabel="Master dimmer"
              >
                <MasterCap $value={master.brightness} aria-hidden />
              </SliderBase>
            </MasterTrack>
          </BriefTooltip>
        </SliderMidiOverlay>
        <MasterReadout $dim={master.brightness < 1}>
          {Math.round(master.brightness * 100)}%
        </MasterReadout>
      </MasterFaderCluster>

      <ButtonMidiOverlay action={{ type: 'setGroupMasterBlinder' }}>
        <BriefTooltip title="Hold to blind every following group. Assign to a MIDI pad.">
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
        <BriefTooltip title="Hold to fire the Flash on every following group, each at its own level. Assign to a MIDI pad.">
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
        <MasterExempt title={`Ignoring the master: ${exemptGroups.join(', ')}`}>
          not following: {exemptGroups.join(', ')}
        </MasterExempt>
      ) : null}
    </MasterRoot>
  )
}

function GroupCard({
  group,
  fixtureCount,
}: {
  group: string
  fixtureCount: number
}) {
  const dispatch = useDispatch()
  const control: GroupControl = useTypedSelector(
    (state) => state.groupControl.byGroup[group] ?? EMPTY_GROUP_CONTROL
  )

  const isActive = isGroupControlActive(control)
  // Flash / Excl pull the group up to full while held; show that rather than the
  // fader's resting position, or the readout would contradict the lights.
  const brightnessForcedFull = isGroupBrightnessForcedFull(control)

  return (
    <Card $active={isActive}>
      <CardHeader>
        <GroupName title={group}>
          {group}
          {group === MOVERS_GROUP ? <SystemTag>system</SystemTag> : null}
        </GroupName>
        <FixtureCount>
          {fixtureCount} fixture{fixtureCount === 1 ? '' : 's'}
        </FixtureCount>
      </CardHeader>

      <BriefTooltip title="Whether the master dimmer, strobe and blinder reach this group">
        <FollowMasterRow>
          <FollowMasterBox
            type="checkbox"
            checked={control.followMaster !== false}
            onChange={(event) =>
              dispatch(
                setGroupFollowMaster({ group, follow: event.target.checked })
              )
            }
            aria-label={`${group} follows the master`}
          />
          <FollowMasterLabel $on={control.followMaster !== false}>
            follow master
          </FollowMasterLabel>
        </FollowMasterRow>
      </BriefTooltip>

      <FaderRow>
        <Fader
          label="Bright"
          readout={`${Math.round(effectiveGroupBrightness(control) * 100)}%${
            brightnessForcedFull ? '*' : ''
          }`}
          value={effectiveGroupBrightness(control)}
          enabled={brightnessForcedFull || isGroupBrightnessActive(control)}
          midiAction={{ type: 'setGroupControl', group, control: 'brightness' }}
          tooltip="Scales the master/dimmer channel against the scene — 100% leaves it untouched, a scene at 0 stays dark, and fixtures without a dimmer are unaffected. Flash and Excl hold it at 100% while engaged (*)."
          onChange={(value) => dispatch(setGroupBrightness({ group, value }))}
        />
        <Fader
          label="Strobe"
          readout={control.strobeEnabled ? `${control.strobe}` : '--'}
          value={control.strobe / DMX_MAX_VALUE}
          enabled={control.strobeEnabled}
          midiAction={{ type: 'setGroupControl', group, control: 'strobe' }}
          tooltip="Raw DMX value written to this group's strobe channels (0–255). Touch to take it over; Release hands it back to the scene."
          onChange={(value) =>
            dispatch(setGroupStrobe({ group, value: value * DMX_MAX_VALUE }))
          }
        />
      </FaderRow>

      <CardFooter>
        <ButtonMidiOverlay action={{ type: 'setGroupExclusive', group }}>
          <BriefTooltip title="Solo: hold everything outside this group dark. Assign to a MIDI pad to hold it momentarily.">
            <ExclusiveButton
              $active={control.exclusiveEnabled}
              size="small"
              onClick={() => dispatch(toggleGroupExclusive(group))}
            >
              Excl
            </ExclusiveButton>
          </BriefTooltip>
        </ButtonMidiOverlay>
        <ButtonMidiOverlay action={{ type: 'setGroupBlinder', group }}>
          <BriefTooltip title="Hold to blind: full pulsing white over the scene, whether or not the scene uses this group. Assign to a MIDI pad to hold it momentarily.">
            <BlinderButton
              $active={control.blinderActive}
              size="small"
              onClick={() => dispatch(toggleGroupBlinder(group))}
            >
              Blind
            </BlinderButton>
          </BriefTooltip>
        </ButtonMidiOverlay>
        <ButtonMidiOverlay action={{ type: 'setGroupStrobeFlash', group }}>
          <BriefTooltip
            title={`Hold to strobe at ${control.strobeFlashLevel} DMX, let go to drop it. Assign to a MIDI pad to hold it momentarily.`}
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
          <BriefTooltip title="Release this group's strobe back to the scene. Assignable to a MIDI pad.">
            <ReleaseButton
              $armed={control.strobeEnabled}
              size="small"
              onClick={() => dispatch(releaseGroupStrobe(group))}
            >
              Release
            </ReleaseButton>
          </BriefTooltip>
        </ButtonMidiOverlay>
      </CardFooter>
    </Card>
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
  midiAction: { type: 'setGroupControl'; group: string; control: 'brightness' | 'strobe' }
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
            <FaderCap $value={value} $enabled={enabled} aria-hidden />
          </SliderBase>
        </FaderTrack>
      </SliderMidiOverlay>
      <Readout $enabled={enabled}>{readout}</Readout>
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

const MasterCap = styled.div<{ $value: number }>`
  position: absolute;
  top: 50%;
  left: ${(p) => p.$value * 100}%;
  width: 0.5rem;
  height: 1.15rem;
  transform: translate(-50%, -50%);
  border-radius: 0.12rem;
  background: ${(p) => (p.$value < 1 ? '#ffd479' : '#e8e8e8')};
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

const FollowMasterRow = styled.label`
  display: flex;
  align-items: center;
  gap: 0.3rem;
  cursor: pointer;
  margin-bottom: 0.15rem;
`

const FollowMasterBox = styled.input`
  margin: 0;
  width: 0.8rem;
  height: 0.8rem;
  accent-color: #ffd479;
  cursor: pointer;
`

const FollowMasterLabel = styled.span<{ $on: boolean }>`
  font-size: 0.62rem;
  letter-spacing: 0.02rem;
  color: ${(p) => (p.$on ? p.theme.colors.text.secondary : '#ff8a4c')};
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

const Card = styled.div<{ $active: boolean }>`
  width: 12.5rem;
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
  gap: 0.4rem;
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

const FaderCap = styled.div<{ $value: number; $enabled: boolean }>`
  position: absolute;
  left: 50%;
  bottom: ${(p) => p.$value * 100}%;
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
`

const CardFooter = styled.div`
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  align-items: center;
  gap: 0.25rem;
  margin-top: 0.25rem;
`

const ReleaseButton = styled(Button)<{ $armed: boolean }>`
  && {
    min-width: 0;
    font-size: 0.7rem;
    padding: 0.05rem 0.45rem;
    opacity: ${(p) => (p.$armed ? 1 : 0.45)};
  }
`

const BlinderButton = styled(Button)<{ $active: boolean }>`
  && {
    min-width: 0;
    font-size: 0.7rem;
    padding: 0.05rem 0.45rem;
    color: ${(p) => (p.$active ? '#1a1a1a' : '#f0f0f0')};
    background: ${(p) => (p.$active ? '#ffffff' : '#ffffff1f')};
    border: 1px solid ${(p) => (p.$active ? '#ffffff' : '#ffffff66')};

    &:hover {
      background: ${(p) => (p.$active ? '#ffffff' : '#ffffff33')};
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

const ExclusiveButton = styled(Button)<{ $active: boolean }>`
  && {
    min-width: 0;
    font-size: 0.7rem;
    padding: 0.05rem 0.45rem;
    color: ${(p) => (p.$active ? '#1a1a1a' : '#ffcf9e')};
    background: ${(p) => (p.$active ? '#ff8a4c' : '#ff8a4c22')};
    border: 1px solid ${(p) => (p.$active ? '#ff8a4c' : '#ff8a4c66')};

    &:hover {
      background: ${(p) => (p.$active ? '#ff9d68' : '#ff8a4c33')};
    }
  }
`
