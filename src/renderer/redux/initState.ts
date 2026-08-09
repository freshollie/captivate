import { initDmxState } from 'renderer/redux/dmxSlice'
import { initGuiState } from 'renderer/redux/guiSlice'
import { initControlState } from 'renderer/redux/controlSlice'
import { initMixerState } from 'renderer/redux/mixerSlice'
import { initGroupControlState } from 'renderer/redux/groupControlSlice'
import { initLaserState } from 'renderer/laser/laserProjectState'
import { CleanReduxState } from './store'

export default function initState(): CleanReduxState {
  return {
    dmx: initDmxState(),
    gui: initGuiState(),
    control: initControlState(),
    mixer: initMixerState(),
    groupControl: initGroupControlState(),
    laser: initLaserState(),
  }
}
