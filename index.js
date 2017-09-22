'use strict'

const plugin = require('./package'),
  Noble = require('noble'),
  EventEmitter = require('events').EventEmitter
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

// MARK: -

class FanRequest {

  writeInto(buffer) {
    throw new TypeError('Must override method')
  }

  toPrefixedBuffer(prefix) {
    var buffer
    if (prefix > 0) {
      buffer = new Buffer(13)
      buffer.writeUInt8(prefix)
      this.writeInto(buffer.slice(1))
    } else {
      buffer = new Buffer(12)
      this.writeInto(buffer)
    }

    const checksum = buffer.slice(0, buffer.length - 1).reduce(function(a, b){
      return a + b
    }, 0) & 255

    buffer.writeUInt8(checksum, buffer.length - 1)
    return buffer
  }
}

class FanGetStateRequest extends FanRequest {
  writeInto(buffer) {
    buffer.fill(0)
    buffer.writeUInt8(160)
  }
}

Math.clamp = function(number, min, max) {
  return Math.max(min, Math.min(number, max))
}

class FanUpdateLightRequest extends FanRequest {

  constructor(isOn, level) {
    super()
    this.on = isOn ? 1 : 0
    this.level = Math.clamp(level, 0, 100)
  }

  writeInto(buffer) {
    buffer.fill(0)
    buffer.writeUInt8(161)
    buffer.writeUInt8(255, 4)
    buffer.writeUInt8(100, 5)
    buffer.writeUInt8((this.on << 7) | this.level, 6)
    buffer.fill(255, 7, 10)
  }

}

class FanUpdateLevelRequest extends FanRequest {

  constructor(level) {
    super()
    this.level = Math.clamp(level, 0, 3)
  }

  writeInto(buffer) {
    buffer.fill(0)
    buffer.writeUInt8(161)
    buffer.writeUInt8(this.level, 4)
    buffer.fill(255, 5, 10)
  }

}

class FanResponse {

  static fromPrefixedBuffer(prefix, buffer) {
    if (prefix > 0) {
      buffer = buffer.slice(1)
    }

    if (buffer.readUInt8(0) != 176) { return null }
    const response = new FanResponse()

    const windVelocity = buffer.readUInt8(2)
    response.supportsFanReversal = (windVelocity & 0b00100000) != 0
    response.maximumFanLevel     =  windVelocity & 0b00011111

    const currentWindVelocity = buffer.readUInt8(4)
    response.isFanReversed     = (currentWindVelocity & 0b10000000) != 0
    response.fanLevel          =  currentWindVelocity & 0b00011111

    const currentBrightness = buffer.readUInt8(6)
    response.lightIsOn       = (currentBrightness & 0b10000000) != 0
    response.lightBrightness = (currentBrightness & 0b01111111)

    return response
  }

}

// MARK: -

class FanLightAccessory extends EventEmitter {

  constructor (log, config) {
    super()
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
    this.writeCharacteristic = null
    if (!config.ble.notifyCharacteristicUUID) {
      throw new Error(this.prefix + " Missing mandatory config 'ble.notifyCharacteristicUUID'")
    }
    this.notifyCharacteristicUUID = trimUUID(config.ble && config.ble.notifyCharacteristicUUID)
    this.notifyCharacteristic = null

    this.informationService = this.makeInformationService(config)
    this.fanService = this.makeFanService(config)
    this.lightService = this.makeLightService(config)

    this.maximumFanLevel = 3

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
    if (trimAddress(peripheral.address) !== this.address) {
      this.log.debug("Ignoring " + peripheral.address + " (RSSI " + peripheral.rssi + "dB)")
      return
    }

    this.log.debug("Found " + peripheral.address + " (RSSI " + peripheral.rssi + "dB)")
    peripheral.connect(function(error) {
      this.onConnect(error, peripheral)
    }.bind(this))
  }

  onConnect(error, peripheral) {
    if (error) {
      this.log.error("Connecting to " + peripheral.address + " failed: " + error)
    }
    this.log.debug("Connected to " + peripheral.address)

    peripheral.once('disconnect', function(error) { this.onDisconnect(peripheral, error) }.bind(this))
    peripheral.discoverSomeServicesAndCharacteristics([ this.serviceUUID ], [ this.writeCharacteristicUUID, this.notifyCharacteristicUUID ], this.onDiscoverCharacteristics.bind(this));
  }

  onDiscoverCharacteristics(error, services, characteristics) {
    if (error) {
      this.log.error(this.prefix, "Discover services failed: " + error)
      return
    }

    this.writeCharacteristic = characteristics[0]
    this.notifyCharacteristic = characteristics[1]

    this.notifyCharacteristic.on('data', this.onNotify.bind(this));
    this.notifyCharacteristic.subscribe(function (error) {
      if (error) {
        this.log.warn("Subscribe to notify characteristic failed")
      }
    }.bind(this));
  }

  onDisconnect(peripheral, error) {
    peripheral.removeAllListeners()

    if (this.writeCharacteristic) {
      this.writeCharacteristic.removeAllListeners()
    }
    this.writeCharacteristic = null

    if (this.notifyCharacteristic) {
      this.notifyCharacteristic.unsubscribe(null)
      this.notifyCharacteristic.removeAllListeners()
    }
    this.notifyCharacteristic = null

    this.emit('stateChange', error || new Error('Not connected'))

    this.log.info("Disconnected")
    Noble.startScanning([ this.serviceUUID ], false)
  }

  onNotify(data, isNotification) {
    if (!isNotification) { return }
    const response = FanResponse.fromPrefixedBuffer(this.manufacturerPrefix, data)
    if (!response) { return }

    this.maximumFanLevel = response.maximumFanLevel
    this.fanService.getCharacteristic(Characteristic.On).updateValue(response.fanLevel != 0)
    this.fanService.getCharacteristic(Characteristic.RotationSpeed).updateValue(Math.floor((response.fanLevel / response.maximumFanLevel) * 100))
    this.lightService.getCharacteristic(Characteristic.On).updateValue(response.lightIsOn)
    this.lightService.getCharacteristic(Characteristic.Brightness).updateValue(response.lightBrightness)

    this.emit('updateState', null)
  }

  // MARK: -

  sendCommand(command, callback) {
    if (!this.notifyCharacteristic || !this.writeCharacteristic) {
      callback(new Error('Not connected'))
      return
    }

    const buffer = command.toPrefixedBuffer(this.manufacturerPrefix)
    this.writeCharacteristic.write(buffer, false, callback)
  }

  getNextFanState(callback) {
    const shouldSend = this.listeners('updateState').length == 0

    this.once('updateState', callback)

    if (shouldSend) {
      const command = new FanGetStateRequest()
      this.sendCommand(command, function(error){
        if (!error) { return }
        this.emit('updateState', error)
      }.bind(this))
    }
  }

  getFanOn(callback) {
    this.getNextFanState(function(error){
      if (error) {
        callback(error, null)
      } else {
        callback(null, this.fanService.getCharacteristic(Characteristic.On).value)
      }
    }.bind(this))
  }

  setFanOn(newValue, callback) {
    const level = newValue ? this.fanService.getCharacteristic(Characteristic.RotationSpeed).value : 0
    this.log.info('Fan on to level ' + newValue)
    const command = new FanUpdateLevelRequest(level)
    this.sendCommand(command, callback)
  }

  getFanRotationSpeed(callback) {
    this.getNextFanState(function(error){
      if (error) {
        callback(error, null)
      } else {
        callback(null, this.fanService.getCharacteristic(Characteristic.RotationSpeed).value)
      }
    }.bind(this))
  }

  setFanRotationSpeed(newValue, callback) {
    const level = Math.floor(newValue * (this.maximumFanLevel / 100))
    this.log.info('Fan speed: ' + level)

    const command = new FanUpdateLevelRequest(level)
    this.sendCommand(command, callback)
  }

  getLightOn(callback) {
    this.getNextFanState(function(error){
      if (error) {
        callback(error, null)
      } else {
        callback(null, this.lightService.getCharacteristic(Characteristic.On).value)
      }
    }.bind(this))
  }

  setLightOn(newValue, callback) {
    this.log.info('Light on: ' + newValue)
    const brightness = this.lightService.getCharacteristic(Characteristic.Brightness).value
    const command = new FanUpdateLightRequest(newValue, brightness)
    this.sendCommand(command, callback)
  }

  getLightBrightness(callback) {
    this.getNextFanState(function(error){
      if (error) {
        callback(error, null)
      } else {
        callback(null, this.lightService.getCharacteristic(Characteristic.Brightness).value)
      }
    }.bind(this))
  }

  setLightBrightness(newValue, callback) {
    this.log.info('Light brightness: ' + newValue)
    const isOn = this.lightService.getCharacteristic(Characteristic.On).value
    const command = new FanUpdateLightRequest(isOn, newValue)
    this.sendCommand(command, callback)
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
      .on('get', this.getFanOn.bind(this))
      .on('set', this.setFanOn.bind(this))

    service.getCharacteristic(Characteristic.RotationSpeed)
      .on('get', this.getFanRotationSpeed.bind(this))
      .on('set', this.setFanRotationSpeed.bind(this))

    return service
  }

  makeLightService(config) {
    const service = new Service.Lightbulb(this.name)

    service.getCharacteristic(Characteristic.On)
      .on('get', this.getLightOn.bind(this))
      .on('set', this.setLightOn.bind(this))

    service.getCharacteristic(Characteristic.Brightness)
      .on('get', this.getLightBrightness.bind(this))
      .on('set', this.setLightBrightness.bind(this))

    return service
  }

  getServices () {
    return [ this.informationService, this.fanService, this.lightService ]
  }

}
