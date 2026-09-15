import { describe, expect, it, vi } from 'vitest'
import ContactSensorAccessory from '../src/accessories/ContactSensor.accessory'
import TemperatureHumiditySensorAccessory from '../src/accessories/TemperatureHumiditySensor.accessory'
import {
  createMockCategories,
  createMockCharacteristic,
  createMockLogger,
  createMockPlatformAccessory,
  createMockService,
  createMockTuyaDevice,
} from './helpers'

function createPlatform() {
  const Characteristic: any = {
    ...createMockCharacteristic(),
    ContactSensorState: { CONTACT_DETECTED: 0, CONTACT_NOT_DETECTED: 1 },
  }
  const log = createMockLogger()
  const platform = {
    log,
    api: { hap: { Characteristic, Service: createMockService(), Categories: createMockCategories() } },
    registerPlatformAccessories: vi.fn(),
  }
  return { platform, Characteristic, log }
}

describe('TemperatureHumiditySensorAccessory', () => {
  it('parses temperature and humidity with configured divisors', () => {
    const { platform } = createPlatform()
    const device = createMockTuyaDevice({ type: 'temperaturehumiditysensor' } as any)
    const accessory = createMockPlatformAccessory({ name: 'Climate Sensor' })
    const sensor = new TemperatureHumiditySensorAccessory(platform, accessory, device, false)

    sensor.dpTemperature = '11'
    sensor.dpHumidity = '10'
    sensor.temperatureDivisor = 10
    sensor.humidityDivisor = 10

    expect(sensor._getTemperature(265)).toBe(26.5)
    expect(sensor._getHumidity(685)).toBe(68.5)
  })

  it('maps string battery states to HomeKit percentages', () => {
    const { platform } = createPlatform()
    const device = createMockTuyaDevice({ type: 'temperaturehumiditysensor' } as any)
    const accessory = createMockPlatformAccessory({ name: 'Climate Sensor' })
    const sensor = new TemperatureHumiditySensorAccessory(platform, accessory, device, false)

    expect(sensor._getBatteryLevel('high')).toBe(100)
    expect(sensor._getBatteryLevel('middle')).toBe(50)
    expect(sensor._getBatteryLevel('low')).toBe(10)
  })
})

describe('ContactSensorAccessory', () => {
  it('maps an open Tuya contact to HomeKit not detected', () => {
    const { platform, Characteristic } = createPlatform()
    const device = createMockTuyaDevice({ type: 'contactsensor' } as any)
    const accessory = createMockPlatformAccessory({ name: 'Door Sensor' })
    const sensor = new ContactSensorAccessory(platform, accessory, device, false)

    sensor.flipState = false

    expect(sensor._getContactState(false)).toBe(Characteristic.ContactSensorState.CONTACT_DETECTED)
    expect(sensor._getContactState(true)).toBe(Characteristic.ContactSensorState.CONTACT_NOT_DETECTED)
  })

  it('supports inverted contact state and numeric battery levels', () => {
    const { platform } = createPlatform()
    const device = createMockTuyaDevice({ type: 'contactsensor' } as any)
    const accessory = createMockPlatformAccessory({ name: 'Door Sensor' })
    const sensor = new ContactSensorAccessory(platform, accessory, device, false)

    sensor.flipState = true

    expect(sensor._getContactState(false)).toBe(1)
    expect(sensor._getBatteryLevel(85)).toBe(85)
  })
})
