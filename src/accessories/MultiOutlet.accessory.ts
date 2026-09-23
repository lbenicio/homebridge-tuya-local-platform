import BaseAccessory from './Base.accessory'
import async from 'async'
import type { DPSState, DPSValue, HomebridgeCallback } from '../types'

interface PendingPower {
  props: DPSState
  callbacks: HomebridgeCallback[]
  timer?: ReturnType<typeof setTimeout>
}

class MultiOutletAccessory extends BaseAccessory {
  static getCategory(Categories: any): number {
    return Categories.OUTLET
  }

  private _justRegistered?: boolean
  private _pendingPower: PendingPower | null = null

  constructor(...props: any[]) {
    super(...props)
  }

  _registerPlatformAccessory(): void {
    this._verifyCachedPlatformAccessory()
    this._justRegistered = true

    super._registerPlatformAccessory()
  }

  _verifyCachedPlatformAccessory(): void {
    if (this._justRegistered) return

    const outletCount = parseInt(this.device.context.outletCount) || 1
    const _validServices: any[] = []
    for (let i = 0; i++ < outletCount; ) {
      const subtype = 'outlet ' + i
      const serviceType = this._getHomeKitServiceType(subtype, 'outlet')
      const serviceClass = this._getHomeKitPowerServiceClass(serviceType)
      let service = this._getServiceByUUIDAndSubType(serviceClass, subtype)
      const staleService = this._getServiceBySubtype(subtype)
      if (!service && staleService) this.accessory.removeService(staleService)
      if (service) this._checkServiceName(service, this.device.context.name + ' ' + i)
      else service = this.accessory.addService(serviceClass, this.device.context.name + ' ' + i, subtype)

      _validServices.push(service)
    }

    const serviceUUIDs = this._getHomeKitPowerServiceUUIDs()
    this.accessory.services
      .filter(
        (service: any) =>
          serviceUUIDs.has(service.UUID) &&
          /^outlet \d+$/.test(service.subtype || '') &&
          !_validServices.includes(service),
      )
      .forEach((service: any) => {
        this.log.info('Removing', service.displayName)
        this.accessory.removeService(service)
      })
  }

  _registerCharacteristics(dps: DPSState): void {
    this._verifyCachedPlatformAccessory()

    const { Characteristic } = this.hap

    const characteristics: Record<string, any> = {}
    const serviceUUIDs = this._getHomeKitPowerServiceUUIDs()
    this.accessory.services.forEach((service: any) => {
      if (!serviceUUIDs.has(service.UUID) || !service.subtype) return false

      let match: RegExpMatchArray | null
      if ((match = service.subtype.match(/^outlet (\d+)$/)) === null) return

      characteristics[match[1]] = service
        .getCharacteristic(Characteristic.On)
        .updateValue(dps[match[1]])
        .on('get', this.getPower.bind(this, match[1]))
        .on('set', this.setPower.bind(this, match[1]))
    })

    this.device.on('change', (changes: DPSState, _state: DPSState) => {
      Object.keys(changes).forEach((key) => {
        if (characteristics[key] && characteristics[key].value !== changes[key])
          characteristics[key].updateValue(changes[key])
      })
    })
  }

  getPower(dp: string, callback: HomebridgeCallback): void {
    callback(null, this.device.state[dp])
  }

  setPower(dp?: string, value?: DPSValue, callback?: HomebridgeCallback): void {
    if (!this._pendingPower) {
      this._pendingPower = { props: {}, callbacks: [] }
    }

    if (dp) {
      if (this._pendingPower.timer) clearTimeout(this._pendingPower.timer)

      this._pendingPower.props = { ...this._pendingPower.props, ...{ [dp]: value! } }
      this._pendingPower.callbacks.push(callback!)

      this._pendingPower.timer = setTimeout(() => {
        this.setPower()
      }, 500)
      return
    }

    const callbacks = this._pendingPower.callbacks
    const callEachBack = (err: Error | null) => {
      async.eachSeries(callbacks, (callback: HomebridgeCallback, next: () => void) => {
        try {
          callback(err)
        } catch (_ex) {
          /* ignore */
        }
        next()
      })
    }

    const newValue = this._pendingPower.props
    this._pendingPower = null

    this.setMultiState(newValue, callEachBack)
  }
}

export default MultiOutletAccessory
