import { Output } from 'midi'
import { ConnectionId } from '../../shared/connection'

/**
 * MIDI *output* ports, for lighting controller lamps.
 *
 * Mirrors {@link ./midiConnection}'s input handling: ports are opened lazily for devices
 * the user has enabled and dropped when they are disabled or unplugged. Output port names
 * match their input counterparts for the same hardware, so the connectable list is shared
 * and a device enabled for input is reachable for feedback too.
 *
 * Sends are addressed per port rather than broadcast, because the address a lamp answers
 * on is device-specific — see {@link ../../shared/midiLedProfile}.
 */

const refOutput = new Output()
const outputs: { [portName: string]: Output } = {}

/**
 * Open/close output ports so they match `connectable`. Cheap to call repeatedly.
 *
 * Returns true when the open set changed, which callers use to resend lamp state: a
 * device that has just appeared knows nothing about what it should be showing.
 */
export function updateOutputs(connectable: ConnectionId[]): boolean {
  let changed = false
  const available = new Set<string>()
  const portCount = refOutput.getPortCount()

  for (let i = 0; i < portCount; i++) {
    const portName = refOutput.getPortName(i)
    available.add(portName)
    if (outputs[portName] === undefined && connectable.includes(portName)) {
      const output = new Output()
      try {
        output.openPort(i)
        outputs[portName] = output
        changed = true
      } catch {
        // A port can vanish between enumeration and open — retried on the next pass.
      }
    }
  }

  for (const portName of Object.keys(outputs)) {
    if (available.has(portName) && connectable.includes(portName)) {
      continue
    }
    // Gone or disabled: drop it. Lamps are left as they are, since the port that would
    // clear them is exactly the one no longer available.
    try {
      outputs[portName]?.closePort()
    } catch {
      /* ignore */
    }
    delete outputs[portName]
    changed = true
  }

  return changed
}

export function openOutputPortNames(): string[] {
  return Object.keys(outputs)
}

export function sendToOutput(portName: string, message: number[]): void {
  try {
    outputs[portName]?.sendMessage(message)
  } catch {
    // A device unplugged mid-send; the next updateOutputs pass reaps the port.
  }
}

export function shutdownMidiOutputs(): void {
  for (const portName of Object.keys(outputs)) {
    try {
      outputs[portName]?.closePort()
    } catch {
      /* ignore */
    }
    delete outputs[portName]
  }
}
