import Slider from '../base/Slider'
import styled from 'styled-components'
import { useDispatch } from 'react-redux'
import { useControlSelector } from '../redux/store'
import {
  setAutoSceneEnabled,
  setAutoSceneBombacity,
  setAutoScenePeriod,
  setActiveScene,
} from '../redux/controlSlice'
import { SceneType } from '../../shared/Scenes'
import DraggableNumber from '../base/DraggableNumber'
import { ButtonMidiOverlay, SliderMidiOverlay } from 'renderer/base/MidiOverlay'
import { useEffect, useState } from 'react'
import { randomElementExcludeCurrent } from 'shared/util'
import Checkbox from '../base/LabelledCheckbox'

export default function AutoScene({ sceneType }: { sceneType: SceneType }) {
  const [keyBindingsEnabled, setKeyBindings] = useState(false)
  const dispatch = useDispatch()
  const { enabled, epicness, period } = useControlSelector(
    (control) => control[sceneType].auto
  )

  const sceneIds = useControlSelector((control) => control[sceneType].ids)
  const sceneById = useControlSelector((control) => control[sceneType].byId)

  const strobeSceneIds = useControlSelector((control) => {
    const ids = control[sceneType].ids
    return ids.filter((id) =>
      control[sceneType].byId[id].name.includes('STROBE')
    )
  })

  const lightsOnDjScenes = useControlSelector((control) => {
    const ids = control[sceneType].ids
    return ids.filter((id) =>
      control[sceneType].byId[id].name.includes('Lights on the DJ')
    )
  })

  const offScene = useControlSelector((control) => {
    const ids = control[sceneType].ids
    return ids.find((id) => control[sceneType].byId[id].name == 'OFF')
  })

  const activeId = useControlSelector((control) => control[sceneType].active)

  const onBombacityChange = (newVal: number) => {
    dispatch(
      setAutoSceneBombacity({
        sceneType: sceneType,
        val: newVal,
      })
    )
  }

  const onPeriodChange = (newVal: number) => {
    dispatch(
      setAutoScenePeriod({
        sceneType: sceneType,
        val: newVal,
      })
    )
  }

  useEffect(() => {
    if (keyBindingsEnabled) {
      const newSceneFromEpicness = (epicnessLevel: number) => {
        const possibleScenes = sceneIds.filter((id) => {
          const lightScene = sceneById[id]
          if (lightScene) {
            return (
              lightScene.autoEnabled &&
              Math.abs(lightScene.epicness - epicnessLevel) < 0.5
            )
          }
          return false
        })
        if (possibleScenes.length > 0) {
          const newScene = randomElementExcludeCurrent(possibleScenes, activeId)
          dispatch(
            setActiveScene({
              sceneType,
              val: newScene,
            })
          )
        }
      }
      const keyListener = (e: KeyboardEvent) => {
        if (e.repeat) {
          return
        }

        let num = parseInt(e.key)
        if (!Number.isNaN(num)) {
          console.log(num)
          if (num === 0) {
            num = 10
          } else {
            num = num - 1
          }
          onBombacityChange(num / 10)
          newSceneFromEpicness(num / 10)
          dispatch(setAutoSceneEnabled({ sceneType, val: true }))
          return
        }

        if (e.key === ' ' || e.key === 's') {
          const scene =
            strobeSceneIds[Math.floor(Math.random() * strobeSceneIds.length)]

          if (e.key === 's') {
            dispatch(setAutoSceneEnabled({ sceneType, val: false }))
          }

          dispatch(
            setActiveScene({
              sceneType,
              val: scene,
            })
          )
          return
        }

        if (e.key === 'l' && lightsOnDjScenes.length > 0) {
          const scene =
            lightsOnDjScenes[
              Math.floor(Math.random() * lightsOnDjScenes.length)
            ]

          dispatch(setAutoSceneEnabled({ sceneType, val: false }))
          dispatch(
            setActiveScene({
              sceneType,
              val: scene,
            })
          )
          return
        }

        if (e.key === 'a') {
          if (!enabled) {
            dispatch(setAutoSceneEnabled({ sceneType, val: true }))
            newSceneFromEpicness(epicness)
          } else {
            dispatch(setAutoSceneEnabled({ sceneType, val: false }))
          }
          return
        }

        if (e.key === 'Escape' && offScene) {
          dispatch(setAutoSceneEnabled({ sceneType, val: false }))
          dispatch(
            setActiveScene({
              sceneType,
              val: offScene,
            })
          )
        }

        if (e.key === 'ArrowUp') {
          dispatch(setAutoScenePeriod({ sceneType, val: period * 2 }))
          return
        }

        if (e.key === 'ArrowDown') {
          dispatch(
            setAutoScenePeriod({ sceneType, val: Math.max(period / 2, 1) })
          )
          return
        }
      }

      const keyUpListener = (e: KeyboardEvent) => {
        if (e.key === ' ') {
          dispatch(setAutoSceneEnabled({ sceneType, val: true }))
          newSceneFromEpicness(epicness)
          return
        }
      }

      window.addEventListener('keydown', keyListener)
      window.addEventListener('keyup', keyUpListener)

      return () => {
        window.removeEventListener('keydown', keyListener)
        window.removeEventListener('keyup', keyUpListener)
      }
    }
    return undefined
  }, [
    strobeSceneIds,
    lightsOnDjScenes,
    epicness,
    sceneById,
    activeId,
    keyBindingsEnabled,
    offScene,
    enabled,
    period,
  ])

  return (
    <div>
      <Root>
        <ButtonMidiOverlay
          action={{
            type: 'toggleAutoScene',
            sceneType: sceneType,
          }}
        >
          <Button
            style={{
              backgroundColor: enabled ? '#3d5a' : '#fff3',
              color: enabled ? '#eee' : '#fff9',
            }}
            onClick={() =>
              dispatch(
                setAutoSceneEnabled({
                  sceneType: sceneType,
                  val: !enabled,
                })
              )
            }
          >
            auto
          </Button>
        </ButtonMidiOverlay>

        <DraggableNumber
          value={period}
          min={1}
          max={64}
          onChange={onPeriodChange}
          style={{
            backgroundColor: '#0005',
            color: enabled ? '#fff' : '#fff5',
          }}
        />
        {sceneType === 'light' && (
          <SliderMidiOverlay
            action={{ type: 'setAutoSceneBombacity' }}
            style={{
              flex: '1 0 auto',
              marginLeft: '0.5rem',
              padding: '0.5rem',
            }}
          >
            <Slider
              value={epicness}
              radius={enabled ? 0.5 : 0.4}
              orientation="horizontal"
              onChange={onBombacityChange}
              color={enabled ? '#3d5e' : undefined}
            />
          </SliderMidiOverlay>
        )}
      </Root>
      <Checkbox
        label="Key bindings"
        checked={keyBindingsEnabled}
        onChange={setKeyBindings}
      />
    </div>
  )
}

const Root = styled.div`
  display: flex;
  align-items: center;
  margin-bottom: 0.5rem;
`

const Button = styled.div`
  border-radius: 0.3rem;
  padding: 0.1rem 0.3rem;
  cursor: pointer;
  font-size: 0.9rem;
  margin-right: 0.5rem;
`
