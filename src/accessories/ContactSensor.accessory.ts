import BaseAccessory from './Base.accessory'
import type { DPSState, DPSValue, HomebridgeCallback } from '../types'

class ContactSensorAccessory extends BaseAccessory {
  static getCategory(Categories: any): number {
    return Categories.SENSOR
  }

  contactSensor: any
  batteryService: any
  dpContact!: string
  dpBattery!: string | false
  flipState!: boolean

  constructor(...props: any[]) {
    super(...props)
  }

  _registerPlatformAccessory(): void {
    const { Service } = this.hap

    this.accessory.category = (this.constructor as any).getCategory(this.hap.Categories)
    this.contactSensor = this.accessory.getService(Service.ContactSensor)
    if (!this.contactSensor)
      this.contactSensor = this.accessory.addService(Service.ContactSensor, this.device.context.name)

    if (this.device.context.dpBattery !== 0 && Service.BatteryService) {
      this.batteryService = this.accessory.getService(Service.BatteryService)
      if (!this.batteryService)
        this.batteryService = this.accessory.addService(Service.BatteryService, this.device.context.name + ' Battery')
    }

    super._registerPlatformAccessory()
  }

  _registerCharacteristics(dps: DPSState): void {
    const { Service, Characteristic } = this.hap

    if (!this.contactSensor) this.contactSensor = this.accessory.getService(Service.ContactSensor)
    if (!this.batteryService && this.device.context.dpBattery !== 0 && Service.BatteryService)
      this.batteryService = this.accessory.getService(Service.BatteryService)

    this.dpContact = this._getCustomDP(this.device.context.dpContact) || '1'
    this.dpBattery =
      this.device.context.dpBattery === 0 ? false : this._getCustomDP(this.device.context.dpBattery) || '2'
    this.flipState = this._coerceBoolean(this.device.context.flipState)

    const contactCharacteristic = this.contactSensor
      .getCharacteristic(Characteristic.ContactSensorState)
      .on('get', this.getContactState.bind(this))

    if (this.hasValue(dps, this.dpContact))
      contactCharacteristic.updateValue(this._getContactState(dps[this.dpContact]))

    const batteryCharacteristic = this.registerBatteryCharacteristic(dps)

    this.device.on('change', (changes: DPSState, state: DPSState) => {
      if (this.hasValue(changes, this.dpContact)) {
        const value = this._getContactState(state[this.dpContact])
        if (contactCharacteristic.value !== value) contactCharacteristic.updateValue(value)
      }

      if (batteryCharacteristic && this.dpBattery && this.hasValue(changes, this.dpBattery))
        this.updateBatteryCharacteristic(batteryCharacteristic, state[this.dpBattery])
    })
  }

  getContactState(callback: HomebridgeCallback): void {
    this.getState(this.dpContact, (err: Error | null, value: DPSValue) => {
      if (err) return callback(err)
      if (!this.hasValue({ value }, 'value')) return callback(new Error('Contact state not yet available'))
      callback(null, this._getContactState(value))
    })
  }

  _getContactState(value: DPSValue): number {
    let open = this._isOpen(value)
    if (this.flipState) open = !open

    const { Characteristic } = this.hap
    return open
      ? Characteristic.ContactSensorState.CONTACT_NOT_DETECTED
      : Characteristic.ContactSensorState.CONTACT_DETECTED
  }

  private _isOpen(value: DPSValue): boolean {
    if (typeof value === 'boolean') return value
    if (typeof value === 'number') return value !== 0

    const normalized = String(value).toLowerCase().trim()
    return ['true', '1', 'open', 'opened', 'on'].includes(normalized)
  }

  private registerBatteryCharacteristic(dps: DPSState): any {
    if (!this.batteryService || !this.dpBattery) return null

    const { Characteristic } = this.hap
    const characteristic = this.batteryService
      .getCharacteristic(Characteristic.BatteryLevel)
      .setProps({ minValue: 0, maxValue: 100 })
      .on('get', this.getBattery.bind(this))
    this.batteryService.getCharacteristic(Characteristic.StatusLowBattery).on('get', this.getBatteryLow.bind(this))
    this.batteryService
      .getCharacteristic(Characteristic.ChargingState)
      .updateValue(Characteristic.ChargingState.NOT_CHARGING)

    if (this.hasValue(dps, this.dpBattery)) this.updateBatteryCharacteristic(characteristic, dps[this.dpBattery])
    return characteristic
  }

  updateBatteryCharacteristic(characteristic: any, value: DPSValue): void {
    const level = this._getBatteryLevel(value)
    characteristic.updateValue(level)
    const { Characteristic } = this.hap
    this.batteryService
      .getCharacteristic(Characteristic.StatusLowBattery)
      .updateValue(
        level <= 10
          ? Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW
          : Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL,
      )
  }

  getBattery(callback: HomebridgeCallback): void {
    if (!this.dpBattery) return callback(new Error('Battery DP is not configured'))
    this.getState(this.dpBattery, (err: Error | null, value: DPSValue) => {
      if (err) return callback(err)
      if (!this.hasValue({ value }, 'value')) return callback(new Error('Battery level not yet available'))
      callback(null, this._getBatteryLevel(value))
    })
  }

  getBatteryLow(callback: HomebridgeCallback): void {
    this.getBattery((err, value) => {
      if (err) return callback(err)
      const { Characteristic } = this.hap
      callback(
        null,
        Number(value) <= 10
          ? Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW
          : Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL,
      )
    })
  }

  _getBatteryLevel(value: DPSValue): number {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? Math.min(100, Math.max(0, parsed)) : 0
  }

  private hasValue(state: DPSState, dp: string): boolean {
    return Object.prototype.hasOwnProperty.call(state, dp) && state[dp] !== undefined && state[dp] !== null
  }
}

export default ContactSensorAccessory
