import BaseAccessory from './Base.accessory'
import type { DPSValue, HomebridgeCallback } from '../types'

interface InfraredKeyConfig {
  name?: string
  code?: string
  hex?: string
  base64?: string
  learning_code?: string
  encoding?: 'hex' | 'base64'
  type?: number
}

interface InfraredRemoteConfig {
  name?: string
  keys?: InfraredKeyConfig[]
  remote_keys?: InfraredKeyConfig[]
}

interface InfraredCommand {
  name: string
  subtype: string
  code: string
  type: number
}

export const cloudHexToBase64 = (value: string): string => {
  const normalized = value.replace(/\s+/g, '').replace(/^0x/i, '')
  if (!/^[0-9a-f]+$/i.test(normalized) || normalized.length % 4 !== 0) throw new Error('Invalid Tuya cloud IR hex code')

  const pulses = Buffer.alloc(normalized.length / 2)
  for (let index = 0; index < normalized.length; index += 4) {
    const word = Buffer.from(normalized.slice(index, index + 4), 'hex')
    word.reverse().copy(pulses, index / 2)
  }
  return pulses.toString('base64')
}

const getCode = (key: InfraredKeyConfig): string | false => {
  const value = key.base64 || key.code || key.hex || key.learning_code
  if (!value) return false
  if (key.base64 || key.encoding === 'base64') return value
  return cloudHexToBase64(value)
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
    const validSubtypes = new Set(commands.map((command) => command.subtype))
    this.accessory.services
      .filter(
        (service: any) =>
          service.UUID === Service.Switch.UUID &&
          typeof service.subtype === 'string' &&
          service.subtype.startsWith('ir-'),
      )
      .filter((service: any) => !validSubtypes.has(service.subtype))
      .forEach((service: any) => this.accessory.removeService(service))

    commands.forEach((command) => {
      let service = this._getServiceByUUIDAndSubType(Service.Switch, command.subtype)
      if (!service) service = this.accessory.addService(Service.Switch, command.name, command.subtype)
      this._checkServiceName(service, command.name)

      const characteristic = service.getCharacteristic(Characteristic.On)
      if ((service as any).__tuyaIrBound) return
      ;(service as any).__tuyaIrBound = true
      characteristic
        .updateValue(false)
        .on('get', (callback: HomebridgeCallback) => callback(null, false))
        .on('set', (value: DPSValue, callback: HomebridgeCallback) => {
          if (!this._coerceBoolean(value)) return callback()
          const sent = this._send(command)
          setTimeout(() => characteristic.updateValue(false), 100)
          callback(sent ? null : new Error('IR hub is not connected'))
        })
    })
  }

  private _send(command: InfraredCommand): boolean {
    const payload = {
      control: 'send_ir',
      type: command.type,
      head: '',
      key1: '1' + command.code,
    }
    const dp = this._getCustomDP(this.device.context.dpSend) || '201'
    return this.device.update({ [dp]: JSON.stringify(payload) })
  }

  private _getCommands(): InfraredCommand[] {
    const remotes = (this.device.context.remotes || this.device.context.irRemotes || []) as InfraredRemoteConfig[]
    const commands: InfraredCommand[] = []

    remotes.forEach((remote, remoteIndex) => {
      const remoteName = (remote.name || `Remote ${remoteIndex + 1}`).trim()
      const keys = remote.keys || remote.remote_keys || []
      keys.forEach((key, keyIndex) => {
        try {
          const code = getCode(key)
          if (!code) return
          const keyName = (key.name || `Button ${keyIndex + 1}`).trim()
          commands.push({
            name: `${this.device.context.name} ${remoteName} ${keyName}`,
            subtype: `ir-${remoteIndex}-${keyIndex}`,
            code,
            type: Number.isFinite(Number(key.type)) ? Number(key.type) : 0,
          })
        } catch (error) {
          this.log.warn(`Skipping invalid IR code for ${this.device.context.name}: ${error}`)
        }
      })
    })

    return commands
  }
}

export default InfraredHubAccessory
