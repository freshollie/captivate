import IconButton from '@mui/material/IconButton'
import EditIcon from '@mui/icons-material/Edit'
import RemoveIcon from '@mui/icons-material/Remove'
import TuneIcon from '@mui/icons-material/Tune'
import CopyIcon from '@mui/icons-material/ContentCopy'
import { useMemo, useState } from 'react'
import {
  useActiveLightScene,
  useDmxSelector,
  useTypedSelector,
  type ReduxState,
} from 'renderer/redux/store'
import styled from 'styled-components'
import Popup from '../base/Popup'
import { PopupTitleRow } from '../base/SectionHelpPopover'
import { useDispatch, useStore } from 'react-redux'
import {
  removeSplitSceneByIndex,
  setSceneGroup,
} from 'renderer/redux/controlSlice'
import { pushStatusMessage, setSplitClipboard } from 'renderer/redux/guiSlice'
import { cloneSplitScene } from 'shared/Scenes'
import { universeHasMovers } from 'shared/dmxFixtures'
import { getSortedGroupsFromPlacedFixtures } from 'shared/dmxUtil'
import { universeHasAtmospherics } from 'shared/atmosphericsMapping'
import { showVisGroupUi, splitDisplayName } from './splitUiVisibility'
import SplitModShapingModal from './SplitModShapingModal'
import { SplitGroupsHelpButton, SplitModShapingHelpButton } from './sceneHelpButtons'

interface Props {
  splitIndex: number
}

/**
 * Shared empty selection for a split that does not exist yet.
 *
 * Must be a stable reference: `?? {}` inside a selector hands react-redux a new object
 * every time it runs — which is on every dispatched action — so the component would
 * re-render for actions it has nothing to do with, and redo the rig scan below each
 * time.
 */
const NO_GROUPS: { [key: string]: boolean | undefined } = Object.freeze({})

export default function GroupSelection({ splitIndex }: Props) {
  const dispatch = useDispatch()
  // Copying needs the active scene (for the split snapshot and the source name),
  // but subscribing to it would re-render this header on every param move, so the
  // snapshot is read from the store when the button is actually clicked.
  const store = useStore()
  const [isOpen, setIsOpen] = useState(false)
  const [modShapingOpen, setModShapingOpen] = useState(false)
  const videoEnabled = useTypedSelector((state) => state.gui.videoEnabled)
  const showVisualizerGroup = showVisGroupUi(videoEnabled)
  const universe = useDmxSelector((dmx) => dmx.universe)
  const fixtureTypesByID = useDmxSelector((dmx) => dmx.fixtureTypesByID)
  const ledFixtures = useDmxSelector((dmx) => dmx.led.ledFixtures)
  // Three full passes over the rig, and the group scan grows with the number of
  // groups in the show — 0.05ms at four groups, 0.8ms at forty-eight. Cheap once per
  // patch change, ruinous if it runs on every render, so it is keyed to the rig
  // rather than left in the render body.
  const rig = useMemo(
    () => ({
      hasMoverFixtures: universeHasMovers(universe, fixtureTypesByID),
      hasAtmosphericsInUniverse: universeHasAtmospherics(universe, fixtureTypesByID),
      placedGroups: getSortedGroupsFromPlacedFixtures(universe, fixtureTypesByID),
      ledGroups: ledFixtures
        .flatMap((fixture) => fixture.groups)
        .map((group) => group.trim())
        .filter((group) => group.length > 0),
    }),
    [universe, fixtureTypesByID, ledFixtures]
  )
  const { hasMoverFixtures, hasAtmosphericsInUniverse, ledGroups } = rig
  let availableGroups = rig.placedGroups
  const activeGroups = useActiveLightScene(
    (scene) => scene.splitScenes[splitIndex]?.groups ?? NO_GROUPS
  )
  const hasSplitModShaping = useActiveLightScene(
    (scene) => scene.splitScenes[splitIndex]?.splitModShaping !== undefined
  )
  const entries = Object.entries(activeGroups)

  let allAvailableGroups = new Set(availableGroups)
  for (const group of ledGroups) {
    allAvailableGroups.add(group)
  }
  if (showVisualizerGroup) {
    allAvailableGroups.add('Visualizer')
  }
  if (hasMoverFixtures) {
    allAvailableGroups.add('Movers')
  }
  if (hasAtmosphericsInUniverse) {
    allAvailableGroups.add('Atmosphere')
  }
  for (const [group, _] of entries) {
    if (!showVisualizerGroup && group === 'Visualizer') {
      continue
    }
    allAvailableGroups.add(group)
  }
  availableGroups = Array.from(allAvailableGroups)
    .filter(
      (group) =>
        (showVisualizerGroup || group !== 'Visualizer') &&
        (hasMoverFixtures ||
          group !== 'Movers' ||
          activeGroups.Movers !== undefined)
    )
    .sort((a, b) => (a > b ? 1 : -1))

  const universeFixtureCount = universe.length
  const noGroupsAvailable = availableGroups.length === 0

  const splitHeading = splitDisplayName(splitIndex, activeGroups)

  const onCopySplit = () => {
    const state = store.getState() as ReduxState
    const lightScenes = state.control.present.light
    const scene = lightScenes.byId[lightScenes.active]
    const split = scene?.splitScenes[splitIndex]
    if (scene === undefined || split === undefined) {
      return
    }
    dispatch(
      setSplitClipboard({
        splitScene: cloneSplitScene(split),
        sourceSceneName: scene.name,
        sourceSplitLabel: splitDisplayName(splitIndex, split.groups),
      })
    )
    dispatch(
      pushStatusMessage({
        level: 'info',
        message: `Copied ${splitHeading} from "${scene.name}" (groups and params, without modulation) — use Paste Split in any scene`,
        source: 'Splits',
      })
    )
  }

  return (
    <Root>
      <GroupName title={splitHeading}>{splitHeading}</GroupName>
      {noGroupsAvailable ? (
        <NoGroupsCue title="Patch fixtures on the universe to populate fixture-type groups">
          {universeFixtureCount === 0
            ? 'No fixtures patched yet — nothing to group.'
            : 'No groups available from the current rig yet.'}
        </NoGroupsCue>
      ) : null}
      <IconToolbar>
        <SplitGroupsHelpButton />
        <IconButton
          size="small"
          sx={{ flexShrink: 0 }}
          title="Choose which fixture groups this split includes or excludes"
          aria-label="Edit split groups"
          onClick={(e) => {
            e.preventDefault()
            setIsOpen(true)
          }}
        >
          <EditIcon />
        </IconButton>
        <IconButton
          size="small"
          sx={{ flexShrink: 0 }}
          onClick={(e) => {
            e.preventDefault()
            onCopySplit()
          }}
          aria-label="Copy split"
          title="Copy this split's groups and params (not its modulation) to paste into another scene"
        >
          <CopyIcon fontSize="small" />
        </IconButton>
        {splitIndex > 0 ? (
          <IconButton
            size="small"
            sx={{ flexShrink: 0 }}
            onClick={(e) => {
              e.preventDefault()
              dispatch(removeSplitSceneByIndex(splitIndex))
            }}
            aria-label="Remove split"
            title="Remove this split (split 0 cannot be removed)"
          >
            <RemoveIcon fontSize="small" />
          </IconButton>
        ) : null}
        <IconButton
          size="small"
          aria-label="Split modulation modifiers"
          title="Per-split invert, phase shift, or stair-step quantize"
          onClick={(e) => {
            e.preventDefault()
            setModShapingOpen(true)
          }}
          sx={{
            flexShrink: 0,
            color: hasSplitModShaping ? '#8eb0ff' : undefined,
            '& .MuiSvgIcon-root': {
              opacity: hasSplitModShaping ? 1 : 0.92,
            },
          }}
        >
          <TuneIcon fontSize="small" />
        </IconButton>
      </IconToolbar>
      {isOpen && (
        <Popup title="Select Groups" onClose={() => setIsOpen(false)}>
          {noGroupsAvailable ? (
            <NoGroupsInPicker>
              <NoGroupsInPickerTitle>No groups to assign yet</NoGroupsInPickerTitle>
              <NoGroupsInPickerBody>
                {universeFixtureCount === 0 ? (
                  <>
                    There are no fixtures patched in any universe address yet, so no fixture
                    groups are available for splits. Patch fixtures under <strong>Patch</strong>{' '}
                    (Patching), then return here to route them into lighting splits.
                  </>
                ) : (
                  <>
                    Fixtures are patched, but no groups were found from their definitions (and no
                    LED or system groups apply yet). Assign groups on fixture types in{' '}
                    <strong>Fixtures</strong>, or check LED strip group names, movers, and
                    atmospherics so splits can target them.
                  </>
                )}
              </NoGroupsInPickerBody>
            </NoGroupsInPicker>
          ) : (
            availableGroups.map((group) => {
              const activeState = activeGroups[group]
              return (
                <AvailableGroup
                  activeState={activeState}
                  key={group}
                  onClick={() => {
                    let next =
                      activeState === undefined
                        ? true
                        : activeState === true
                        ? false
                        : undefined
                    dispatch(
                      setSceneGroup({
                        index: splitIndex,
                        group,
                        val: next,
                      })
                    )
                  }}
                >
                  {`${activeState === false ? 'not ' : ''}${group}`}
                </AvailableGroup>
              )
            })
          )}
        </Popup>
      )}
      {modShapingOpen && (
        <Popup
          title={
            <PopupTitleRow>
              <span>{`${splitHeading} — modulation modifiers`}</span>
              <SplitModShapingHelpButton />
            </PopupTitleRow>
          }
          onClose={() => setModShapingOpen(false)}
          cardWidth="min(28rem, calc(100vw - 2rem))"
        >
          <SplitModShapingModal
            splitIndex={splitIndex}
            onClose={() => setModShapingOpen(false)}
          />
        </Popup>
      )}
    </Root>
  )
}

const Root = styled.div`
  position: relative;
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  row-gap: 0.2rem;
  gap: 0.15rem;
  min-width: 0;
  width: 100%;
  box-sizing: border-box;
  padding: 0.15rem 0.35rem 0 0;
`

const IconToolbar = styled.div`
  display: inline-flex;
  align-items: center;
  flex-shrink: 0;
`

const GroupName = styled.div`
  flex: 1 1 auto;
  min-width: 0;
  margin-right: 0.35rem;
  font-size: 1rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
`

const NoGroupsCue = styled.div`
  flex: 1 1 8rem;
  min-width: 0;
  font-size: 0.68rem;
  line-height: 1.25;
  color: ${(props) => props.theme.colors.text.secondary};
  font-style: italic;
  margin-right: 0.25rem;
`

const NoGroupsInPicker = styled.div`
  padding: 0.15rem 0.1rem 0.35rem;
  max-width: 22rem;
`

const NoGroupsInPickerTitle = styled.div`
  font-size: 0.88rem;
  font-weight: 600;
  color: ${(props) => props.theme.colors.text.primary};
  margin-bottom: 0.45rem;
`

const NoGroupsInPickerBody = styled.div`
  font-size: 0.78rem;
  line-height: 1.45;
  color: ${(props) => props.theme.colors.text.secondary};
`

const AvailableGroup = styled.div<{ activeState: boolean | undefined }>`
  cursor: pointer;
  /* :hover {
    text-decoration: ${(props) =>
    props.activeState === false ? 'line-through' : 'underline'};
  } */
  color: ${(props) =>
    props.activeState === undefined && props.theme.colors.text.secondary};
  margin-bottom: 1rem;
`
