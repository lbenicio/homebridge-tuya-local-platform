import BaseAccessory from './Base.accessory'
import type { DPSValue, HomebridgeCallback } from '../types'

interface InfraredKeyConfig {
  name?: string
  code?: string
  hex?: string
  base64?: string
  learning_code?: string
  rfPayload?: InfraredPayload | string
  payload?: InfraredPayload | string
  encoding?: 'hex' | 'base64'
  type?: number | string
  serviceType?: string
  accessoryType?: string
  service?: string
  hidden?: boolean
  visible?: boolean
  enabled?: boolean
}

interface InfraredRemoteConfig {
  name?: string
  keys?: InfraredKeyConfig[]
  remote_keys?: InfraredKeyConfig[]
  hidden?: boolean
  visible?: boolean
  enabled?: boolean
}

type InfraredServiceType = 'switch' | 'outlet' | 'lightbulb' | 'fan' | 'valve'

interface InfraredCommand {
  name: string
  subtype: string
  code?: string
  payload?: InfraredPayload
  type: number
  serviceType: InfraredServiceType
  hidden: boolean
}

type InfraredPayload = Record<string, unknown>

export const cloudHexToBase64 = (value: string): string => {
  const normalized = value.replace(/\s+/g, '').replace(/^0x/i, '')
  if (!/^[0-9a-f]+$/i.test(normalized) || normalized.length % 2 !== 0) throw new Error('Invalid Tuya cloud IR hex code')

  const pulses = Buffer.from(normalized, 'hex')
  let end = pulses.length
  let paddingLength = 0
  for (let index = pulses.length - 1; index >= 0 && pulses[index] === 0xff; index--) {
    paddingLength++
    if (paddingLength >= 8) {
      end = index
      break
    }
  }

  return pulses.subarray(0, end).toString('base64')
}

const getCode = (key: InfraredKeyConfig): string | false => {
  const value = key.base64 || key.code || key.hex || key.learning_code
  if (!value) return false
  if (key.base64 || key.encoding === 'base64') return value
  return cloudHexToBase64(value)
}

const getPayload = (key: InfraredKeyConfig): InfraredPayload | false => {
  const value = key.rfPayload || key.payload
  if (!value) return false

  if (typeof value === 'string') {
    const parsed: unknown = JSON.parse(value)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('Invalid RF payload')
    }
    return parsed as InfraredPayload
  }

  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid RF payload')
  return value as InfraredPayload
}

const normalizeRfPayload = (payload: InfraredPayload): InfraredPayload => {
  if (payload.control !== 'rfstudy_send') return payload

  const normalized: InfraredPayload = { ...payload, ver: payload.ver || '2' }
  if (payload.key1 && typeof payload.key1 === 'object' && !Array.isArray(payload.key1)) {
    const key = payload.key1 as InfraredPayload
    normalized.key1 = { ...key, ver: key.ver || normalized.ver }
  }
  return normalized
}

const isDisabled = (value: unknown): boolean => value === true || value === 'true'

const normalizeServiceType = (value: unknown): InfraredServiceType => {
  const normalized = String(value || 'switch')
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, '')

  switch (normalized) {
    case 'outlet':
      return 'outlet'
    case 'light':
    case 'lightbulb':
      return 'lightbulb'
    case 'fan':
      return 'fan'
    case 'valve':
    case 'faucet':
    case 'watervalve':
      return 'valve'
    default:
      return 'switch'
  }
}

class InfraredHubAccessory extends BaseAccessory {
  static getCategory(Categories: any): number {
    return Categories.SWITCH
  }

  constructor(...props: any[]) {
    super(...props)
    this._ensureServices()
  }

  _registerPlatformAccessory(): void {
    this.accessory.category = (this.constructor as any).getCategory(this.hap.Categories)
    this._ensureServices()
    super._registerPlatformAccessory()
  }

  _registerCharacteristics(): void {
    this._ensureServices()
  }

  private _ensureServices(): void {
    const { Service, Characteristic } = this.hap
    if (!Service.Switch || !Characteristic.On) return

    const commands = this._getCommands()
    const visibleCommands = commands.filter((command) => !command.hidden)
    const commandsBySubtype = new Map(visibleCommands.map((command) => [command.subtype, command]))
    const serviceTypes = ['switch', 'outlet', 'lightbulb', 'fan', 'valve'] as InfraredServiceType[]
    const managedServiceUUIDs = new Set(
      serviceTypes.map((serviceType) => this._getServiceClass(serviceType)?.UUID).filter(Boolean),
    )

    this.accessory.services
      .filter(
        (service: any) =>
          managedServiceUUIDs.has(service.UUID) &&
          typeof service.subtype === 'string' &&
          service.subtype.startsWith('ir-'),
      )
      .filter((service: any) => {
        const command = commandsBySubtype.get(service.subtype)
        return !command || this._getServiceClass(command.serviceType)?.UUID !== service.UUID
      })
      .forEach((service: any) => this.accessory.removeService(service))

    visibleCommands.forEach((command) => {
      const serviceClass = this._getServiceClass(command.serviceType)
      if (!serviceClass) return

      let service = this._getServiceByUUIDAndSubType(serviceClass, command.subtype)
      if (!service) service = this.accessory.addService(serviceClass, command.name, command.subtype)
      this._checkServiceName(service, command.name)
      this._setConfiguredName(service, command.name)

      const characteristic = service.getCharacteristic(this._getControlCharacteristic(command.serviceType))
      if ((service as any).__tuyaIrBound) return
      ;(service as any).__tuyaIrBound = true
      characteristic
        .updateValue(false)
        .on('get', (callback: HomebridgeCallback) => callback(null, false))
        .on('set', (value: DPSValue, callback: HomebridgeCallback) => {
          if (!this._coerceBoolean(value)) {
            characteristic.updateValue(false)
            return callback()
          }

          const sent = this._send(command)
          callback(sent ? null : new Error('IR hub is not connected'))
          if (sent) {
            setTimeout(() => {
              const resetValue = command.serviceType === 'valve' ? 0 : false
              if (typeof characteristic.sendEventNotification === 'function') {
                characteristic.sendEventNotification(resetValue)
              } else {
                characteristic.updateValue(resetValue)
              }
            }, 500)
          }
        })
    })
  }

  private _getServiceClass(serviceType: InfraredServiceType): any {
    const { Service } = this.hap
    return {
      switch: Service.Switch,
      outlet: Service.Outlet,
      lightbulb: Service.Lightbulb,
      fan: Service.Fan,
      valve: Service.Valve,
    }[serviceType]
  }

  private _getControlCharacteristic(serviceType: InfraredServiceType): any {
    return serviceType === 'valve' ? this.hap.Characteristic.Active : this.hap.Characteristic.On
  }

  private _setConfiguredName(service: any, name: string): void {
    const configuredName = this.hap.Characteristic.ConfiguredName
    if (configuredName) service.getCharacteristic(configuredName).setValue(name)
  }

  private _send(command: InfraredCommand): boolean {
    const payload = command.payload
      ? normalizeRfPayload(command.payload)
      : {
          control: 'send_ir',
          type: command.type,
          head: '',
          key1: '1' + command.code,
        }
    const dp = this._getCustomDP(this.device.context.dpSend) || '201'
    const sent = this.device.update({ [dp]: JSON.stringify(payload) })
    this.log.info(`Sending ${command.name} via DP ${dp} (${command.payload ? 'RF' : 'IR'}), result=${sent}`)
    return sent
  }

  private _getCommands(): InfraredCommand[] {
    const remotes = (this.device.context.remotes || this.device.context.irRemotes || []) as InfraredRemoteConfig[]
    const commands: InfraredCommand[] = []

    remotes.forEach((remote, remoteIndex) => {
      const remoteName = (remote.name || `Remote ${remoteIndex + 1}`).trim()
      const keys = remote.keys || remote.remote_keys || []
      keys.forEach((key, keyIndex) => {
        try {
          const payload = getPayload(key)
          const keyName = (key.name || `Button ${keyIndex + 1}`).trim()
          const subtype = `ir-${remoteIndex}-${keyIndex}`
          const configuredServiceType =
            key.serviceType || key.accessoryType || key.service || (typeof key.type === 'string' ? key.type : undefined)
          const command = {
            name: `${this.device.context.name} ${remoteName} ${keyName}`,
            subtype,
            type: Number.isFinite(Number(key.type)) ? Number(key.type) : 0,
            serviceType: normalizeServiceType(
              this._getHomeKitServiceOverride(subtype) ||
                (this.device.context.homeKitType !== 'default' ? this.device.context.homeKitType : undefined) ||
                configuredServiceType,
            ),
            hidden:
              isDisabled(remote.hidden) ||
              remote.visible === false ||
              remote.enabled === false ||
              isDisabled(key.hidden) ||
              key.visible === false ||
              key.enabled === false,
          }
          if (payload) {
            commands.push({ ...command, payload })
            return
          }

          const code = getCode(key)
          if (code) commands.push({ ...command, code })
        } catch (error) {
          this.log.warn(`Skipping invalid IR code for ${this.device.context.name}: ${error}`)
        }
      })
    })

    return commands
  }
}

export default InfraredHubAccessory
