import type { DPSState, TuyaDeviceConfig } from './types'

const PLUGIN_NAME = '@lbenicio/homebridge-tuya-local-platform'
const PLATFORM_NAME = 'TuyaLocalPlatform'

type MatterApi = {
  deviceTypes: Record<string, any>
  clusterNames: Record<string, string>
  registerPlatformAccessories: (pluginIdentifier: string, platformName: string, accessories: any[]) => Promise<void>
  unregisterPlatformAccessories: (pluginIdentifier: string, platformName: string, accessories: any[]) => Promise<void>
  updateAccessoryState: (uuid: string, cluster: string, attributes: Record<string, unknown>) => Promise<void>
  switch?: {
    emit: (uuid: string, action: 'press' | 'release', options?: { position?: number }) => Promise<void>
  }
}

type MatterPlatformApi = {
  matter?: MatterApi
}

type MatterDevice = {
  context: TuyaDeviceConfig & { UUID: string }
  state: DPSState
  update: (state: DPSState) => boolean
  on: (event: 'change', listener: (changes: DPSState, state: DPSState) => void) => void
}

const POWER_TYPES = new Set([
  'outlet',
  'rgbtwoutlet',
  'multioutlet',
  'custommultioutlet',
  'simplelight',
  'rgbtwlight',
  'twlight',
  'simpledimmer',
  'simpledimmer2',
  'switch',
])

const OUTLET_TYPES = new Set(['outlet', 'rgbtwoutlet', 'multioutlet', 'custommultioutlet'])
const SENSOR_TYPES = new Set(['temperaturehumiditysensor', 'temperaturehumidity', 'thermometer'])
const CONTACT_TYPES = new Set(['contactsensor', 'doorsensor'])

const toBoolean = (value: unknown): boolean => {
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return value !== 0
  return ['true', '1', 'on', 'open', 'opened'].includes(String(value).toLowerCase().trim())
}

const numericValue = (value: unknown, fallback = 0): number => {
  const result = Number(value)
  return Number.isFinite(result) ? result : fallback
}

export default class MatterAccessoryManager {
  private readonly accessories = new Map<string, any>()
  private readonly registrations = new Set<string>()

  constructor(
    private readonly api: MatterPlatformApi,
    private readonly log: any,
  ) {}

  add(device: MatterDevice): void {
    const matter = this.api.matter
    if (!matter) return

    const definition = this.createDefinition(matter, device)
    if (!definition) return

    const deviceId = String(device.context.id)
    if (this.accessories.has(deviceId)) return

    this.accessories.set(deviceId, definition)
    device.on('change', (_changes: DPSState, state: DPSState) => {
      void this.updateState(matter, definition, device, state)
    })
    void this.register(matter, definition)
  }

  remove(deviceId: string): void {
    const accessory = this.accessories.get(deviceId)
    if (!accessory || !this.api.matter) return

    this.accessories.delete(deviceId)
    this.registrations.delete(deviceId)
    void this.api.matter
      .unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory])
      .catch((error: unknown) => {
        this.log.debug('Matter accessory %s was not registered: %s', deviceId, error)
      })
  }

  private createDefinition(matter: MatterApi, device: MatterDevice): any | undefined {
    const context = device.context
    const type = String(context.type || '').toLowerCase()
    const identity = {
      UUID: context.UUID,
      displayName: context.name || context.id,
      manufacturer: context.manufacturer || 'Tuya',
      model: context.model || context.type,
      serialNumber: String(context.id).slice(8),
      context: { deviceId: context.id },
    }

    if (POWER_TYPES.has(type))
      return this.createPowerAccessory(matter, identity, context, device, OUTLET_TYPES.has(type))
    if (SENSOR_TYPES.has(type)) return this.createSensorAccessory(matter, identity, context, device)
    if (CONTACT_TYPES.has(type)) return this.createContactAccessory(matter, identity, context, device)
    if (type === 'wirelessswitch') return this.createWirelessSwitchAccessory(matter, identity, context, device)
    return undefined
  }

  private createPowerAccessory(
    matter: MatterApi,
    identity: Record<string, unknown>,
    context: TuyaDeviceConfig,
    device: MatterDevice,
    outlet: boolean,
  ): any {
    const dp = this.getPowerDp(context)
    const read = () => toBoolean(device.state[dp])
    const write = (value: boolean): void => {
      if (!device.update({ [dp]: value })) throw new Error(`${context.name || context.id} is not connected`)
    }
    const matterAccessory = {
      ...identity,
      deviceType: outlet ? matter.deviceTypes.OnOffOutlet : matter.deviceTypes.OnOffLight,
      clusters: { onOff: { onOff: read() } },
      handlers: {
        onOff: {
          on: () => write(true),
          off: () => write(false),
          toggle: () => write(!read()),
        },
      },
      getState: (cluster: string, attribute: string) =>
        cluster === 'onOff' && attribute === 'onOff' ? read() : undefined,
    }
    return matterAccessory
  }

  private createSensorAccessory(
    matter: MatterApi,
    identity: Record<string, unknown>,
    context: TuyaDeviceConfig,
    device: MatterDevice,
  ): any {
    const temperatureDp = this.getDp(context.dpTemperature, '1')
    const humidityDp = this.getDp(context.dpHumidity, '2')
    const temperatureDivisor = numericValue(context.temperatureDivisor, 1) || 1
    const humidityDivisor = numericValue(context.humidityDivisor, 1) || 1
    const readTemperature = () => (numericValue(device.state[temperatureDp]) / temperatureDivisor) * 100
    const readHumidity = () => (numericValue(device.state[humidityDp]) / humidityDivisor) * 100

    return {
      ...identity,
      deviceType: matter.deviceTypes.TemperatureSensor,
      clusters: {
        temperatureMeasurement: { measuredValue: readTemperature() },
        relativeHumidityMeasurement: { measuredValue: readHumidity() },
      },
      getState: (cluster: string, attribute: string) => {
        if (cluster === 'temperatureMeasurement' && attribute === 'measuredValue') return readTemperature()
        if (cluster === 'relativeHumidityMeasurement' && attribute === 'measuredValue') return readHumidity()
        return undefined
      },
    }
  }

  private createContactAccessory(
    matter: MatterApi,
    identity: Record<string, unknown>,
    context: TuyaDeviceConfig,
    device: MatterDevice,
  ): any {
    const contactDp = this.getDp(context.dpContact, '1')
    const flipState = toBoolean(context.flipState)
    const read = () => (flipState ? !toBoolean(device.state[contactDp]) : toBoolean(device.state[contactDp]))

    return {
      ...identity,
      deviceType: matter.deviceTypes.ContactSensor,
      clusters: { booleanState: { stateValue: read() } },
      getState: (cluster: string, attribute: string) =>
        cluster === 'booleanState' && attribute === 'stateValue' ? read() : undefined,
    }
  }

  private createWirelessSwitchAccessory(
    matter: MatterApi,
    identity: Record<string, unknown>,
    context: TuyaDeviceConfig,
    device: MatterDevice,
  ): any {
    const switches =
      Array.isArray(context.switches) && context.switches.length > 0
        ? context.switches
        : Array.from({ length: Math.max(1, Number(context.switchCount) || 3) }, (_value, index) => ({ dp: index + 1 }))
    const position = (state: DPSState): number => {
      const active = switches.findIndex((item: { dp?: string | number }) =>
        Object.prototype.hasOwnProperty.call(state, String(item.dp)),
      )
      return active < 0 ? 0 : active + 1
    }
    const matterAccessory = {
      ...identity,
      deviceType: matter.deviceTypes.GenericSwitch,
      clusters: { switch: { currentPosition: position(device.state), numberOfPositions: switches.length } },
    }
    return matterAccessory
  }

  private async register(matter: MatterApi, accessory: any, attempts = 0): Promise<void> {
    const deviceId = accessory.context.deviceId
    if (this.registrations.has(deviceId)) return

    try {
      await matter.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory])
      this.registrations.add(deviceId)
    } catch (error) {
      if (attempts < 10) {
        setTimeout(() => void this.register(matter, accessory, attempts + 1), 1000)
        return
      }
      this.log.warn('Failed to register Matter accessory %s: %s', accessory.displayName, error)
    }
  }

  private async updateState(matter: MatterApi, accessory: any, device: MatterDevice, state: DPSState): Promise<void> {
    if (!this.registrations.has(accessory.context.deviceId)) return

    const type = String(device.context.type || '').toLowerCase()
    try {
      if (POWER_TYPES.has(type)) {
        const dp = this.getPowerDp(device.context)
        await matter.updateAccessoryState(accessory.UUID, matter.clusterNames.OnOff, { onOff: toBoolean(state[dp]) })
      } else if (SENSOR_TYPES.has(type)) {
        const temperatureDp = this.getDp(device.context.dpTemperature, '1')
        const humidityDp = this.getDp(device.context.dpHumidity, '2')
        const temperatureDivisor = numericValue(device.context.temperatureDivisor, 1) || 1
        const humidityDivisor = numericValue(device.context.humidityDivisor, 1) || 1
        if (Object.prototype.hasOwnProperty.call(state, temperatureDp)) {
          await matter.updateAccessoryState(accessory.UUID, matter.clusterNames.TemperatureMeasurement, {
            measuredValue: (numericValue(state[temperatureDp]) / temperatureDivisor) * 100,
          })
        }
        if (Object.prototype.hasOwnProperty.call(state, humidityDp)) {
          await matter.updateAccessoryState(accessory.UUID, matter.clusterNames.RelativeHumidityMeasurement, {
            measuredValue: (numericValue(state[humidityDp]) / humidityDivisor) * 100,
          })
        }
      } else if (CONTACT_TYPES.has(type)) {
        const contactDp = this.getDp(device.context.dpContact, '1')
        if (Object.prototype.hasOwnProperty.call(state, contactDp)) {
          const flipState = toBoolean(device.context.flipState)
          await matter.updateAccessoryState(accessory.UUID, matter.clusterNames.BooleanState, {
            stateValue: flipState ? !toBoolean(state[contactDp]) : toBoolean(state[contactDp]),
          })
        }
      } else if (type === 'wirelessswitch' && matter.switch) {
        const switches =
          Array.isArray(device.context.switches) && device.context.switches.length > 0
            ? device.context.switches
            : Array.from({ length: Math.max(1, Number(device.context.switchCount) || 3) }, (_value, index) => ({
                dp: index + 1,
              }))
        const active = switches.findIndex((item: { dp?: string | number }) =>
          Object.prototype.hasOwnProperty.call(state, String(item.dp)),
        )
        if (active >= 0) {
          await matter.switch.emit(accessory.UUID, 'press', { position: active + 1 })
          await matter.switch.emit(accessory.UUID, 'release', { position: active + 1 })
        }
      }
    } catch (error) {
      this.log.debug('Failed to update Matter accessory %s: %s', accessory.displayName, error)
    }
  }

  private getPowerDp(context: TuyaDeviceConfig): string {
    return this.getDp(context.dpPower || context.dp, '1')
  }

  private getDp(value: unknown, fallback: string): string {
    return Number(value) > 0 ? String(value) : fallback
  }
}
