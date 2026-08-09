import styled from 'styled-components'
import { useMemo } from 'react'
import { useDispatch } from 'react-redux'
import { Button, Switch } from '@mui/material'
import SliderBase from '../base/SliderBase'
import { ButtonMidiOverlay, SliderMidiOverlay } from '../base/MidiOverlay'
import { BriefTooltip } from '../base/appTooltip'
import StatusBar from '../menu/StatusBar'
import { useDmxSelector, useTypedSelector } from '../redux/store'
import {
  clearAllGroupControls,
  clearGroupControl,
  setGroupBrightness,
  setGroupBrightnessEnabled,
  setGroupStrobe,
  setGroupStrobeEnabled,
  toggleGroupExclusive,
} from '../redux/groupControlSlice'
import {
  countFixturesInGroup,
  initGroupControl,
  isGroupControlActive,
  type GroupControl,
} from '../../shared/groupControl'
import { flatten_fixtures, getSortedGroupsFromPlacedFixtures } from '../../shared/dmxUtil'
import { DMX_MAX_VALUE, universeHasMovers } from '../../shared/dmxFixtures'

const FADER_RADIUS_REM = 0.5
/** Virtual group matched by pan/tilt channels rather than group assignment. */
const MOVERS_GROUP = 'Movers'

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
      <BriefTooltip title="Release every group override">
        <span>
          <Button
            disabled={activeCount === 0}
            variant="contained"
            size="small"
            onClick={() => dispatch(clearAllGroupControls())}
          >
            Release all
          </Button>
        </span>
      </BriefTooltip>
    </HeaderRoot>
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
    (state) => state.groupControl.byGroup[group] ?? initGroupControl()
  )

  const isActive = isGroupControlActive(control)

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

      <FaderRow>
        <Fader
          label="Bright"
          readout={`${Math.round(control.brightness * 100)}%`}
          value={control.brightness}
          enabled={control.brightnessEnabled}
          midiAction={{ type: 'setGroupControl', group, control: 'brightness' }}
          tooltip="Scales the master/dimmer channel against the scene — 100% leaves it untouched, a scene at 0 stays dark, and fixtures without a dimmer are unaffected"
          onChange={(value) => dispatch(setGroupBrightness({ group, value }))}
          onToggle={(enabled) =>
            dispatch(setGroupBrightnessEnabled({ group, enabled }))
          }
        />
        <Fader
          label="Strobe"
          readout={`${control.strobe}`}
          value={control.strobe / DMX_MAX_VALUE}
          enabled={control.strobeEnabled}
          midiAction={{ type: 'setGroupControl', group, control: 'strobe' }}
          tooltip="Raw DMX value written to this group's strobe channels (0–255)"
          onChange={(value) =>
            dispatch(setGroupStrobe({ group, value: value * DMX_MAX_VALUE }))
          }
          onToggle={(enabled) => dispatch(setGroupStrobeEnabled({ group, enabled }))}
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
        <BriefTooltip title="Release this group back to the scene">
          <span>
            <ReleaseButton
              disabled={!isActive}
              size="small"
              onClick={() => dispatch(clearGroupControl(group))}
            >
              Release
            </ReleaseButton>
          </span>
        </BriefTooltip>
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
  onToggle,
}: {
  label: string
  readout: string
  /** Normalized 0..1 track position. */
  value: number
  enabled: boolean
  tooltip: string
  midiAction: { type: 'setGroupControl'; group: string; control: 'brightness' | 'strobe' }
  onChange: (value: number) => void
  onToggle: (enabled: boolean) => void
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
      <BriefTooltip title={enabled ? 'Release to the scene' : 'Take over from the scene'}>
        <Switch
          size="small"
          checked={enabled}
          onChange={(_, checked) => onToggle(checked)}
          inputProps={{ 'aria-label': `${label} override active` }}
        />
      </BriefTooltip>
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
  width: 11rem;
  height: 17rem;
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
  justify-content: center;
  align-items: center;
  gap: 0.3rem;
  margin-top: 0.2rem;
`

const ReleaseButton = styled(Button)`
  && {
    min-width: 0;
    font-size: 0.7rem;
    padding: 0.05rem 0.6rem;
  }
`

const ExclusiveButton = styled(Button)<{ $active: boolean }>`
  && {
    min-width: 0;
    font-size: 0.7rem;
    padding: 0.05rem 0.6rem;
    color: ${(p) => (p.$active ? '#1a1a1a' : '#ffcf9e')};
    background: ${(p) => (p.$active ? '#ff8a4c' : '#ff8a4c22')};
    border: 1px solid ${(p) => (p.$active ? '#ff8a4c' : '#ff8a4c66')};

    &:hover {
      background: ${(p) => (p.$active ? '#ff9d68' : '#ff8a4c33')};
    }
  }
`
