/*
 * @moleculer/channels
 * Copyright (c) 2021 MoleculerJS (https://github.com/moleculerjs/channels)
 * MIT Licensed
 */

"use strict";

const _ = require("lodash");
const { BrokerOptionsError, ServiceSchemaError } = require("moleculer").Errors;
const Adapters = require("./adapters");

/**
 * Type defs to add some IntelliSense
 * @typedef {import("moleculer").ServiceBroker} ServiceBroker
 * @typedef {import("moleculer").LoggerInstance} Logger
 * @typedef {import("moleculer").Service} Service
 * @typedef {import("./adapters/base")} BaseAdapter
 */

/**
 * @typedef {Object} Channel Consumer configuration
 * @property {String} id Consumer ID
 * @property {String} name Channel/Queue/Stream name
 * @property {String} group Consumer group name
 * @property {Boolean} unsubscribing Flag denoting if service is stopping
 * @property {Boolean} messageLock Flag denoting if channel is processing messages and, therefore, cannot be stopped.
 * @property {Number?} maxInFlight Max number of messages to fetch in a single read
 * @property {Function} handler User defined handler
 */

module.exports = function ChannelsMiddleware(mwOpts) {
	mwOpts = _.defaultsDeep(mwOpts, {});
	/** @type {ServiceBroker} */
	let broker;
	/** @type {Logger} */
	let logger;
	/** @type {BaseAdapter} */
	let adapter;
	let started = false;
	let channelRegistry = [];

	function registerChannel(svc, chan) {
		unregisterChannel(svc, chan);
		channelRegistry.push({ svc, name: chan.name, chan });
	}

	function unregisterChannel(svc, chan) {
		channelRegistry = channelRegistry.filter(
			item => !(item.svc.fullName == svc.fullName && (chan == null || chan.name == item.name))
		);
	}

	return {
		name: "Channels",

		/**
		 * Create lifecycle hook of service
		 */
		created(_broker) {
			broker = _broker;
			logger = broker.getLogger("Channels");

			// Create adapter
			if (!mwOpts.adapter)
				throw new BrokerOptionsError("Channel adapter must be defined.", { opts: mwOpts });

			adapter = Adapters.resolve(mwOpts.adapter);
			adapter.init(broker, logger);

			// Populate broker with new methods
			if (!broker.sendToChannel) {
				broker.sendToChannel = (channelName, payload, opts) => {
					return adapter.publish(channelName, payload, opts);
				};
			}

			// Add adapter reference to the broker instance
			broker.channelAdapter = adapter;
		},

		/**
		 * Created lifecycle hook of service
		 *
		 * @param {Service} svc
		 */
		async serviceCreated(svc) {
			if (_.isPlainObject(svc.schema.channels)) {
				//svc.$channels = {};
				// Process `channels` in the schema
				await broker.Promise.mapSeries(
					Object.entries(svc.schema.channels),
					async ([name, def]) => {
						/** @type {Channel} */
						let chan;

						if (_.isFunction(def)) {
							chan = {
								handler: def
							};
						} else if (_.isPlainObject(def)) {
							chan = _.cloneDeep(def);
						} else {
							throw new ServiceSchemaError(
								`Invalid channel definition in '${name}' channel in '${svc.fullName}' service!`
							);
						}

						if (!_.isFunction(chan.handler)) {
							throw new ServiceSchemaError(
								`Missing channel handler on '${name}' channel in '${svc.fullName}' service!`
							);
						}

						if (!chan.name) chan.name = name;
						if (!chan.group) chan.group = svc.fullName;

						// Consumer ID
						chan.id = `${broker.nodeID}|${svc.fullName}|${chan.name}`;
						chan.unsubscribing = false;
						chan.messageLock = false;

						// Wrap the original handler
						const handler = chan.handler;
						chan.handler = broker.Promise.method(handler).bind(svc);

						//svc.$channels[name] = chan;
						logger.debug(
							`Registering '${chan.name}' channel in '${svc.fullName}' service with group '${chan.group}'...`
						);
						registerChannel(svc, chan);

						if (started) {
							// If middleware has already started, we should subscribe to the channel right now.
							await adapter.subscribe(chan);
						}
					}
				);
			}
		},

		/**
		 * Service stopping lifecycle hook.
		 * Need to unsubscribe from the channels.
		 *
		 * @param {Service} svc
		 */
		async serviceStopping(svc) {
			await Promise.all(
				channelRegistry
					.filter(item => item.svc.fullName == svc.fullName)
					.map(async ({ chan }) => {
						await adapter.unsubscribe(chan);
					})
			);
			unregisterChannel(svc);
		},

		/**
		 * Start lifecycle hook of service
		 */
		async started() {
			logger.info("Channel adapter is connecting...");
			await adapter.connect();
			logger.debug("Channel adapter connected.");

			logger.info(`Subscribing to ${channelRegistry.length} channels...`);
			await broker.Promise.mapSeries(
				channelRegistry,
				async ({ chan }) => await adapter.subscribe(chan)
			);

			started = true;
		},

		/**
		 * Stop lifecycle hook of service
		 */
		async stopped() {
			logger.info("Channel adapter is disconnecting...");
			await adapter.disconnect();
			logger.debug("Channel adapter disconnected.");

			started = false;
		}
	};
};
