import { randomElementExcludeCurrent } from './util'
import { AutoScene_t } from './Scenes'
import { TimeState, isNewPeriod } from './TimeState'
import { CleanReduxState } from '../renderer/redux/store'
import { RealtimeState } from '../renderer/redux/realtimeStore'

type OnNewScene = (id: string) => void

interface UserModified {
  beats: number
  scene: string
}

function initUserModified(): UserModified {
  return {
    beats: 0,
    scene: '',
  }
}

const _lastUserModified = {
  light: initUserModified(),
  visual: initUserModified(),
}

export function handleAutoScene(
  lastRtState: RealtimeState,
  nextTimeState: TimeState,
  controlState: CleanReduxState,
  onNewLightScene: OnNewScene,
  onNewVisualScene: OnNewScene
) {
  const { light, visual } = controlState.control

  let possibleLightIds = light.ids.filter((id) => {
    const lightScene = light.byId[id]
    if (lightScene) {
      return (
        lightScene.autoEnabled &&
        Math.abs(lightScene.epicness - light.auto.epicness) < 0.15
      )
    }
    return false
  })
  if (
    isNewScene(
      light.active,
      lastRtState.time.beats,
      nextTimeState,
      light.auto,
      _lastUserModified.light
    )
  ) {
    const newScene = randomElementExcludeCurrent(possibleLightIds, light.active)
    _lastUserModified.light.scene = newScene
    onNewLightScene(newScene)
  }

  let possibleVisualIds = visual.ids.filter((id) => {
    const visualScene = visual.byId[id]
    if (visualScene) {
      return visualScene.autoEnabled
    }
    return false
  })
  if (
    isNewScene(
      visual.active,
      lastRtState.time.beats,
      nextTimeState,
      visual.auto,
      _lastUserModified.visual
    )
  ) {
    const newScene = randomElementExcludeCurrent(
      possibleVisualIds,
      visual.active
    )
    _lastUserModified.visual.scene = newScene
    onNewVisualScene(newScene)
  }
}

function isNewScene(
  activeScene: string,
  beatsLast: number,
  nextTimeState: TimeState,
  auto: AutoScene_t,
  lastUserModified: UserModified
): boolean {
  const beatsPerScene = nextTimeState.quantum * auto.period
  if (activeScene !== lastUserModified.scene) {
    lastUserModified.scene = activeScene
    lastUserModified.beats = nextTimeState.beats
  }
  if (auto.enabled) {
    if (isNewPeriod(beatsLast, nextTimeState.beats, beatsPerScene)) {
      if (nextTimeState.beats - lastUserModified.beats > beatsPerScene) {
        return true
      } else {
      }
    }
  }
  return false
}
