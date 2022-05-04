import styled from 'styled-components'
import Select from '../base/Select'
import {
  effectTypes,
  EffectConfig,
  initEffectConfig,
} from 'renderer/visualizer/threejs/effects/effectConfigs'
import { activeVisualSceneEffect_set } from 'renderer/redux/controlSlice'
import { useDispatch } from 'react-redux'
import { useActiveVisualScene } from 'renderer/redux/store'

interface Props {}

export default function ActiveEffect({}: Props) {
  const effect: EffectConfig | undefined = useActiveVisualScene(
    (scene) => scene.effectsConfig[scene.activeEffectIndex]
  )
  const dispatch = useDispatch()

  if (effect === undefined) return null

  return (
    <Root>
      <Select
        label="Effect"
        val={effect.type}
        items={effectTypes}
        onChange={(newType) =>
          dispatch(activeVisualSceneEffect_set(initEffectConfig(newType)))
        }
      />
    </Root>
  )
}

const Root = styled.div`
  padding: 1rem;
  flex: 1 0 0;
  border-right: 1px solid ${(props) => props.theme.colors.divider};
`
