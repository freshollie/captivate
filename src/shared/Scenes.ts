import { Params, initBaseParams } from './params'
import {
  Modulator,
  initModulator,
  type ModManualAnchor,
  type SplitModShaping,
} from './modulation'
import { RandomizerOptions, initRandomizerOptions } from './randomizer'
import { ColorChaseConfig, cloneColorChase } from './colorChase'
import { nanoid } from 'nanoid'
import {
  LayerConfig,
  initLayerConfig,
} from '../visualizer/threejs/layers/LayerConfig'

export interface SceneBase {
  name: string
  epicness: number
  autoEnabled: boolean
}

export interface SplitScene_t {
  baseParams: Params
  /**
   * Per-parameter manual cursor anchor for combining modulation with the base
   * set-point (see `ModManualAnchor` in modulation.ts).
   */
  modManualAnchors?: Partial<Record<string, ModManualAnchor>>
  /**
   * Optional invert / phase offset / stair-step applied to LFO drivers on this split only.
   */
  splitModShaping?: SplitModShaping
  randomizer: RandomizerOptions
  /**
   * Optional beat-stepped colour sequence for this split (see colorChase.ts).
   * Absent on splits that have never used one, so old saves load untouched.
   */
  colorChase?: ColorChaseConfig
  // true = include group | false = include not group
  groups: { [key: string]: boolean | undefined }
}

export function initSplitScene(): SplitScene_t {
  return {
    baseParams: initBaseParams(),
    randomizer: initRandomizerOptions(),
    groups: {},
  }
}

/**
 * Deep-copies a split so clipboard entries and pasted splits never alias the
 * scene they came from. Optional blocks stay absent rather than becoming
 * `undefined` keys, matching what the reducers persist.
 */
export function cloneSplitScene(split: SplitScene_t): SplitScene_t {
  return {
    baseParams: { ...split.baseParams },
    randomizer: { ...split.randomizer },
    groups: { ...split.groups },
    ...(split.colorChase !== undefined
      ? { colorChase: cloneColorChase(split.colorChase) }
      : {}),
    ...(split.modManualAnchors !== undefined
      ? { modManualAnchors: { ...split.modManualAnchors } }
      : {}),
    ...(split.splitModShaping !== undefined
      ? { splitModShaping: { ...split.splitModShaping } }
      : {}),
  }
}

/**
 * A split copied out of one scene, ready to paste into another.
 *
 * Only the split's own configuration travels — groups, base params, randomizer
 * and shaping. Modulation amounts live on the scene's modulators and stay
 * behind: they are keyed to LFOs the destination scene may not have, so a
 * pasted split lands unmodulated and is wired up in the new scene.
 */
export interface SplitSceneClipboard {
  splitScene: SplitScene_t
  /** Scene the split was copied from, for the paste tooltip. */
  sourceSceneName: string
  /** Heading of the copied split, e.g. `Split 2 - Movers`. */
  sourceSplitLabel: string
}

export interface LightScene_t extends SceneBase {
  modulators: Modulator[]
  splitScenes: SplitScene_t[]
}

export function initLightScene(): LightScene_t {
  return {
    name: 'Name',
    epicness: 0,
    autoEnabled: true,
    modulators: [initModulator(1)],
    splitScenes: [initSplitScene()],
  }
}

export interface VisualScene_t extends SceneBase {
  config: LayerConfig
  transition: VisualSceneTransitionConfig
}

export type VisualSceneTransitionType =
  | 'cut'
  | 'fade'
  | 'dissolve'
  | 'flash'

export interface VisualSceneTransitionConfig {
  type: VisualSceneTransitionType
  durationMs: number
}

export function initVisualSceneTransitionConfig(): VisualSceneTransitionConfig {
  return {
    type: 'fade',
    durationMs: 420,
  }
}

export function initVisualScene(): VisualScene_t {
  return {
    name: 'Name',
    epicness: 0,
    autoEnabled: true,
    config: initLayerConfig('builtin'),
    transition: initVisualSceneTransitionConfig(),
  }
}

export function initVisualScenesState(): VisualScenes_t {
  const scenes = [
    { name: 'Pulse Grid', epicness: 0.15, preset: 'Pulse Grid' },
    { name: 'Neon Peaks', epicness: 0.45, preset: 'Neon Peaks' },
    { name: 'Orbit Wells', epicness: 0.7, preset: 'Orbit Wells' },
    { name: 'Energy Stack', epicness: 0.95, preset: 'Energy Stack' },
  ]

  const ids: string[] = []
  const byId: { [key: string]: VisualScene_t } = {}

  for (const scene of scenes) {
    const id = nanoid()
    const config = initLayerConfig('builtin')
    config.builtin.preset = scene.preset
    ids.push(id)
    byId[id] = {
      name: scene.name,
      epicness: scene.epicness,
      autoEnabled: true,
      config,
      transition: initVisualSceneTransitionConfig(),
    }
  }

  return {
    ids,
    byId,
    active: ids[0],
    auto: {
      enabled: false,
      epicness: 0,
      period: 1,
      energyMatchEnabled: false,
      matchAudioEnergy: false,
      levelMatchEnabled: false,
      epicnessLevel: 0,
    },
  }
}

export interface AutoScene_t {
  enabled: boolean
  /** Manual energy target when energy matching uses the slider (not live audio). */
  epicness: number
  period: number
  /** When true, auto picks by closest scene energy on each period instead of random. */
  energyMatchEnabled: boolean
  /** When energy matching is on and audio input is active: use live audio energy. */
  matchAudioEnergy: boolean
  /**
   * When true, each period re-rolls the energy level button that was last pressed -
   * the same pick as pressing that level again - instead of matching energy or
   * choosing at random. Mutually exclusive with {@link energyMatchEnabled}.
   */
  levelMatchEnabled: boolean
  /** Energy level button (1..11) that level matching re-rolls; 0 until one is pressed. */
  epicnessLevel: number
}

type SceneID = string

interface ScenesState<T> {
  ids: SceneID[]
  byId: { [key: SceneID]: T }
  active: SceneID
  auto: AutoScene_t
}

export type LightScenes_t = ScenesState<LightScene_t>
export type VisualScenes_t = ScenesState<VisualScene_t>

export interface ScenesStateBundle {
  light: LightScenes_t
  visual: VisualScenes_t
}

export type SceneType = keyof ScenesStateBundle

export function initScenesState<T>(defaultScene: T): ScenesState<T> {
  const initID = nanoid()
  return {
    ids: [initID],
    byId: {
      [initID]: defaultScene,
    },
    active: initID,
    auto: {
      enabled: false,
      epicness: 0,
      period: 1,
      energyMatchEnabled: false,
      matchAudioEnergy: false,
      levelMatchEnabled: false,
      epicnessLevel: 0,
    },
  }
}
