import { EventEmitter } from 'events'
import { describe, expect, it, vi } from 'vitest'
import LinkedSwitchManager from '../src/LinkedSwitchManager'
import type { DPSState } from '../src/types'

function createDevice(id: string, name: string) {
  const device = new EventEmitter() as any
  device.context = { id, name }
  device.connected = true
  device.state = {}
  device.update = vi.fn().mockReturnValue(true)
  return device
}

function emitState(device: any, changes: DPSState): void {
  device.state = { ...device.state, ...changes }
  device.emit('change', changes, device.state)
}

function createLogger() {
  return { info: vi.fn(), debug: vi.fn() } as any
}

describe('LinkedSwitchManager', () => {
  it('propagates physical changes to every member after initial state', () => {
    const master = createDevice('master', 'Master')
    const secondary = createDevice('secondary', 'Secondary')
    const third = createDevice('third', 'Third')
    const manager = new LinkedSwitchManager(createLogger())

    manager.bind(
      [
        {
          name: 'Hallway',
          members: [
            { deviceId: 'master', dp: 1 },
            { deviceId: 'secondary', dp: 1 },
            { deviceId: 'third', dp: 1 },
          ],
        },
      ],
      new Map([
        ['master', master],
        ['secondary', secondary],
        ['third', third],
      ]),
    )

    emitState(master, { '1': false })
    emitState(secondary, { '1': false })
    emitState(third, { '1': false })
    emitState(master, { '1': true })

    expect(secondary.update).toHaveBeenCalledWith({ '1': true })
    expect(third.update).toHaveBeenCalledWith({ '1': true })
  })

  it('does not propagate the initial state query', () => {
    const first = createDevice('first', 'First')
    const second = createDevice('second', 'Second')
    const manager = new LinkedSwitchManager(createLogger())

    manager.bind(
      [
        {
          members: [
            { deviceId: 'first', dp: 1 },
            { deviceId: 'second', dp: 1 },
          ],
        },
      ],
      new Map([
        ['first', first],
        ['second', second],
      ]),
    )

    emitState(first, { '1': true })

    expect(second.update).not.toHaveBeenCalled()
  })

  it('does not echo a propagated update back to its source', () => {
    const first = createDevice('first', 'First')
    const second = createDevice('second', 'Second')
    const manager = new LinkedSwitchManager(createLogger())

    manager.bind(
      [
        {
          members: [
            { deviceId: 'first', dp: 1 },
            { deviceId: 'second', dp: 1 },
          ],
        },
      ],
      new Map([
        ['first', first],
        ['second', second],
      ]),
    )

    emitState(first, { '1': false })
    emitState(second, { '1': false })
    emitState(first, { '1': true })
    emitState(second, { '1': true })

    expect(first.update).not.toHaveBeenCalled()
    expect(second.update).toHaveBeenCalledTimes(1)
  })
})
