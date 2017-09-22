'use strict'

const plugin = require('./package'),
  Noble = require('noble')
var Homebridge, Service, Characteristic

module.exports = function(homebridge) {
  console.log("Homebridge API version: " + homebridge.version)

  Homebridge = homebridge
  Service = homebridge.hap.Service
  Characteristic = homebridge.hap.Characteristic

  homebridge.registerAccessory(plugin.name, "satellite-fan", FanLightAccessory)
}

function trimAddress(address) {
  return address.toLowerCase().replace(/:/g, "")
}

function trimUUID(uuid) {
  return uuid.toLowerCase().replace(/:/g, "").replace(/-/g, "")
}

class FanLightAccessory {

  constructor (log, config) {
    this.log = log

    this.name = config.name || "Ceiling Fan"
    if (!config.address) {
      throw new Error(this.prefix + " Missing mandatory config 'address'")
    }
    this.address = trimAddress(config.address)
    if (!config.ble) {
      throw new Error(this.prefix + " Missing mandatory config 'ble'")
    }
    this.manufacturerPrefix = config.ble.prefix || 0
    if (!config.ble.serviceUUID) {
      throw new Error(this.prefix + " Missing mandatory config 'ble.serviceUUID'")
    }
    this.serviceUUID = trimUUID(config.ble.serviceUUID)
    if (!config.ble.writeCharacteristicUUID) {
      throw new Error(this.prefix + " Missing mandatory config 'ble.writeCharacteristicUUID'")
    }
    this.writeCharacteristicUUID = trimUUID(config.ble && config.ble.writeCharacteristicUUID)
    if (!config.ble.notifyCharacteristicUUID) {
      throw new Error(this.prefix + " Missing mandatory config 'ble.notifyCharacteristicUUID'")
    }
    this.notifyCharacteristicUUID = trimUUID(config.ble && config.ble.notifyCharacteristicUUID)

    this.informationService = this.makeInformationService(config)
    this.fanService = this.makeFanService(config)
    this.lightService = this.makeLightService(config)

    Homebridge.on('didFinishLaunching', this.onDidFinishLaunching.bind(this))
  }

  identify (callback) {
    this.log('Device identified!')
    callback()
  }

  // MARK: -

  onDidFinishLaunching() {
    this.log.info("Received did finish launching")
    Noble.on('stateChange', this.onStateChange.bind(this))
  }

  onStateChange(state) {
    if (state != 'poweredOn') {
      this.log.debug("Stopped scanning: " + state)
      Noble.stopScanning()
    }

    this.log.debug("Started scanning: " + state)
    Noble.startScanning([ this.serviceUUID ], false)
    Noble.on('discover', this.onDiscover.bind(this))
  }

  onDiscover(peripheral) {
    this.log.info('found ' + peripheral.address)
    if (trimAddress(peripheral.address) !== this.address) { return }
    Noble.stopScanning()
  }

  // MARK: -

  makeInformationService(config) {
    const service = new Service.AccessoryInformation()

    service
      .setCharacteristic(Characteristic.Manufacturer, config.device && config.device.manufacturer)
      .setCharacteristic(Characteristic.Model, config.device && config.device.model)
      .setCharacteristic(Characteristic.SerialNumber, config.device && config.device.serial)
      .setCharacteristic(Characteristic.FirmwareRevision, (config.device && config.device.revision) || plugin.version)

    return service
  }

  makeFanService(config) {
    const service = new Service.Fan(this.name)

    service.getCharacteristic(Characteristic.On)
      .on('get', function(callback) {
        callback(null, false)
      })
      .on('set', (function(value, callback) {
        this.log.debug('fan on set to ' + value)
        callback(null)
      }).bind(this))

    service.getCharacteristic(Characteristic.RotationSpeed)
      .on('get', function(callback) {
        callback(null, 100)
      })
      .on('set', (function(value, callback) {
        this.log.debug('fan speed set to ' + value)
        callback(null)
      }).bind(this))

    return service
  }

  makeLightService(config) {
    const service = new Service.Lightbulb(this.name)

    service.getCharacteristic(Characteristic.On)
      .on('get', function(callback) {
        callback(null, false)
      })
      .on('set', (function(value, callback) {
        this.log.debug('light on set to ' + value)
        callback(null)
      }).bind(this))

    service.getCharacteristic(Characteristic.Brightness)
      .on('get', function(callback) {
        callback(null, 100)
      })
      .on('set', (function(value, callback) {
        this.log.debug('light bright set to ' + value)
        callback(null)
      }).bind(this))

    return service
  }

  getServices () {
    return [ this.informationService, this.fanService, this.lightService ]
  }

}
