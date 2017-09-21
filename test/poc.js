#!/usr/bin/node --harmony

'use strict'

const noble = require('noble'),
  program = require('commander')

program
  .version('0.0.1')
  .option('-p, --prefix <integer>', 'Manufacturer identifier prefixed to all fan commands', parseInt)
  .option('-t, --target [mac]', 'MAC address of devices to target', function(val){ return val.toLowerCase() })
  .option('-s, --service <uuid>', 'UUID of fan controller BLE service')
  .option('-w, --write <uuid>', 'UUID of fan controller BLE write characteristic')
  .option('-n, --notify <uuid>', 'UUID of fan controller BLE notify characteristic')

class FanRequest {

  writeInto(buffer) {
    throw new TypeError('Must override method')
  }

  toBuffer() {
    var buffer
    if (program.prefix > 0) {
      buffer = new Buffer(13)
      buffer.writeUInt8(program.prefix)
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

  static fromBuffer(buffer) {
    if (program.prefix > 0) {
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

var command

program
  .command('current')
  .description('print current state')
  .action(function(env, options) {
    command = new FanGetStateRequest()
  })

program
  .command('fan')
  .description('adjusts the fan')
  .option('-l --level <size>', 'Fan speed', /^(off|low|medium|high)$/i, 'high')
  .action(function(env, options) {
    var level
    switch (env.level) {
      case 'low':
        level = 1
        break
      case 'medium':
        level = 2
        break
      case 'high':
        level = 3
        break
      default:
        level = 0
        break
    }
    command = new FanUpdateLevelRequest(level)
  })

program
  .command('light <on|off>')
  .description('adjusts the light')
  .option('-l, --level <percent>', 'Light brightness', parseInt, 100)
  .action(function(env, options) {
    command = new FanUpdateLightRequest(env !== 'off', options.level)
  })

program.parse(process.argv);

if (!command) {
  program.help();
}

if (!program.target) {
  throw new Error('MAC address required')
}

const serviceUUID = program.service || '539c681361a021374f79bf1a11984790'
const writeUUID = program.write || '539c681361a121374f79bf1a11984790'
const notifyUUID = program.notify || '539c681361a221374f79bf1a11984790'

noble.on('stateChange', function(state) {
  if (state === 'poweredOn') {
    console.log('scanning.')
    noble.startScanning([ serviceUUID ], false)
  } else {
    noble.stopScanning()
  }
})

noble.on('discover', function(peripheral) {
  console.log('found ' + peripheral.address)
  if (peripheral.address !== program.target) { return }
  noble.stopScanning()
  explore(peripheral)
});

function bail(error) {
  console.log('failed: ' + error);
  process.exit(1)
}

function explore(peripheral) {
  console.log('connecting.')

  peripheral.once('disconnect', function() {
    peripheral.removeAllListeners()
    explore(peripheral)
  })

  peripheral.connect(function(error) {
    if (error) { bail(error); }

    peripheral.discoverSomeServicesAndCharacteristics([ serviceUUID ], [ writeUUID, notifyUUID ], function(error, services, characteristics) {
      if (error) { bail(error); }
      var service = services[0]
      var write = characteristics[0], notify = characteristics[1]

      notify.on('data', function(data, isNotification) {
        const response = FanResponse.fromBuffer(data)
        if (response) {
          console.log(response)
        } else {
          console.log('sent')
        }
        process.exit()
      })

      notify.subscribe(function(error) {
        if (error) { bail(error); }

        console.log('sending')

        const buffer = command.toBuffer()
        write.write(buffer, false, function(error){
          if (error) { bail(error); }
        })
      })
    })
  })
}

