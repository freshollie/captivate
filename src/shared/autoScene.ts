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
  light: LightScenes_t,
  candidateIds: string[],
  audio: AudioEngineMetrics
): string {
  const auto = light.auto
  const currentId = light.active

  if (auto.levelMatchEnabled === true) {
    const level = resolveAutoSceneEpicnessLevel(light)
    if (level === null) {
      return currentId
    }
    // Exactly what pressing that level button again would give, queue and all, so a
    // level plays all the way round before anything repeats.
    return pickSceneForEpicnessLevel(light, level) ?? currentId
  }

  if (auto.energyMatchEnabled !== true) {
    return randomElementExcludeCurrent(candidateIds, currentId)
  }
  const targetEnergy = getAutoSceneTargetEnergy(auto, audio)
  return pickSceneByClosestEnergy(
    candidateIds,
    currentId,
    targetEnergy,
    (id) => light.byId[id]?.epicness
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
export const EPICNESS_LEVEL_COUNT = EPICNESS_LEVEL_MAX - EPICNESS_LEVEL_MIN + 1

/**
 * The scenes each epicness level owns, quietest level first.
 *
 * Split by *count*, not by epicness value: scenes are ranked by epicness and cut into
 * equal-sized groups, so every scene belongs to exactly one level and each level holds
 * roughly `scenes / 11` of them. A fixed epicness window per level instead leaves the
 * levels lopsided wherever the values clump - which they do, since the generator ladder
 * is dense at the top and hand-set values gather around the round numbers - so a
 * crowded window hoards scenes while a sparse one has almost nothing to offer.
 *
 * With fewer scenes than levels there is nothing to split, so several levels share the
 * nearest-ranked scene and every button still does something.
 */
export function epicnessLevelSceneBuckets(light: LightScenes_t): string[][] {
  const ranked = light.ids
    .filter((id) => light.byId[id] !== undefined && light.byId[id].autoEnabled)
    .map((id, order) => ({
      id,
      order,
      epicness: clamp01(light.byId[id]?.epicness ?? 0),
    }))
    // Ties keep scene order, so the buckets are stable between presses.
    .sort((a, b) => a.epicness - b.epicness || a.order - b.order)
    .map((entry) => entry.id)

  const count = ranked.length
  const buckets: string[][] = []

  for (let level = 0; level < EPICNESS_LEVEL_COUNT; level++) {
    const start = Math.floor((level * count) / EPICNESS_LEVEL_COUNT)
    const end = Math.floor(((level + 1) * count) / EPICNESS_LEVEL_COUNT)
    if (end > start) {
      buckets.push(ranked.slice(start, end))
      continue
    }
    if (count === 0) {
      buckets.push([])
      continue
    }
    const nearest = Math.min(
      count - 1,
      Math.floor(((level + 0.5) * count) / EPICNESS_LEVEL_COUNT)
    )
    buckets.push([ranked[nearest]!])
  }

  return buckets
}

/** Level 1..11 as an index into {@link epicnessLevelSceneBuckets}. */
function epicnessLevelToBucketIndex(level: number): number {
  const clamped = Math.min(
    EPICNESS_LEVEL_MAX,
    Math.max(EPICNESS_LEVEL_MIN, Math.round(level))
  )
  return clamped - EPICNESS_LEVEL_MIN
}

/**
 * Light scene ids in the order they were last seen, oldest first.
 *
 * The epicness buttons treat this as a queue: a level plays all the way round before it
 * repeats, rather than re-rolling and landing on the scene it just played. Pressing 1,
 * then 2, then 1 gives a second level-1 scene, and the first one only comes back once
 * the rest of that level has had a turn.
 */
let _sceneRecency: string[] = []

function noteSceneSeen(id: string) {
  const seenAt = _sceneRecency.indexOf(id)
  if (seenAt !== -1) {
    _sceneRecency.splice(seenAt, 1)
  }
  _sceneRecency.push(id)
}

/**
 * The candidate that has gone longest unseen, random among those tied for oldest.
 *
 * Scenes missing from the log have never played, so they sort ahead of everything in
 * it - a fresh level hands out its untouched scenes first. Ties are broken randomly so
 * a level that has never been pressed doesn't always open on the same scene.
 */
function pickLeastRecentlySeen(
  candidates: string[],
  random: () => number
): string | null {
  let oldest = Infinity
  let tied: string[] = []

  for (const id of candidates) {
    const seenAt = _sceneRecency.indexOf(id)
    const age = seenAt === -1 ? -1 : seenAt
    if (age < oldest) {
      oldest = age
      tied = [id]
    } else if (age === oldest) {
      tied.push(id)
    }
  }

  if (tied.length === 0) return null
  const index = Math.floor(clamp01(random()) * tied.length)
  return tied[Math.min(index, tied.length - 1)] ?? null
}

/**
 * Which scene an epicness button should switch to, or null to stay put.
 *
 * The active scene is never a candidate and the rest of the level is ordered by how
 * long ago it last played, so pressing the same level repeatedly walks the whole level
 * before anything is heard twice. When the level holds nothing else the answer is null
 * and the caller leaves the scene alone rather than restarting the current one.
 *
 * Presses move the queue on, so this is called once per press - not to preview.
 */
export function pickSceneForEpicnessLevel(
  light: LightScenes_t,
  level: number,
  random: () => number = Math.random
): string | null {
  // Scenes deleted since they played would otherwise sit in the queue for the session.
  _sceneRecency = _sceneRecency.filter((id) => light.byId[id] !== undefined)
  // Whatever is playing has just been seen, however it was reached, so a manual pick or
  // an auto-scene switch sends it to the back of its level's queue as well.
  if (light.byId[light.active] !== undefined) {
    noteSceneSeen(light.active)
  }

  const bucket =
    epicnessLevelSceneBuckets(light)[epicnessLevelToBucketIndex(level)] ?? []
  const candidates = bucket.filter((id) => id !== light.active)

  const next = pickLeastRecentlySeen(candidates, random)
  if (next !== null) {
    noteSceneSeen(next)
  }
  return next
}

/** The level whose bucket holds `sceneId`, or null when no level does. */
export function epicnessLevelOfScene(
  light: LightScenes_t,
  sceneId: string
): number | null {
  const buckets = epicnessLevelSceneBuckets(light)
  for (let index = 0; index < buckets.length; index++) {
    if (buckets[index]?.includes(sceneId) === true) {
      return index + EPICNESS_LEVEL_MIN
    }
  }
  return null
}

/**
 * The level auto re-rolls in level mode, or null when there is nothing to re-roll.
 *
 * Normally the button last pressed. Until one has been pressed the level of whatever
 * is playing stands in for it, so switching the mode on carries on from the look you
 * are already on rather than sitting idle until you touch a button.
 */
export function resolveAutoSceneEpicnessLevel(
  light: LightScenes_t
): number | null {
  const pressed = light.auto.epicnessLevel
  if (
    Number.isFinite(pressed) &&
    pressed >= EPICNESS_LEVEL_MIN &&
    pressed <= EPICNESS_LEVEL_MAX
  ) {
    return Math.round(pressed)
  }
  return epicnessLevelOfScene(light, light.active)
}

/** Next light scene auto would pick at the current energy (for UI cue highlight). */
export function resolveLightAutoSceneCueId(
  light: LightScenes_t,
  targetEnergy: number
): string | null {
  // Level mode has no cue: its next pick comes from the play queue the engine keeps,
  // which the UI cannot read without advancing it.
  if (
    !light.auto.enabled ||
    light.auto.levelMatchEnabled === true ||
    light.auto.energyMatchEnabled !== true
  ) {
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
    const newScene = pickLightAutoScene(light, possibleLightIds, audio)
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
  _sceneRecency = []
}

export function __getAutoSceneTrackerForTest(sceneType: 'light' | 'visual') {
  return _trackers[sceneType]
}
