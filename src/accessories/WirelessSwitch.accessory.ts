import BaseAccessory from './Base.accessory'
import type { DPSState, DPSValue, HomebridgeCallback } from '../types'

interface WirelessSwitchConfig {
  name?: string
  dp?: number | string
}

class WirelessSwitchAccessory extends BaseAccessory {
  static getCategory(Categories: any): number {
    return Categories.SWITCH
  }

  _registerPlatformAccessory(): void {
    this.accessory.category = (this.constructor as any).getCategory(this.hap.Categories)
    this._ensureServices()
    super._registerPlatformAccessory()
  }

  _registerCharacteristics(dps: DPSState): void {
    this._ensureServices()
    const { Service, Characteristic } = this.hap
    if (!Service.StatelessProgrammableSwitch || !Characteristic.ProgrammableSwitchEvent) return

    this._getSwitchServices().forEach(({ service, dp }) => {
      const characteristic = service.getCharacteristic(Characteristic.ProgrammableSwitchEvent)
      if (Object.prototype.hasOwnProperty.call(dps, dp)) this._updateEvent(characteristic, dps[dp])
      if ((service as any).__tuyaWirelessBound) return
      ;(service as any).__tuyaWirelessBound = true
      characteristic.on('get', (callback: HomebridgeCallback) => callback(null, 0))
    })

    this.device.on('change', (changes: DPSState, state: DPSState) => {
      this._getSwitchServices().forEach(({ service, dp }) => {
        if (!Object.prototype.hasOwnProperty.call(changes, dp)) return
        this.log.info(`${this.device.context.name} received wireless event on DP ${dp}: ${JSON.stringify(state[dp])}`)
        this._updateEvent(service.getCharacteristic(Characteristic.ProgrammableSwitchEvent), state[dp])
      })
    })
  }

  private _ensureServices(): void {
    const { Service } = this.hap
    if (!Service.StatelessProgrammableSwitch) {
      this.log.warn(`${this.device.context.name} requires StatelessProgrammableSwitch support from HAP`)
      return
    }

    this._getSwitches().forEach((item, index) => {
      const subtype = `wireless-${index + 1}`
      let service = this._getServiceByUUIDAndSubType(Service.StatelessProgrammableSwitch, subtype)
      if (!service) service = this.accessory.addService(Service.StatelessProgrammableSwitch, item.name, subtype)
      this._checkServiceName(service, `${this.device.context.name} ${item.name}`)
    })
  }

  private _getSwitchServices(): { service: any; dp: string }[] {
    const Service = this.hap.Service
    return this._getSwitches().map((item, index) => ({
      service: this._getServiceByUUIDAndSubType(Service.StatelessProgrammableSwitch, `wireless-${index + 1}`),
      dp: String(item.dp),
    }))
  }

  private _getSwitches(): WirelessSwitchConfig[] {
    const configured = this.device.context.switches as WirelessSwitchConfig[] | undefined
    if (Array.isArray(configured) && configured.length > 0) return configured

    const count = Math.max(1, Number(this.device.context.switchCount) || 3)
    return Array.from({ length: count }, (_value, index) => ({ name: `Button ${index + 1}`, dp: index + 1 }))
  }

  private _updateEvent(characteristic: any, value: DPSValue): void {
    const normalized = String(value || '').toLowerCase()
    const event = normalized.includes('double')
      ? 1
      : normalized.includes('long') || normalized.includes('press')
        ? 2
        : 0
    characteristic.updateValue(event)
  }
}

export default WirelessSwitchAccessory
