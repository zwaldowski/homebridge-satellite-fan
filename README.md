# Homebridge Ceiling Fan

[Homebridge](https://github.com/nfarina/homebridge) plugin that controls a ceiling fan control module made by [Satellite Electronic, Ltd.](https://www.fan-light.com) over Bluetooth Low-Energy.

![Satellite Fan module](https://raw.githubusercontent.com/zwaldowski/homebridge-satellite-fan/master/images/module.jpg)

The [MR101F](https://www.fan-light.com/product.php?id=231) module installs into the ceiling fan canopy, substituting the wiring connection between the fan and the house. It also comes with a suprisingly nifty RF remote. The module is rebranded and sold in the US as Harbor Breeze Ceiling Fan Remote Control ([Lowe's](https://www.lowes.com/pd/Harbor-Breeze-Off-White-Handheld-Universal-Ceiling-Fan-Remote-Control/1000014096)).

The plugin was designed and tested on [Raspberry Pi Zero W](https://www.raspberrypi.org/products/raspberry-pi-zero-w/).

## Prerequisites

- Install packages. For Raspbian Stretch:

```shell
# apt install nodejs-legacy npm bluetooth bluez libbluetooth-dev libudev-dev libcap2-bin
```

- Eanble BLE access via non-root users:

```shell
# setcap cap_net_raw+eip /usr/bin/nodejs
```

- Install [Homebridge](https://github.com/nfarina/homebridge#installation).

## Installation

```shell
# npm install -g homebridge homebridge-satellite-fan
```

Update your configuration to include a `satellite-fan` accessory. See an example at [`sample-config.json`](https://github.com/zwaldowski/homebridge-satellite-fan/blob/master/config-sample.json).

## Persistent Installation

See [“Running Homebridge on Bootup”](https://github.com/nfarina/homebridge/wiki/Running-Homebridge-on-a-Raspberry-Pi#running-homebridge-on-bootup-systemd).

In condensed form, start with this [gist](https://gist.github.com/johannrichard/0ad0de1feb6adb9eb61a/) and then:

```shell
# mkdir /var/lib/homebridge
# useradd --system homebridge
# usermod -a -G i2c homebridge
# systemctl daemon-reload
# systemctl enable homebridge
# systemctl start homebridge
$ systemctl status homebridge
```
