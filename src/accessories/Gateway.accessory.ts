import BaseAccessory from './Base.accessory'
import type { DPSState, DPSValue, HomebridgeCallback } from '../types'

class GatewayAccessory extends BaseAccessory {
  static getCategory(Categories: any): number {
    return Categories.SWITCH
  }

  alarmService: any
  alarmSensor: any
  dpAlarmSound!: string | false
  dpAlarmActive!: string | false

  constructor(...props: any[]) {
    super(...props)
    this._ensureServices()
  }

  _registerPlatformAccessory(): void {
    this._ensureServices()
    super._registerPlatformAccessory()
  }

  _ensureServices(): void {
    const { Service } = this.hap
    this.accessory.category = (this.constructor as any).getCategory(this.hap.Categories)
    this.dpAlarmSound = this._getCustomDP(this.device.context.dpAlarmSound)
    this.dpAlarmActive = this._getCustomDP(this.device.context.dpAlarmActive)

    if (this.dpAlarmSound && Service.Switch) {
      this.alarmService = this.accessory.getService(Service.Switch)
      if (!this.alarmService)
        this.alarmService = this.accessory.addService(Service.Switch, this.device.context.name + ' Alarm')
    } else if (Service.Switch) {
      const alarmService =
        this.alarmService ||
        this.accessory.services.find(
          (service: any) =>
            service.UUID === Service.Switch.UUID && service.displayName === this.device.context.name + ' Alarm',
        )
      if (alarmService) this.accessory.removeService(alarmService)
      this.alarmService = undefined
    }
    if (this.dpAlarmActive && Service.ContactSensor) {
      this.alarmSensor = this.accessory.getService(Service.ContactSensor)
      if (!this.alarmSensor)
        this.alarmSensor = this.accessory.addService(Service.ContactSensor, this.device.context.name + ' Alarm Active')
    } else if (Service.ContactSensor) {
      const alarmSensor =
        this.alarmSensor ||
        this.accessory.services.find(
          (service: any) =>
            service.UUID === Service.ContactSensor.UUID &&
            service.displayName === this.device.context.name + ' Alarm Active',
        )
      if (alarmSensor) this.accessory.removeService(alarmSensor)
      this.alarmSensor = undefined
    }
  }

  _registerCharacteristics(dps: DPSState): void {
    const { Characteristic, Service } = this.hap
    this._ensureServices()
    if (!this.alarmService && this.dpAlarmSound && Service.Switch)
      this.alarmService = this.accessory.getService(Service.Switch)
    if (!this.alarmSensor && this.dpAlarmActive && Service.ContactSensor)
      this.alarmSensor = this.accessory.getService(Service.ContactSensor)

    if (this.alarmService && this.dpAlarmSound) {
      const characteristic = this.alarmService
        .getCharacteristic(Characteristic.On)
        .on('get', this.getAlarmSound.bind(this))
        .on('set', this.setAlarmSound.bind(this))
      if (Object.prototype.hasOwnProperty.call(dps, this.dpAlarmSound))
        characteristic.updateValue(this._coerceBoolean(dps[this.dpAlarmSound]))
    }

    if (this.alarmSensor && this.dpAlarmActive) {
      const characteristic = this.alarmSensor
        .getCharacteristic(Characteristic.ContactSensorState)
        .on('get', this.getAlarmActive.bind(this))
      if (Object.prototype.hasOwnProperty.call(dps, this.dpAlarmActive))
        characteristic.updateValue(this._getAlarmState(dps[this.dpAlarmActive]))
    }

    this.device.on('change', (changes: DPSState, state: DPSState) => {
      if (this.alarmService && this.dpAlarmSound && Object.prototype.hasOwnProperty.call(changes, this.dpAlarmSound))
        this.alarmService
          .getCharacteristic(Characteristic.On)
          .updateValue(this._coerceBoolean(state[this.dpAlarmSound]))
      if (this.alarmSensor && this.dpAlarmActive && Object.prototype.hasOwnProperty.call(changes, this.dpAlarmActive))
        this.alarmSensor
          .getCharacteristic(Characteristic.ContactSensorState)
          .updateValue(this._getAlarmState(state[this.dpAlarmActive]))
    })
  }

  getAlarmSound(callback: HomebridgeCallback): void {
    if (!this.dpAlarmSound) return callback(new Error('Alarm sound DP is not configured'))
    this.getState(this.dpAlarmSound, (err, value) => callback(err, err ? undefined : this._coerceBoolean(value)))
  }

  setAlarmSound(value: DPSValue, callback: HomebridgeCallback): void {
    if (!this.dpAlarmSound) return callback(new Error('Alarm sound DP is not configured'))
    this.setState(this.dpAlarmSound, this._coerceBoolean(value), callback)
  }

  getAlarmActive(callback: HomebridgeCallback): void {
    if (!this.dpAlarmActive) return callback(new Error('Alarm active DP is not configured'))
    this.getState(this.dpAlarmActive, (err, value) => callback(err, err ? undefined : this._getAlarmState(value)))
  }

  private _getAlarmState(value: DPSValue): number {
    if (typeof value === 'string') {
      return value.toLowerCase() === 'alarm'
        ? this.hap.Characteristic.ContactSensorState.CONTACT_DETECTED
        : this.hap.Characteristic.ContactSensorState.CONTACT_NOT_DETECTED
    }

    return this._coerceBoolean(value)
      ? this.hap.Characteristic.ContactSensorState.CONTACT_DETECTED
      : this.hap.Characteristic.ContactSensorState.CONTACT_NOT_DETECTED
  }
}

export default GatewayAccessory
