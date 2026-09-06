/**
 * Which lamp answers for which control, per controller.
 *
 * Controllers that light their own buttons rarely do it at the address the button
 * transmits. On the M-VAVE SMC-Mixer the pads send CC 20-51 while their lamps answer to
 * note ids 0-31, in a different row order again — so feedback needs a translation from
 * the address Captivate has bound to the address the lamp listens on.
 *
 * Deliberately a static table rather than anything learned at runtime: it is a property
 * of the hardware, not of the show, and one table per device is far less to maintain than
 * a mapping UI. Adding a controller means adding a `MidiLedProfile` below.
 *
 * The mapping here was captured with the tools in `tools/midi-led`, by lighting one id at
 * a time and recording which pad the operator pressed while it was lit.
 */

export interface MidiLedProfile {
  name: string
  /** Matched as a substring against the MIDI output port name. */
  portMatch: string
  /** MIDI channel the lamp messages go out on, 0-15. */
  lampChannel: number
  /** Value that lights a lamp. On this device it selects a colour, not a brightness. */
  onValue: number
  offValue: number
  /** Bound input id (see `midiInputID`) -> the note id its lamp answers to. */
  lampByInputID: { [inputID: string]: number }
}

/**
 * A run of consecutive pads: CC `ccFirst`..`ccLast` light note ids from `noteFirst` up.
 *
 * Rows are listed in *lamp* order, which is not the order the CC numbers run in — the
 * lamp grid starts on the CC 36-43 row, not the CC 20-27 one.
 */
interface CcRun {
  ccFirst: number
  ccLast: number
  noteFirst: number
}

/** Buttons transmit on MIDI channel 1, so their input ids are prefixed `0`. */
const SMC_MIXER_BUTTON_CHANNEL = 0

const SMC_MIXER_RUNS: CcRun[] = [
  { ccFirst: 36, ccLast: 43, noteFirst: 0 },
  { ccFirst: 28, ccLast: 35, noteFirst: 8 },
  { ccFirst: 20, ccLast: 27, noteFirst: 16 },
  { ccFirst: 44, ccLast: 51, noteFirst: 24 },
  // The bottom row (CC 52-62) is deliberately absent: the capture returned conflicting
  // note ids for it across passes, and an unmapped pad simply stays dark, where a wrong
  // one would light a pad that has nothing to do with the control.
]

function buildLampMap(runs: CcRun[], channel: number) {
  const map: { [inputID: string]: number } = {}
  for (const run of runs) {
    for (let offset = 0; offset <= run.ccLast - run.ccFirst; offset++) {
      map[`${channel}cc${run.ccFirst + offset}`] = run.noteFirst + offset
    }
  }
  return map
}

export const MIDI_LED_PROFILES: MidiLedProfile[] = [
  {
    name: 'M-VAVE SMC-Mixer',
    portMatch: 'SMC-Mixer',
    lampChannel: 0,
    // Confirmed lighting pads alongside 1, 5, 20 and 60 — the device reads this as a
    // colour index, so changing it changes the colour rather than the brightness.
    onValue: 60,
    offValue: 0,
    lampByInputID: buildLampMap(SMC_MIXER_RUNS, SMC_MIXER_BUTTON_CHANNEL),
  },
]

export function findMidiLedProfile(portName: string): MidiLedProfile | null {
  return (
    MIDI_LED_PROFILES.find((profile) => portName.includes(profile.portMatch)) ??
    null
  )
}

/** Wire bytes that set one bound control's lamp, or null if the device has no lamp for it. */
export function lampMessage(
  profile: MidiLedProfile,
  inputID: string,
  lit: boolean
): number[] | null {
  const note = profile.lampByInputID[inputID]
  if (note === undefined) {
    return null
  }
  // Note-on carrying zero for the dark state: pads of this kind never look at 0x80.
  return [
    0x90 | profile.lampChannel,
    note,
    lit ? profile.onValue : profile.offValue,
  ]
}
