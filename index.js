"use strict";
const darksky = require('./api/darksky'),
	weatherunderground = require('./api/weatherunderground'),
	debug = require('debug')('homebridge-weather-plus');

var Service,
	Characteristic,
	CustomCharacteristic,
	FakeGatoHistoryService;

module.exports = function (homebridge) {
	Service = homebridge.hap.Service;

	// Homekit Characteristics
	Characteristic = homebridge.hap.Characteristic;
	// Custom Characteristics
	CustomCharacteristic = require('./util/characteristics')(homebridge);
	// History Service
	FakeGatoHistoryService = require('fakegato-history')(homebridge);

	homebridge.registerPlatform("homebridge-weather-plus", "WeatherPlus", WeatherStationPlatform);
}

// ============
// = Platform =
// ============
function WeatherStationPlatform(log, config) {
	debug("Init platform");
	this.log = log;
	this.config = config;
	this.key = config['key'];
	this.location = config['location'];
	this.forecastDays = ('forecast' in config ? config['forecast'] : []);
	this.language = ('language' in config ? config['language'] : 'en');

	// API Service
	let service = config['service'].toLowerCase().replace(/\s/g, '');
	if (service === 'darksky') {
		debug("Using service dark sky");
		// TODO adapt unit of characteristics
		darksky.init(this.key, this.language, this.location, log, debug);
		this.api = darksky;
	}
	else if (service === 'weatherunderground') {
		debug("Using service weather underground");
		weatherunderground.init(this.key, this.location, log, debug);
		this.api = weatherunderground;
	}

	// Update interval
	this.interval = ('interval' in config ? parseInt(config['interval']) : 4);
	this.interval = (typeof this.interval !== 'number' || (this.interval % 1) !== 0 || this.interval < 0) ? 4 : this.interval;
}

WeatherStationPlatform.prototype = {
	// Get the current condition accessory and all forecast accessories
	accessories: function (callback) {
		this.accessories = [];
		this.accessories.push(new CurrentConditionsWeatherAccessory(this));

		// Add all configured forecast days
		for (let i = 0; i < this.forecastDays.length; i++) {
			const day = this.forecastDays[i];
			if (typeof day === 'number' && (day % 1) === 0 && day >= 1 && day <= this.api.forecastDays) {
				this.accessories.push(new ForecastWeatherAccessory(this, day - 1));
			}
			else {
				debug("Ignoring forecast day: " + day);
			}
		}

		callback(this.accessories);
	},

	// Update the weather for all accessories
	updateWeather: function () {
		let that = this;

		this.api.update(function (error, weather) {
			if (!error) {

				for (var i = 0; i < that.accessories.length; i++) {
					// Add current weather conditions
					if (that.accessories[i].currentConditionsService !== undefined && weather.report !== undefined) {
						try {
							let service = that.accessories[i].currentConditionsService;
							let data = weather.report;

							for (let i = 0; i < that.api.reportCharacteristics.length; i++) {
								const name = that.api.reportCharacteristics[i];
								that.saveCharacteristic(service, name, data[name]);
							}
						}
						catch (error) {
							that.log.error("Exception while parsing weather report: " + error);
							that.log.error("Report: " + weather.report);
						}
					}
					// Add a weather forecast for the given day
					else if (that.accessories[i].forecastService !== undefined && weather.forecasts[that.accessories[i].day] !== undefined) {
						try {
							let service = that.accessories[i].forecastService;
							let data = weather.forecasts[that.accessories[i].day];

							for (let i = 0; i < that.api.forecastCharacteristics.length; i++) {
								const name = that.api.forecastCharacteristics[i];
								that.saveCharacteristic(service, name, data[name]);
							}
						}
						catch (error) {
							that.log.error("Exception while parsing weather forecast: " + error);
							that.log.error("Forecast: " + weather.forecast);
						}
					}
				}
			}
		});
		setTimeout(this.updateWeather.bind(this), (this.interval) * 60 * 1000);
	},

	// Save changes from update in characteristics
	saveCharacteristic: function (service, name, value) {
		// humidity not a custom but a general apple home kit characteristic
		if (name === 'Humidity') {
			service.setCharacteristic(Characteristic.CurrentRelativeHumidity, value);
		}
		// temperature not a custom but a general apple home kit characteristic
		else if (name === 'Temperature') {
			service.setCharacteristic(Characteristic.CurrentTemperature, value);
		}
		// all other custom characteristics
		else {
			service.setCharacteristic(CustomCharacteristic[name], value);
		}
	},

	// Add history entry
	addHistory: function () {
		debug("Saving history entry");

		for (var i = 0; i < this.accessories.length; i++) {
			if (this.accessories[i] !== undefined && this.accessories[i].currentConditionsService !== undefined) {
				// Add entry to history
				this.accessories[i].historyService.addEntry({
					time: new Date().getTime() / 1000,
					temp: this.accessories[i].currentConditionsService.getCharacteristic(Characteristic.CurrentTemperature).value,
					pressure: this.accessories[i].currentConditionsService.getCharacteristic(CustomCharacteristic.AirPressure).value,
					humidity: this.accessories[i].currentConditionsService.getCharacteristic(Characteristic.CurrentRelativeHumidity).value
				});
				break;
			}
		}

		// Call function every 9:50 minutes (a new entry every 10 minutes is required to avoid gaps in the graph)
		setTimeout(this.addHistory.bind(this), (10 * 60 * 1000) - 10000);
	}
}

// ===============================
// = Current Condition Accessory =
// ===============================
function CurrentConditionsWeatherAccessory(platform) {
	this.platform = platform;
	this.log = platform.log;
	this.name = "Now";
	this.displayName = this.name;

	// Create temperature sensor service that includes temperature characteristic
	this.currentConditionsService = new Service.TemperatureSensor(this.name);

	// Fix negative temperatures not supported by homekit
	this.currentConditionsService.getCharacteristic(Characteristic.CurrentTemperature).props.minValue = -50;

	// Add additional characteristics to temperature sensor that are supported by the selected api
	for (let i = 0; i < this.platform.api.reportCharacteristics.length; i++) {
		const name = this.platform.api.reportCharacteristics[i];

		// humidity not a custom but a general apple home kit characteristic
		if (name === 'Humidity') {
			this.currentConditionsService.addCharacteristic(Characteristic['CurrentRelativeHumidity']);
		}
		// temperature is already in the service
		else if (name !== 'Temperature') {
			this.currentConditionsService.addCharacteristic(CustomCharacteristic[name]);
		}
	}

	// Create information service
	this.informationService = new Service.AccessoryInformation();
	this.informationService
		.setCharacteristic(Characteristic.Manufacturer, "github.com naofireblade")
		.setCharacteristic(Characteristic.Model, this.platform.api.attribution)
		.setCharacteristic(Characteristic.SerialNumber, this.platform.location);

	// Create history service
	this.historyService = new FakeGatoHistoryService("weather", this, {
		storage: 'fs'
	});
	setTimeout(this.platform.addHistory.bind(this.platform), 10000);

	// Start the weather update process
	this.platform.updateWeather();
}

CurrentConditionsWeatherAccessory.prototype = {
	identify: function (callback) {
		callback();
	},

	getServices: function () {
		return [this.informationService, this.currentConditionsService, this.historyService];
	}
}

// ======================
// = Forecast Accessory =
// ======================
function ForecastWeatherAccessory(platform, day) {
	this.platform = platform;
	this.log = platform.log;

	switch (day) {
		case 0:
			this.name = "Today";
			break;
		case 1:
			this.name = "In 1 Day";
			break;
		default:
			this.name = "In " + day + " Days";
			break;
	}
	this.day = day;

	// Create temperature sensor service that includes temperature characteristic
	this.forecastService = new Service.TemperatureSensor(this.name);

	// Fix negative temperatures not supported by homekit
	this.forecastService.getCharacteristic(Characteristic.CurrentTemperature).props.minValue = -50;

	// Add additional characteristics to temperature sensor that are supported by the selected api
	for (let i = 0; i < this.platform.api.forecastCharacteristics.length; i++) {
		const name = this.platform.api.forecastCharacteristics[i];

		// humidity not a custom but a general apple home kit characteristic
		if (name === 'Humidity') {
			this.forecastService.addCharacteristic(Characteristic['CurrentRelativeHumidity']);
		}
		// temperature is already in the service
		else if (name !== 'Temperature') {
			this.forecastService.addCharacteristic(CustomCharacteristic[name]);
		}
	}

	// Create information service
	this.informationService = new Service.AccessoryInformation();
	this.informationService
		.setCharacteristic(Characteristic.Manufacturer, "github.com naofireblade")
		.setCharacteristic(Characteristic.Model, this.platform.api.attribution)
		.setCharacteristic(Characteristic.SerialNumber, this.platform.location);
}

ForecastWeatherAccessory.prototype = {
	identify: function (callback) {
		callback();
	},

	getServices: function () {
		return [this.informationService, this.forecastService];
	}
}