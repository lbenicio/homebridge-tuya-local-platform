import { describe, expect, it, vi } from 'vitest'
import GatewayAccessory from '../src/accessories/Gateway.accessory'
import InfraredHubAccessory, { cloudHexToBase64 } from '../src/accessories/InfraredHub.accessory'
import WirelessSwitchAccessory from '../src/accessories/WirelessSwitch.accessory'
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
  return {
    log: createMockLogger(),
    api: { hap: { Characteristic, Service: createMockService(), Categories: createMockCategories() } },
    registerPlatformAccessories: vi.fn(),
  }
}

describe('InfraredHubAccessory', () => {
  it('converts cloud pulse bytes to local base64 without reordering', () => {
    expect(cloudHexToBase64('2a247811')).toBe('KiR4EQ==')
  })

  it('creates momentary switches and sends DP 201 JSON', () => {
    vi.useFakeTimers()
    const device = createMockTuyaDevice({
      name: 'IR Hub',
      type: 'infraredhub',
      remotes: [{ name: 'Remote', keys: [{ name: 'Power', hex: '2a247811' }] }],
    } as any)
    device.connected = true
    const accessory = createMockPlatformAccessory({ name: 'IR Hub' })
    const platform = createPlatform()
    new InfraredHubAccessory(platform, accessory, device, false)

    const service = accessory.services.find((item: any) => item.subtype === 'ir-0-0')
    const characteristic = service.getCharacteristic(platform.api.hap.Characteristic.On)
    characteristic.emit('set', true, vi.fn())

    expect(device.update).toHaveBeenCalledWith({
      '201': JSON.stringify({ control: 'send_ir', type: 0, head: '', key1: '1KiR4EQ==' }),
    })

    characteristic.emit('set', false, vi.fn())
    expect(device.update).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(500)
    expect(characteristic.value).toBe(false)
    vi.useRealTimers()
  })

  it('sends native Tuya RF payloads without wrapping them as IR', () => {
    const rfPayload = {
      control: 'rfstudy_send',
      rf_type: 'sub_2g',
      mode: 0,
      key1: { times: 6, intervals: 0, delay: 0, code: 'rf-code' },
      feq: 0,
      rate: 0,
    }
    const device = createMockTuyaDevice({
      name: 'IR Hub',
      type: 'infraredhub',
      remotes: [{ name: 'RF', keys: [{ name: 'Power', rfPayload }] }],
    } as any)
    device.connected = true
    const accessory = createMockPlatformAccessory({ name: 'IR Hub' })
    const platform = createPlatform()
    new InfraredHubAccessory(platform, accessory, device, false)

    const service = accessory.services.find((item: any) => item.subtype === 'ir-0-0')
    const characteristic = service.getCharacteristic(platform.api.hap.Characteristic.On)
    characteristic.emit('set', true, vi.fn())

    expect(device.update).toHaveBeenCalledWith({
      '201': JSON.stringify({
        ...rfPayload,
        ver: '2',
        key1: { ...rfPayload.key1, ver: '2' },
      }),
    })
  })

  it('keeps configured names, hides commands, and maps HomeKit service types', () => {
    const device = createMockTuyaDevice({
      name: 'IR Hub',
      type: 'infraredhub',
      remotes: [
        {
          name: 'Desk lamp',
          keys: [
            { name: 'Power', hex: '2a247811', serviceType: 'outlet' },
            { name: 'Unused', hex: '2a247811', hidden: true },
          ],
        },
        {
          name: 'Irrigation',
          keys: [{ name: 'Start', hex: '2a247811', serviceType: 'valve' }],
        },
      ],
    } as any)
    const accessory = createMockPlatformAccessory({ name: 'IR Hub' })
    const platform = createPlatform()
    new InfraredHubAccessory(platform, accessory, device, false)

    const outlet = accessory.services.find((item: any) => item.subtype === 'ir-0-0')
    const valve = accessory.services.find((item: any) => item.subtype === 'ir-1-0')
    expect(outlet.displayName).toBe('IR Hub Desk lamp Power')
    expect(outlet.UUID).toBe(platform.api.hap.Service.Outlet.UUID)
    expect(valve.UUID).toBe(platform.api.hap.Service.Valve.UUID)
    expect(accessory.services.some((item: any) => item.subtype === 'ir-0-1')).toBe(false)
  })
})

describe('WirelessSwitchAccessory', () => {
  it('does not treat the initial cached state as a button press', () => {
    const device = createMockTuyaDevice({
      name: 'Remote',
      type: 'wirelessswitch',
      switches: [{ name: 'Button', dp: 1 }],
    } as any)
    const accessory = createMockPlatformAccessory({ name: 'Remote' })
    const platform = createPlatform()
    const remote = new WirelessSwitchAccessory(platform, accessory, device, false)
    remote._registerCharacteristics({ '1': 'single_click' })

    const service = accessory.services.find((item: any) => item.subtype === 'wireless-1')
    const characteristic = service.getCharacteristic(platform.api.hap.Characteristic.ProgrammableSwitchEvent)
    expect(characteristic.value).toBeUndefined()

    device.state = { '1': 'double_click' }
    device.emit('change', { '1': 'double_click' }, device.state)
    expect(characteristic.value).toBe(1)
  })
})

describe('GatewayAccessory', () => {
  it('maps alarm state and alarm sound DPs', () => {
    const device = createMockTuyaDevice({
      name: 'Gateway',
      type: 'gateway',
      dpAlarmSound: 1,
      dpAlarmActive: 2,
    } as any)
    const accessory = createMockPlatformAccessory({ name: 'Gateway' })
    const platform = createPlatform()
    const gateway = new GatewayAccessory(platform, accessory, device, false)
    gateway._registerCharacteristics({ '1': true, '2': true })

    const switchService = accessory.getService(platform.api.hap.Service.Switch)
    const sensorService = accessory.getService(platform.api.hap.Service.ContactSensor)
    expect(switchService.getCharacteristic(platform.api.hap.Characteristic.On).value).toBe(true)
    expect(sensorService.getCharacteristic(platform.api.hap.Characteristic.ContactSensorState).value).toBe(0)
  })

  it('treats the gateway normal state as not alarmed', () => {
    const device = createMockTuyaDevice({
      name: 'Gateway',
      type: 'gateway',
      dpAlarmActive: 2,
    } as any)
    const accessory = createMockPlatformAccessory({ name: 'Gateway' })
    const platform = createPlatform()
    const gateway = new GatewayAccessory(platform, accessory, device, false)

    expect(gateway._getAlarmState('normal')).toBe(1)
    expect(gateway._getAlarmState('alarm')).toBe(0)
  })

  it('removes cached alarm services when alarm DPs are not configured', () => {
    const device = createMockTuyaDevice({
      name: 'Gateway',
      type: 'gateway',
      dpAlarmSound: 1,
      dpAlarmActive: 2,
    } as any)
    const accessory = createMockPlatformAccessory({ name: 'Gateway' })
    const platform = createPlatform()
    const gateway = new GatewayAccessory(platform, accessory, device, false)

    delete device.context.dpAlarmSound
    delete device.context.dpAlarmActive
    gateway._ensureServices()

    expect(accessory.services.some((service: any) => service.displayName === 'Gateway Alarm')).toBe(false)
    expect(accessory.services.some((service: any) => service.displayName === 'Gateway Alarm Active')).toBe(false)
  })
})
