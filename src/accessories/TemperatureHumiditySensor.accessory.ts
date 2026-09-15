import BaseAccessory from './Base.accessory'
import type { DPSState, DPSValue, HomebridgeCallback } from '../types'

class TemperatureHumiditySensorAccessory extends BaseAccessory {
  static getCategory(Categories: any): number {
    return Categories.SENSOR
  }

  temperatureSensor: any
  humiditySensor: any
  batteryService: any
  dpTemperature!: string
  dpHumidity!: string
  dpBattery!: string | false
  temperatureDivisor!: number
  humidityDivisor!: number

  constructor(...props: any[]) {
    super(...props)
  }

  _registerPlatformAccessory(): void {
    const { Service } = this.hap

    this.accessory.category = (this.constructor as any).getCategory(this.hap.Categories)
    this.temperatureSensor = this.accessory.getService(Service.TemperatureSensor)
    if (!this.temperatureSensor)
      this.temperatureSensor = this.accessory.addService(Service.TemperatureSensor, this.device.context.name)

    this.humiditySensor = this.accessory.getService(Service.HumiditySensor)
    if (!this.humiditySensor)
      this.humiditySensor = this.accessory.addService(Service.HumiditySensor, this.device.context.name + ' Humidity')

    if (this.device.context.dpBattery && Service.BatteryService) {
      this.batteryService = this.accessory.getService(Service.BatteryService)
      if (!this.batteryService)
        this.batteryService = this.accessory.addService(Service.BatteryService, this.device.context.name + ' Battery')
    }

    super._registerPlatformAccessory()
  }

  _registerCharacteristics(dps: DPSState): void {
    const { Service, Characteristic } = this.hap

    if (!this.temperatureSensor) this.temperatureSensor = this.accessory.getService(Service.TemperatureSensor)
    if (!this.humiditySensor) this.humiditySensor = this.accessory.getService(Service.HumiditySensor)
    if (!this.batteryService && this.device.context.dpBattery && Service.BatteryService)
      this.batteryService = this.accessory.getService(Service.BatteryService)

    this.dpTemperature = this._getCustomDP(this.device.context.dpTemperature) || '1'
    this.dpHumidity = this._getCustomDP(this.device.context.dpHumidity) || '2'
    this.dpBattery = this._getCustomDP(this.device.context.dpBattery)
    this.temperatureDivisor =
      Number(this.device.context.temperatureDivisor) > 0 ? Number(this.device.context.temperatureDivisor) : 1
    this.humidityDivisor =
      Number(this.device.context.humidityDivisor) > 0 ? Number(this.device.context.humidityDivisor) : 1

    const temperatureCharacteristic = this.temperatureSensor
      .getCharacteristic(Characteristic.CurrentTemperature)
      .setProps({ minValue: -100, maxValue: 100 })
      .on('get', this.getTemperature.bind(this))
    const humidityCharacteristic = this.humiditySensor
      .getCharacteristic(Characteristic.CurrentRelativeHumidity)
      .setProps({ minValue: 0, maxValue: 100 })
      .on('get', this.getHumidity.bind(this))

    if (this.hasValue(dps, this.dpTemperature))
      temperatureCharacteristic.updateValue(this._getTemperature(dps[this.dpTemperature]))
    if (this.hasValue(dps, this.dpHumidity)) humidityCharacteristic.updateValue(this._getHumidity(dps[this.dpHumidity]))

    const batteryCharacteristic = this.registerBatteryCharacteristic(dps)

    this.device.on('change', (changes: DPSState, state: DPSState) => {
      if (this.hasValue(changes, this.dpTemperature)) {
        const value = this._getTemperature(state[this.dpTemperature])
        if (temperatureCharacteristic.value !== value) temperatureCharacteristic.updateValue(value)
      }

      if (this.hasValue(changes, this.dpHumidity)) {
        const value = this._getHumidity(state[this.dpHumidity])
        if (humidityCharacteristic.value !== value) humidityCharacteristic.updateValue(value)
      }

      if (batteryCharacteristic && this.dpBattery && this.hasValue(changes, this.dpBattery))
        this.updateBatteryCharacteristic(batteryCharacteristic, state[this.dpBattery])
    })
  }

  getTemperature(callback: HomebridgeCallback): void {
    this.getState(this.dpTemperature, (err: Error | null, value: DPSValue) => {
      if (err) return callback(err)
      if (!this.hasValue({ value }, 'value')) return callback(new Error('Temperature not yet available'))
      callback(null, this._getTemperature(value))
    })
  }

  getHumidity(callback: HomebridgeCallback): void {
    this.getState(this.dpHumidity, (err: Error | null, value: DPSValue) => {
      if (err) return callback(err)
      if (!this.hasValue({ value }, 'value')) return callback(new Error('Humidity not yet available'))
      callback(null, this._getHumidity(value))
    })
  }

  _getTemperature(value: DPSValue): number {
    const parsed = Number(value)
    if (!Number.isFinite(parsed)) {
      this.log.warn('[TemperatureHumiditySensor] Temperature DP %s is invalid', this.dpTemperature)
      return 0
    }

    return Math.min(100, Math.max(-100, parsed / this.temperatureDivisor))
  }

  _getHumidity(value: DPSValue): number {
    const parsed = Number(value)
    if (!Number.isFinite(parsed)) {
      this.log.warn('[TemperatureHumiditySensor] Humidity DP %s is invalid', this.dpHumidity)
      return 0
    }

    return Math.min(100, Math.max(0, parsed / this.humidityDivisor))
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
    const lowBattery = this.batteryService.getCharacteristic(Characteristic.StatusLowBattery)
    lowBattery.updateValue(
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
    if (typeof value === 'string') {
      const normalized = value.toLowerCase().trim()
      if (normalized === 'low') return 10
      if (normalized === 'middle' || normalized === 'medium') return 50
      if (normalized === 'high') return 100
    }

    const parsed = Number(value)
    return Number.isFinite(parsed) ? Math.min(100, Math.max(0, parsed)) : 0
  }

  private hasValue(state: DPSState, dp: string): boolean {
    return Object.prototype.hasOwnProperty.call(state, dp) && state[dp] !== undefined && state[dp] !== null
  }
}

export default TemperatureHumiditySensorAccessory
