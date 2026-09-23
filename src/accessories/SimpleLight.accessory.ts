import BaseAccessory from './Base.accessory'
import type { DPSState } from '../types'

class SimpleLightAccessory extends BaseAccessory {
  static getCategory(Categories: any): number {
    return Categories.LIGHTBULB
  }

  dpPower!: string

  constructor(...props: any[]) {
    super(...props)
  }

  _registerPlatformAccessory(): void {
    const serviceType = this._getHomeKitServiceType('primary', 'lightbulb')
    this._getPrimaryHomeKitPowerService(serviceType, this.device.context.name)

    super._registerPlatformAccessory()
  }

  _registerCharacteristics(dps: DPSState): void {
    const { Characteristic } = this.hap
    const serviceType = this._getHomeKitServiceType('primary', 'lightbulb')
    const service = this._getPrimaryHomeKitPowerService(serviceType, this.device.context.name)
    this._checkServiceName(service, this.device.context.name)

    this.dpPower = this._getCustomDP(this.device.context.dpPower) || '1'

    const characteristicOn = service
      .getCharacteristic(Characteristic.On)
      .updateValue(dps[this.dpPower])
      .on('get', this.getState.bind(this, this.dpPower))
      .on('set', this.setState.bind(this, this.dpPower))

    this.device.on('change', (changes: DPSState, state: DPSState) => {
      if (changes.hasOwnProperty(this.dpPower) && characteristicOn.value !== changes[this.dpPower])
        characteristicOn.updateValue(changes[this.dpPower])
      this.log.info('SimpleLight changed: ' + JSON.stringify(state))
    })
  }
}

export default SimpleLightAccessory
