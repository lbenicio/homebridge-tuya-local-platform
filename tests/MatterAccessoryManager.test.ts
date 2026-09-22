import { EventEmitter } from 'node:events'

import { describe, expect, it, vi } from 'vitest'

import MatterAccessoryManager from '../src/MatterAccessoryManager'

function createDevice(type: string, state: Record<string, unknown> = { '1': false }) {
  const device = new EventEmitter() as EventEmitter & {
    context: Record<string, unknown>
    state: Record<string, unknown>
    update: ReturnType<typeof vi.fn>
  }
  device.context = {
    id: 'tuya-device-id',
    UUID: 'uuid-tuya-device',
    name: 'Test Device',
    type,
    key: '1234567890123456',
    ip: '192.168.1.50',
  }
  device.state = state
  device.update = vi.fn(() => true)
  return device
}

function createMatterApi() {
  return {
    deviceTypes: {
      OnOffLight: { name: 'OnOffLight' },
      OnOffOutlet: { name: 'OnOffOutlet' },
      TemperatureSensor: { name: 'TemperatureSensor' },
      ContactSensor: { name: 'ContactSensor' },
      GenericSwitch: { name: 'GenericSwitch' },
    },
    clusterNames: {
      OnOff: 'onOff',
      TemperatureMeasurement: 'temperatureMeasurement',
      RelativeHumidityMeasurement: 'relativeHumidityMeasurement',
      BooleanState: 'booleanState',
    },
    registerPlatformAccessories: vi.fn().mockResolvedValue(undefined),
    unregisterPlatformAccessories: vi.fn().mockResolvedValue(undefined),
    updateAccessoryState: vi.fn().mockResolvedValue(undefined),
  }
}

describe('MatterAccessoryManager', () => {
  it('registers and updates a local outlet', async () => {
    const matter = createMatterApi()
    const manager = new MatterAccessoryManager({ matter }, { warn: vi.fn(), debug: vi.fn() })
    const device = createDevice('outlet')

    manager.add(device as any)
    await vi.waitFor(() => expect(matter.registerPlatformAccessories).toHaveBeenCalledOnce())

    device.state['1'] = true
    device.emit('change', { '1': true }, device.state)
    await vi.waitFor(() =>
      expect(matter.updateAccessoryState).toHaveBeenCalledWith('uuid-tuya-device', 'onOff', { onOff: true }),
    )
    expect(matter.registerPlatformAccessories).toHaveBeenCalledWith(
      '@lbenicio/homebridge-tuya-local-platform',
      'TuyaLocalPlatform',
      [expect.objectContaining({ deviceType: matter.deviceTypes.OnOffOutlet })],
    )
  })

  it('registers temperature and humidity state without a cloud dependency', async () => {
    const matter = createMatterApi()
    const manager = new MatterAccessoryManager({ matter }, { warn: vi.fn(), debug: vi.fn() })
    const device = createDevice('temperaturehumiditysensor', { '1': 260, '2': 68 })
    device.context.temperatureDivisor = 10

    manager.add(device as any)
    await vi.waitFor(() => expect(matter.registerPlatformAccessories).toHaveBeenCalledOnce())

    const registration = matter.registerPlatformAccessories.mock.calls[0][2][0]
    expect(registration.clusters.temperatureMeasurement.measuredValue).toBe(2600)
    expect(registration.clusters.relativeHumidityMeasurement.measuredValue).toBe(6800)
  })
})
