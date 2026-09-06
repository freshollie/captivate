import { useMemo } from 'react'
import ParamsControl from 'renderer/controls/ParamsControl'
import { collectLaserLightingGroupNames } from 'renderer/laser/laserSplitLink'
import {
  useActiveLightScene,
  useControlSelector,
  useDmxSelector,
  useTypedSelector,
} from 'renderer/redux/store'
import {
  hideMoversSplitUi,
  hideLaserSplitUi,
  hideVisSplitUi,
} from './splitUiVisibility'
import { universeHasMovers } from 'shared/dmxFixtures'
import { indexArray } from 'shared/util'
import styled from 'styled-components'
import GroupSelection from './GroupSelection'
import AddIcon from '@mui/icons-material/Add'
import PasteIcon from '@mui/icons-material/ContentPaste'
import { useDispatch } from 'react-redux'
import { addSplitScene, pasteSplitScene } from 'renderer/redux/controlSlice'
import { SplitScenesHelpButton } from './sceneHelpButtons'

export default function SplitScenes({
  flattenScroll = false,
  hideTitle = false,
}: {
  flattenScroll?: boolean
  hideTitle?: boolean
}) {
  const dispatch = useDispatch()
  const activeScene = useControlSelector((scenes) => scenes.light.active)
  const splitSceneCount = useActiveLightScene(
    (scene) => scene.splitScenes.length
  )
  const clipboard = useTypedSelector((state) => state.gui.splitClipboard)

  const indexes = indexArray(splitSceneCount)

  const onAddSplitScene = () => dispatch(addSplitScene())

  const onPasteSplitScene = () => {
    if (clipboard === null || clipboard === undefined) {
      return
    }
    // No status message: the new split appearing in the list is the confirmation,
    // and a flashing bar entry on every paste is just noise.
    dispatch(pasteSplitScene({ splitScene: clipboard.splitScene }))
  }

  return (
    <Root $flatten={flattenScroll}>
      {!hideTitle ? (
        <TitleRow>
          <Title>Splits</Title>
          <SplitScenesHelpButton />
        </TitleRow>
      ) : null}
      <SplitList $flatten={flattenScroll}>
        {splitSceneCount < 1 ? (
          <EmptyState>No splits yet. Add a split to start mapping groups and params.</EmptyState>
        ) : (
          indexes.map((index) => <SplitScene key={activeScene + index} index={index} />)
        )}
        <AddSplitFooter>
          <AddSplitDivider />
          <AddSplitActions>
            <AddSplitButton
              type="button"
              onClick={onAddSplitScene}
              title="Add another section for a different group of lights"
            >
              <AddIcon fontSize="small" />
              <span>Add Split</span>
            </AddSplitButton>
            {clipboard ? (
              <AddSplitButton
                type="button"
                onClick={onPasteSplitScene}
                title={`Paste ${clipboard.sourceSplitLabel} copied from "${clipboard.sourceSceneName}" as a new split here (groups and params, without modulation)`}
              >
                <PasteIcon fontSize="small" />
                <span>Paste Split</span>
              </AddSplitButton>
            ) : null}
          </AddSplitActions>
        </AddSplitFooter>
      </SplitList>
    </Root>
  )
}

const Root = styled.div<{ $flatten?: boolean }>`
  display: flex;
  flex-direction: column;
  gap: 0.55rem;
  min-width: 0;
  min-height: 0;
  flex: ${(p) => (p.$flatten ? '0 0 auto' : '1 1 0')};
  overflow: ${(p) => (p.$flatten ? 'visible' : 'hidden')};
`

const TitleRow = styled.div`
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 0.15rem;
`

const Title = styled.div`
  font-size: ${(props) => props.theme.font.size.h1};
  color: ${(props) => props.theme.colors.text.primary};
`

const SplitList = styled.div<{ $flatten?: boolean }>`
  display: flex;
  flex-direction: column;
  gap: 0.55rem;
  min-width: 0;
  min-height: 0;
  flex: ${(p) => (p.$flatten ? '0 0 auto' : '1 1 0')};
  overflow-y: ${(p) => (p.$flatten ? 'visible' : 'auto')};
  overflow-x: hidden;
  padding-right: 0.12rem;
  scrollbar-gutter: stable;
  scrollbar-width: auto;
  scrollbar-color: rgba(155, 162, 182, 0.88) rgba(0, 0, 0, 0.32);
  align-content: flex-start;

  > * {
    flex-shrink: 0;
  }

  &::-webkit-scrollbar {
    width: 11px;
  }

  &::-webkit-scrollbar-track {
    background: rgba(0, 0, 0, 0.3);
    border-radius: 6px;
    margin: 3px 0;
  }

  &::-webkit-scrollbar-thumb {
    background: rgba(150, 158, 180, 0.62);
    border-radius: 6px;
    border: 2px solid transparent;
    background-clip: padding-box;
  }

  &::-webkit-scrollbar-thumb:hover {
    background: rgba(185, 192, 215, 0.78);
    border: 2px solid transparent;
    background-clip: padding-box;
  }
`

const AddSplitButton = styled.button`
  display: inline-flex;
  align-items: center;
  gap: 0.28rem;
  border: 1px solid ${(props) => props.theme.colors.divider};
  border-radius: 0.35rem;
  background: ${(props) => props.theme.colors.bg.primary};
  color: ${(props) => props.theme.colors.text.primary};
  padding: 0.26rem 0.5rem;
  font-size: 0.76rem;
  cursor: pointer;
  white-space: nowrap;
  transition: background-color 120ms ease, border-color 120ms ease;
  align-self: flex-start;

  &:hover {
    background: ${(props) => props.theme.colors.bg.lighter};
    border-color: ${(props) => props.theme.colors.text.secondary};
  }

  &:active {
    transform: translateY(1px);
  }
`

const AddSplitActions = styled.div`
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 0.35rem;
  min-width: 0;
`

const AddSplitFooter = styled.div`
  flex-shrink: 0;
  flex-grow: 0;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 0.5rem;
  min-width: 0;
  margin-top: 0.55rem;
  padding-bottom: 0.35rem;
`

const AddSplitDivider = styled.div`
  width: 100%;
  height: 1px;
  background: ${(props) => props.theme.colors.divider};
  opacity: 0.85;
`

const EmptyState = styled.div`
  border: 1px dashed ${(props) => props.theme.colors.divider};
  border-radius: 0.35rem;
  color: ${(props) => props.theme.colors.text.secondary};
  font-size: 0.78rem;
  padding: 0.7rem 0.75rem;
`

interface Props {
  index: number
}

function SplitScene({ index }: Props) {
  const videoEnabled = useTypedSelector((state) => state.gui.videoEnabled)
  const laserWindowOpen = useTypedSelector((state) => state.gui.laserWindowOpen)
  const laser = useTypedSelector((state) => state.laser)
  const laserGroupNames = useMemo(
    () => new Set(collectLaserLightingGroupNames(laser)),
    [laser.groupSlots, laser.units]
  )
  const hasMoverFixtures = useDmxSelector((dmx) =>
    universeHasMovers(dmx.universe, dmx.fixtureTypesByID)
  )
  const groups = useActiveLightScene(
    (scene) => scene.splitScenes[index]?.groups
  )
  if (hideVisSplitUi(videoEnabled, groups)) {
    return null
  }
  if (hideMoversSplitUi(hasMoverFixtures, groups)) {
    return null
  }
  if (hideLaserSplitUi(laserWindowOpen, groups, laserGroupNames)) {
    return null
  }
  return (
    <Root2>
      <GroupSelection splitIndex={index} />
      <SplitControls>
        <ParamsControl splitIndex={index} />
      </SplitControls>
    </Root2>
  )
}

const Root2 = styled.div`
  flex: 0 0 auto;
  min-height: min-content;
  border-top: 1px solid ${(props) => props.theme.colors.divider};
  margin-bottom: 0;
  background-color: ${(props) => props.theme.colors.bg.darker};
  overflow-x: auto;
  overflow-y: visible;
  width: 100%;
  padding-bottom: 0.35rem;
  scrollbar-width: auto;
  scrollbar-color: rgba(155, 162, 182, 0.88) rgba(0, 0, 0, 0.32);

  &::-webkit-scrollbar {
    height: 11px;
  }

  &::-webkit-scrollbar-track {
    background: rgba(0, 0, 0, 0.3);
    border-radius: 6px;
    margin: 0 3px;
  }

  &::-webkit-scrollbar-thumb {
    background: rgba(150, 158, 180, 0.62);
    border-radius: 6px;
    border: 2px solid transparent;
    background-clip: padding-box;
  }

  &::-webkit-scrollbar-thumb:hover {
    background: rgba(185, 192, 215, 0.78);
    border: 2px solid transparent;
    background-clip: padding-box;
  }
`

const SplitControls = styled.div`
  width: max-content;
  min-width: 100%;
`
