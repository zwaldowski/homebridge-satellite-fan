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

  static get Keys() { return {
    FAN_LEVEL: 'fanLevel',
    FAN_SPEED: 'fanSpeed',
    LIGHT_ON: 'lightIsOn',
    LIGHT_BRIGHTNESS: 'lightBrightness'
  } }

  static fromPrefixedBuffer(prefix, buffer) {
    if (prefix > 0) {
      buffer = buffer.slice(1)
    }

    if (buffer.readUInt8(0) != 176) { return null }
    const response = new FanResponse()

    const windVelocity       = buffer.readUInt8(2)
    response.fanLevelMaximum = windVelocity & 0b00011111

    const currentWindVelocity = buffer.readUInt8(4)
    response.fanLevel         = currentWindVelocity & 0b00011111

    const currentBrightness  = buffer.readUInt8(6)
    response.lightIsOn       = (currentBrightness & 0b10000000) != 0
    response.lightBrightness = (currentBrightness & 0b01111111)

    return response
  }

  get fanSpeed() {
    return (this.fanLevel / this.fanLevelMaximum) * 100
  }

}

// MARK: -

class FanLightAccessory extends EventEmitter {

  constructor (log, config) {
    super()

    this.onDiscover = this.onDiscover.bind(this)

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

    this.fanLevelMaximum = 3

    Homebridge.on('didFinishLaunching', this.onDidFinishLaunching.bind(this))
  }

  identify (callback) {
    this.log('Device identified!')
    callback()
  }

  startScanningWithTimeout() {
    Noble.startScanning([], true)

    setTimeout(function() {
      if (Noble.listenerCount('discover') == 0) { return }
      this.log.debug('Discovery timeout')
      Noble.stopScanning()
    }.bind(this), 12500)
  }

  stopScanning() {
    Noble.removeListener('discover', this.onDiscover)
    if (Noble.listenerCount('discover') == 0) {
      Noble.removeAllListeners('scanStop')
      Noble.stopScanning()
    }
  }

  fanSpeedToLevel(value) {
    return Math.ceil(value * (this.fanLevelMaximum / 100))
  }

  sendCommand(command, callback) {
    if (!this.notifyCharacteristic || !this.writeCharacteristic) {
      this.log.info('waiting on connect...')
      this.once('ready', function() {
        this.sendCommand(command, callback)
      }.bind(this))
      return
    }

    const buffer = command.toPrefixedBuffer(this.manufacturerPrefix)
    this.log.debug('will send', this.manufacturerPrefix, buffer)
    this.writeCharacteristic.write(buffer, false, function(error){
      if (!error) {
        this.log.debug('sent')
      }
      callback(error)
    }.bind(this))
  }

  sendUpdateStateRequest() {
    this.log.info('coalesced update request')
    const command = new FanGetStateRequest()
    this.sendCommand(command, function(error){
      if (!error) { return }
      this.emit('updateState', error)
    }.bind(this))
  }

  // MARK: -

  onDidFinishLaunching() {
    this.log.info("Received did finish launching")
    Noble.on('stateChange', this.onAdapterChange.bind(this))
  }

  onAdapterChange(state) {
    Noble.removeAllListeners('scanStop')
    Noble.stopScanning()

    if (state != 'poweredOn') {
      this.log.debug("Stopped scanning: " + state)
      return
    }

    this.log.debug('Starting scan')

    Noble.on('scanStop', function() {
      setTimeout(function() {
        this.log.debug('Restart from scan stop')
        this.startScanningWithTimeout()
      }.bind(this), 2500)
    }.bind(this))

    Noble.on('discover', this.onDiscover)
    this.log.debug('discover count ', Noble.listenerCount('discover'))
    this.startScanningWithTimeout()
  }

  onDiscover(peripheral) {
    if (trimAddress(peripheral.address) !== this.address || (this.writeCharacteristic && this.notifyCharacteristic)) {
      this.log.debug("Ignoring " + peripheral.address + " (RSSI " + peripheral.rssi + "dB)")
      return
    }

    this.log.debug("Found " + peripheral.address + " (RSSI " + peripheral.rssi + "dB)")
    this.stopScanning()
    peripheral.connect(function(error) {
      this.onConnect(error, peripheral)
    }.bind(this))
  }

  onConnect(error, peripheral) {
    if (error) {
      this.log.error("Connecting to " + peripheral.address + " failed: " + error)
      this.onDisconnect(error, peripheral)
      return
    }
    this.log.debug("Connected to " + peripheral.address)

    peripheral.discoverSomeServicesAndCharacteristics([ this.serviceUUID ], [ this.writeCharacteristicUUID, this.notifyCharacteristicUUID ], this.onDiscoverCharacteristics.bind(this));
    peripheral.once('disconnect', function(error) {
      this.onDisconnect(error, peripheral)
    }.bind(this))
  }

  onDisconnect(error, peripheral) {
    if (this.writeCharacteristic) {
      this.writeCharacteristic.removeAllListeners('set')
    }
    this.writeCharacteristic = null

    if (this.notifyCharacteristic) {
      this.notifyCharacteristic.unsubscribe(null)
      this.notifyCharacteristic.removeAllListeners('data')
    }
    this.notifyCharacteristic = null

    peripheral.removeAllListeners()

    this.log.info("Disconnected")

    this.onDiscover(peripheral)

    if (this.listenerCount('updateState') != 0) {
      this.sendUpdateStateRequest()
    }
  }

  onDiscoverCharacteristics(error, services, characteristics) {
    if (error || characteristics.count < 2) {
      this.log.error(this.prefix, "Discover services failed: " + error)
      return
    }

    const writeCharacteristic = characteristics[0],
      notifyCharacteristic = characteristics[1]

    notifyCharacteristic.on('data', this.onNotify.bind(this))
    notifyCharacteristic.subscribe(function (error) {
      if (error) {
        this.log.warn("Subscribe to notify characteristic failed")
      }

      this.writeCharacteristic = writeCharacteristic
      this.notifyCharacteristic = notifyCharacteristic

      this.log.info("Ready")
      this.emit('ready')
    }.bind(this))
  }

  onNotify(data, isNotification) {
    const response = FanResponse.fromPrefixedBuffer(this.manufacturerPrefix, data)
    if (!response) { return }
    this.log.debug('received fan state')

    this.fanLevelMaximum = response.fanLevelMaximum

    this.emit('updateState', null, response)

    if (response.fanLevel != 0) {
      this.fanService.getCharacteristic(Characteristic.On).updateValue(true)
      this.fanService.getCharacteristic(Characteristic.RotationSpeed).updateValue(response.fanSpeed)
    } else {
      this.fanService.getCharacteristic(Characteristic.On).updateValue(false)
    }

    if (this.lightService) {
      this.lightService.getCharacteristic(Characteristic.On).updateValue(response.lightIsOn)
      this.lightService.getCharacteristic(Characteristic.Brightness).updateValue(response.lightBrightness)
    }
  }

  // MARK: -

  getNextValueForFanState(key, callback) {
    const shouldSend = this.listenerCount('updateState') == 0

    this.once('updateState', function(error, response) {
      if (error) {
        callback(error, null)
      } else {
        callback(null, response[key])
      }
    })

    if (shouldSend) {
      this.sendUpdateStateRequest()
    }
  }

  enqueueWriteForDependentValue(service, characteristic, produceCommand, callback) {
    if (!this.writeCharacteristic) {
      this.once('ready', function() {
        this.enqueueWriteForDependentValue(service, characteristic, produceCommand, callback)
      }.bind(this))
      return
    }

    if (this.listenerCount('updateState') != 0) {
      this.once('updateState', function() {
        this.enqueueWriteForDependentValue(service, characteristic, produceCommand, callback)
      }.bind(this))
      return
    }

    if (this.writeCharacteristic.listenerCount('write') <= 1) {
      this.writeCharacteristic.once('write', function() {
        this.enqueueWriteForDependentValue(service, characteristic, produceCommand, callback)
      }.bind(this))
      return
    }

    const command = produceCommand(service.getCharacteristic(characteristic).value)
    this.sendCommand(command, callback)
  }

  getFanOn(callback) {
    this.getNextValueForFanState(FanResponse.Keys.FAN_LEVEL, function(error, level) {
      callback(error, error ? null : level != 0)
    }.bind(this))
  }

  setFanOn(newValue, callback) {
    this.log.info('Fan on: ' + newValue)

    if (!newValue) {
      const command = new FanUpdateLevelRequest(0)
      this.sendCommand(command, callback)
      return
    }

    this.enqueueWriteForDependentValue(this.fanService, Characteristic.RotationSpeed, function(currentSpeed){
      const level = this.fanSpeedToLevel(currentSpeed)
      this.log.debug('Using current level: ' + level)

      return new FanUpdateLevelRequest(level)
    }.bind(this), callback)
  }

  getFanRotationSpeed(callback) {
    this.getNextValueForFanState(FanResponse.Keys.FAN_SPEED, callback)
  }

  setFanRotationSpeed(newValue, callback) {
    const level = this.fanSpeedToLevel(newValue)
    this.log.info('Fan speed: ' + level)

    const command = new FanUpdateLevelRequest(level)
    this.sendCommand(command, callback)
  }

  getLightOn(callback) {
    this.getNextValueForFanState(FanResponse.Keys.LIGHT_ON, callback)
  }

  setLightOn(newValue, callback) {
    this.log.info('Light on: ' + newValue)

    this.enqueueWriteForDependentValue(this.lightService, Characteristic.Brightness, function(currentBrightness) {
      this.log.debug('Using current brightness: ' + currentBrightness)
      return new FanUpdateLightRequest(newValue, currentBrightness)
    }.bind(this), callback)
  }

  getLightBrightness(callback) {
    this.getNextValueForFanState(FanResponse.Keys.LIGHT_BRIGHTNESS, callback)
  }

  setLightBrightness(newValue, callback) {
    this.log.info('Light brightness: ' + newValue)

    this.enqueueWriteForDependentValue(this.lightService, Characteristic.On, function(currentlyOn) {
      return new FanUpdateLightRequest(currentlyOn, newValue)
    }, callback)
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
      .setProps({
        maxValue: 99,
        minStep: 33
      })
      .on('get', this.getFanRotationSpeed.bind(this))
      .on('set', this.setFanRotationSpeed.bind(this))

    return service
  }

  makeLightService(config) {
    if (config.light === false) { return null }

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
    return [ this.informationService, this.fanService, this.lightService ].filter(Boolean)
  }

}
