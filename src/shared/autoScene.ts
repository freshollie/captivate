import { randomElementExcludeCurrent } from './util'
import { AutoScene_t, LightScenes_t } from './Scenes'
import { TimeState, isNewPeriod } from './TimeState'
import { CleanReduxState } from '../renderer/redux/store'
import { RealtimeState } from '../renderer/redux/realtimeStore'
import type { AudioEngineMetrics } from './audioEngine'

type OnNewScene = (id: string) => void

interface SceneAutoTracker {
  beats: number
  scene: string
  /** Scene id auto dispatched but not yet reflected in active. */
  pendingAutoScene: string | null
}

function initSceneAutoTracker(): SceneAutoTracker {
  return {
    beats: 0,
    scene: '',
    pendingAutoScene: null,
  }
}

const _trackers = {
  light: initSceneAutoTracker(),
  visual: initSceneAutoTracker(),
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(1, Math.max(0, value))
}

/** Closest epicness match; random among ties (still may pick current if only tie). */
export function pickSceneByClosestEnergy(
  candidateIds: string[],
  currentId: string,
  targetEnergy: number,
  getEpicness: (id: string) => number | undefined
): string {
  if (candidateIds.length === 0) {
    return currentId
  }

  const target = clamp01(targetEnergy)
  let bestDistance = Infinity
  const tied: string[] = []

  for (const id of candidateIds) {
    const epicness = getEpicness(id)
    if (epicness === undefined || !Number.isFinite(epicness)) {
      continue
    }
    const distance = Math.abs(clamp01(epicness) - target)
    if (distance < bestDistance - 1e-9) {
      bestDistance = distance
      tied.length = 0
      tied.push(id)
    } else if (Math.abs(distance - bestDistance) < 1e-9) {
      tied.push(id)
    }
  }

  if (tied.length === 0) {
    return currentId
  }
  return randomElementExcludeCurrent(tied, currentId)
}

function pickLightAutoScene(
  auto: AutoScene_t,
  candidateIds: string[],
  currentId: string,
  audio: AudioEngineMetrics,
  getEpicness: (id: string) => number | undefined
): string {
  if (auto.energyMatchEnabled !== true) {
    return randomElementExcludeCurrent(candidateIds, currentId)
  }
  const targetEnergy = getAutoSceneTargetEnergy(auto, audio)
  return pickSceneByClosestEnergy(
    candidateIds,
    currentId,
    targetEnergy,
    getEpicness
  )
}

export function getAutoSceneTargetEnergy(
  auto: AutoScene_t,
  audio: AudioEngineMetrics
): number {
  if (auto.matchAudioEnergy === true && audio.enabled === true) {
    return clamp01(audio.energyLevel)
  }
  return clamp01(auto.epicness)
}

export const EPICNESS_LEVEL_MIN = 1
export const EPICNESS_LEVEL_MAX = 11

/**
 * How far either side of the chosen level a scene can sit and still count.
 *
 * Expressed in levels, so it does not have to be restated if the scale changes. A
 * window rather than an exact match is what makes the button useful: it gives the
 * picker several scenes to alternate between at a given intensity.
 */
export const EPICNESS_LEVEL_TOLERANCE = 1.5

/** Level 1..11 as the 0..1 epicness scenes are stored in. */
export function epicnessLevelToEnergy(level: number): number {
  const clamped = Math.min(
    EPICNESS_LEVEL_MAX,
    Math.max(EPICNESS_LEVEL_MIN, Math.round(level))
  )
  return (clamped - EPICNESS_LEVEL_MIN) / (EPICNESS_LEVEL_MAX - EPICNESS_LEVEL_MIN)
}

/**
 * Which scene an epicness button should switch to, or null to stay put.
 *
 * The active scene is never a candidate, so pressing the same level twice moves to a
 * different scene of that intensity. When nothing else is in range the answer is
 * null and the caller leaves the scene alone rather than restarting the current one.
 */
export function pickSceneForEpicnessLevel(
  light: LightScenes_t,
  level: number,
  random: () => number = Math.random
): string | null {
  const target = epicnessLevelToEnergy(level)
  const tolerance =
    EPICNESS_LEVEL_TOLERANCE / (EPICNESS_LEVEL_MAX - EPICNESS_LEVEL_MIN)

  const candidates = light.ids.filter((id) => {
    if (id === light.active) return false
    const epicness = light.byId[id]?.epicness
    if (epicness === undefined || !Number.isFinite(epicness)) return false
    return Math.abs(clamp01(epicness) - target) <= tolerance + 1e-9
  })

  if (candidates.length === 0) return null
  const index = Math.floor(clamp01(random()) * candidates.length)
  return candidates[Math.min(index, candidates.length - 1)] ?? null
}

/** Next light scene auto would pick at the current energy (for UI cue highlight). */
export function resolveLightAutoSceneCueId(
  light: LightScenes_t,
  targetEnergy: number
): string | null {
  if (!light.auto.enabled || light.auto.energyMatchEnabled !== true) {
    return null
  }
  const candidates = light.ids.filter((id) => light.byId[id]?.autoEnabled === true)
  if (candidates.length === 0) {
    return null
  }
  const cue = pickSceneByClosestEnergy(
    candidates,
    light.active,
    targetEnergy,
    (id) => light.byId[id]?.epicness
  )
  return cue === light.active ? null : cue
}

/** Sync tracker when active scene changes; distinguish user picks from pending auto dispatch. */
function syncSceneTracker(
  activeScene: string,
  nextTimeState: TimeState,
  tracker: SceneAutoTracker
) {
  if (tracker.pendingAutoScene !== null) {
    if (activeScene === tracker.pendingAutoScene) {
      tracker.scene = activeScene
      tracker.pendingAutoScene = null
    }
    return
  }
  if (activeScene !== tracker.scene) {
    tracker.scene = activeScene
    tracker.beats = nextTimeState.beats
    tracker.pendingAutoScene = null
  }
}

function shouldAdvanceAutoScene(
  beatsLast: number,
  nextTimeState: TimeState,
  auto: AutoScene_t,
  tracker: SceneAutoTracker
): boolean {
  if (!auto.enabled || tracker.pendingAutoScene !== null) {
    return false
  }
  const beatsPerScene = nextTimeState.quantum * auto.period
  if (!isNewPeriod(beatsLast, nextTimeState.beats, beatsPerScene)) {
    return false
  }
  return nextTimeState.beats - tracker.beats >= beatsPerScene
}

function applyAutoSceneSwitch(
  activeScene: string,
  nextTimeState: TimeState,
  tracker: SceneAutoTracker,
  newScene: string,
  onNewScene: OnNewScene
) {
  tracker.beats = nextTimeState.beats
  if (newScene !== activeScene) {
    tracker.pendingAutoScene = newScene
    onNewScene(newScene)
  } else {
    tracker.scene = activeScene
  }
}

export function handleAutoScene(
  lastRtState: RealtimeState,
  nextTimeState: TimeState,
  controlState: CleanReduxState,
  onNewLightScene: OnNewScene,
  onNewVisualScene: OnNewScene
) {
  const { light, visual } = controlState.control
  const audio = lastRtState.audio
  const lightTracker = _trackers.light
  const visualTracker = _trackers.visual

  syncSceneTracker(light.active, nextTimeState, lightTracker)

  const possibleLightIds = light.ids.filter((id) => light.byId[id]?.autoEnabled === true)

  if (
    shouldAdvanceAutoScene(
      lastRtState.time.beats,
      nextTimeState,
      light.auto,
      lightTracker
    )
  ) {
    const newScene = pickLightAutoScene(
      light.auto,
      possibleLightIds,
      light.active,
      audio,
      (id) => light.byId[id]?.epicness
    )
    applyAutoSceneSwitch(
      light.active,
      nextTimeState,
      lightTracker,
      newScene,
      onNewLightScene
    )
  }

  syncSceneTracker(visual.active, nextTimeState, visualTracker)

  const possibleVisualIds = visual.ids.filter((id) => {
    const visualScene = visual.byId[id]
    if (visualScene) {
      return visualScene.autoEnabled
    }
    return false
  })
  if (
    shouldAdvanceAutoScene(
      lastRtState.time.beats,
      nextTimeState,
      visual.auto,
      visualTracker
    )
  ) {
    const newScene = randomElementExcludeCurrent(
      possibleVisualIds,
      visual.active
    )
    applyAutoSceneSwitch(
      visual.active,
      nextTimeState,
      visualTracker,
      newScene,
      onNewVisualScene
    )
  }
}

/** @internal Test helpers */
export function __resetAutoSceneTrackersForTest() {
  _trackers.light = initSceneAutoTracker()
  _trackers.visual = initSceneAutoTracker()
}

export function __getAutoSceneTrackerForTest(sceneType: 'light' | 'visual') {
  return _trackers[sceneType]
}
