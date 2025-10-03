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
import { useEffect, useRef, useState } from 'react'
import { randomElementExcludeCurrent } from 'shared/util'
import Checkbox from '../base/LabelledCheckbox'
import { send_user_command } from 'renderer/ipcHandler'
import { useRealtimeSelector } from 'renderer/redux/realtimeStore'

const INTRO_BEATS = [
  32, // 1
  27, // 2
  1, // 2.1
  4, // 3
  32, // 4
  26, // 5
  5, // 6
  Infinity,
]

export default function AutoScene({ sceneType }: { sceneType: SceneType }) {
  const [keyBindingsEnabled, setKeyBindings] = useState(false)
  const [prevScene, setPrevScene] = useState<string>();
  const [specialScene, setSpecialScene] = useState<string>();
  const dispatch = useDispatch()
  const { enabled, epicness, period } = useControlSelector(
    (control) => control[sceneType].auto
  )

  const sceneIds = useControlSelector((control) => control[sceneType].ids)
  const sceneById = useControlSelector((control) => control[sceneType].byId)
  const bpm = useRealtimeSelector((state) => state.time.bpm)
  const beats = useRealtimeSelector((state) =>
    parseFloat(state.time.beats.toFixed(2))
  )
  const activeId = useControlSelector((control) => control[sceneType].active)

  const introSceneChangeBeat = useRef(0)

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

  const closeDiscoScenes = useControlSelector((control) => {
    const ids = control[sceneType].ids
    return ids.filter((id) =>
      control[sceneType].byId[id].name.includes('DISCO') && Math.abs(control[sceneType].byId[id].epicness - epicness) < 0.2
    )
  })

  const closeLaserScenes = useControlSelector((control) => {
    const ids = control[sceneType].ids
    return ids.filter((id) =>
      control[sceneType].byId[id].name.includes('lasers') && Math.abs(control[sceneType].byId[id].epicness - epicness) < 0.13
    )
  })

  const closeStrobeScenes = useControlSelector((control) => {
    const ids = control[sceneType].ids
    return ids.filter((id) =>
      control[sceneType].byId[id].name.toLowerCase().includes('strobe') && Math.abs(control[sceneType].byId[id].epicness - epicness) < 0.2
    )
  })

  const introScenes = useControlSelector((control) => {
    const ids = control[sceneType].ids
    return ids.filter((id) =>
      control[sceneType].byId[id].name.includes('INTRO')
    )
  })

  useEffect(() => {
    const introSceneIndex = introScenes.indexOf(activeId)
    if (introSceneIndex < 0) {
      introSceneChangeBeat.current = -1
      return
    }

    if (
      introSceneChangeBeat.current > -1 &&
      beats - introSceneChangeBeat.current >
        (INTRO_BEATS[introSceneIndex] ?? Infinity)
    ) {
      let nextSceneIndex = introSceneIndex + 1
      if (!introScenes[nextSceneIndex] || !introScenes.includes(activeId)) {
        return
      }

      dispatch(
        setActiveScene({
          sceneType,
          val: introScenes[nextSceneIndex],
        })
      )
      introSceneChangeBeat.current = beats
    }
  }, [beats, introSceneChangeBeat, activeId, introScenes])

  const offScene = useControlSelector((control) => {
    const ids = control[sceneType].ids
    return ids.find((id) => control[sceneType].byId[id].name == 'OFF')
  })

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
        // and we previously switched from our scene
        // we are going back to our existing level
        if (prevScene && epicnessLevel === epicness) {
          dispatch(
            setActiveScene({
              sceneType,
              val: prevScene,
            })
          )
          setPrevScene(undefined);
          return
        }

        // If we are changing epicness level
        // and not switching from a special scene
        // then we are forget the special scene
        if (specialScene) {
          setSpecialScene(undefined);
        }

        const possibleScenes = sceneIds.filter((id) => {
          const lightScene = sceneById[id]
          if (lightScene) {
            return (
              lightScene.autoEnabled &&
              Math.abs(lightScene.epicness - epicnessLevel) < 0.1
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
        e.preventDefault();
        if (e.repeat) {
          return
        }
        
        if (e.key === 'Enter' && introScenes.length > 0) {
          let nextSceneIndex = introScenes.indexOf(activeId) + 1
          if (!introScenes[nextSceneIndex] || !introScenes.includes(activeId)) {
            nextSceneIndex = 0
          }
          dispatch(
            setActiveScene({
              sceneType,
              val: introScenes[nextSceneIndex],
            })
          )
          dispatch(setAutoSceneEnabled({ sceneType, val: false }))
          // set tempo
          send_user_command({ type: 'IncrementTempo', amount: 160 - bpm })
          introSceneChangeBeat.current = beats
          return
        }

        // Prevent the intro from auto moving on if we use any other input
        introSceneChangeBeat.current = -1

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

        // Just strobe
        if (e.key === 's' && strobeSceneIds.length > 0) {
          if (specialScene && strobeSceneIds.includes(specialScene)) {
            if (activeId !== specialScene) {
              setPrevScene(activeId);
              dispatch(
                setActiveScene({
                  sceneType,
                  val: specialScene,
                })
              )
              return;
            }
            setSpecialScene(undefined);
          } 
          const scene =
            strobeSceneIds[Math.floor(Math.random() * strobeSceneIds.length)]
          
          setPrevScene(activeId);
          setSpecialScene(scene);

          dispatch(setAutoSceneEnabled({ sceneType, val: false }))
          dispatch(
            setActiveScene({
              sceneType,
              val: scene,
            })
          )
          return
        }

        // close strobe
        if (e.key === ' ' && closeStrobeScenes.length > 0) {
          if (specialScene && closeStrobeScenes.includes(specialScene)) {
            if (activeId !== specialScene) {
              setPrevScene(activeId);
              dispatch(
                setActiveScene({
                  sceneType,
                  val: specialScene,
                })
              )
              return;
            }
            setSpecialScene(undefined);
          }
  
          const scene =
            closeStrobeScenes[Math.floor(Math.random() * closeStrobeScenes.length)]
          
          setPrevScene(activeId);
          setSpecialScene(scene);

          dispatch(setAutoSceneEnabled({ sceneType, val: false }))
          dispatch(
            setActiveScene({
              sceneType,
              val: scene,
            })
          )
          return
        }

        if (e.key === 'v' && lightsOnDjScenes.length > 0) {
          const scene =
            lightsOnDjScenes[
              Math.floor(Math.random() * lightsOnDjScenes.length)
            ]
          
          setPrevScene(activeId);
          dispatch(setAutoSceneEnabled({ sceneType, val: false }))
          dispatch(
            setActiveScene({
              sceneType,
              val: scene,
            })
          )
          return
        }

        if (e.key === 'l' && closeLaserScenes.length > 0) {
          if (specialScene && closeLaserScenes.includes(specialScene)) {
            if (activeId !== specialScene) {
              setPrevScene(activeId);
              dispatch(
                setActiveScene({
                  sceneType,
                  val: specialScene,
                })
              )
              return;
            }
            setSpecialScene(undefined);
          }

          const scene =
            closeLaserScenes[
              Math.floor(Math.random() * closeLaserScenes.length)
            ]
          
          setPrevScene(activeId);
          setSpecialScene(scene);
          dispatch(setAutoSceneEnabled({ sceneType, val: false }))
          dispatch(
            setActiveScene({
              sceneType,
              val: scene,
            })
          )
          return
        }

        if (e.key === 'd' && closeDiscoScenes.length > 0) {
          if (specialScene && closeDiscoScenes.includes(specialScene)) {
            if (activeId !== specialScene) {
              setPrevScene(activeId);
              dispatch(
                setActiveScene({
                  sceneType,
                  val: specialScene,
                })
              )
              return;
            }
            setSpecialScene(undefined);
          }
          const scene =
            closeDiscoScenes[
              Math.floor(Math.random() * closeDiscoScenes.length)
            ]
          setPrevScene(activeId);
          setSpecialScene(scene);
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
        e.preventDefault();
        if (e.key === ' ' && (strobeSceneIds.includes(activeId) || closeStrobeScenes.includes(activeId))) {
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
    closeLaserScenes,
    closeStrobeScenes,
    closeDiscoScenes,
    epicness,
    sceneById,
    activeId,
    keyBindingsEnabled,
    offScene,
    enabled,
    period,
    bpm,
    beats,
    prevScene,
    specialScene,
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
