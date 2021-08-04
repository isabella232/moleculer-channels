/*
 * @moleculer/channels
 * Copyright (c) 2021 MoleculerJS (https://github.com/moleculerjs/channels)
 * MIT Licensed
 */

"use strict";

const _ = require("lodash");
const BaseAdapter = require("./base");
const { ServiceSchemaError } = require("moleculer").Errors;

let Redis;

/**
 * Type defs to add some IntelliSense
 * @typedef {import("ioredis").Cluster} Cluster
 * @typedef {import("ioredis").Redis} Redis
 * @typedef {import("moleculer").ServiceBroker} ServiceBroker
 * @typedef {import("moleculer").LoggerInstance} Logger
 */

/**
 * Redis Streams adapter
 *
 * @class RedisAdapter
 * @extends {BaseAdapter}
 */
class RedisAdapter extends BaseAdapter {
	/**
	 * Constructor of adapter.
	 *
	 * @param  {Object?} opts
	 */
	constructor(opts) {
		if (_.isString(opts)) opts = { redis: opts };

		super(opts);

		this.opts = _.defaultsDeep(this.opts, {
			serializer: "JSON"
		});

		/**
		 * @type {Map<string,Cluster|Redis>}
		 */
		this.clients = new Map();
		this.pubName = "Pub"; // Static name of the Publish client

		this.stopping = false;
	}

	/**
	 * Initialize the adapter.
	 *
	 * @param {ServiceBroker} broker
	 * @param {Logger} logger
	 */
	init(broker, logger) {
		super.init(broker, logger);

		try {
			Redis = require("ioredis");
			Redis.Promise = this.Promise;
		} catch (err) {
			/* istanbul ignore next */
			this.broker.fatal(
				"The 'ioredis' package is missing! Please install it with 'npm install ioredis --save' command.",
				err,
				true
			);
		}

		this.checkClientLibVersion("ioredis", "^4.27.6");
	}

	/**
	 * Connect to the adapter.
	 */
	async connect() {
		this.clients.set(this.pubName, await this.createRedisClient(this.pubName, this.opts.redis));
	}

	/**
	 * Disconnect from adapter
	 */
	async disconnect() {
		this.stopping = true;

		return new Promise((resolve, reject) => {
			const checkPendingMessages = () => {
				if (this.getNumberOfTrackedChannels() === 0) {
					// Stop the publisher client
					// The subscriber clients are stopped in unsubscribe() method, which is called in serviceStopping()
					const promises = Array.from(this.clients.values()).map(client => {
						return client.disconnect();
					});

					return Promise.all(promises)
						.then(() => {
							// Release the pointers
							this.clients = new Map();
						})
						.then(() => resolve())
						.catch(err => reject(err));
				} else {
					this.logger.warn(
						`Processing ${this.getNumberOfTrackedChannels()} active connections(s)...`
					);

					setTimeout(checkPendingMessages, 100);
				}
			};

			setImmediate(checkPendingMessages);
		});
	}

	/**
	 * Return redis or redis.cluster client instance
	 *
	 * @param {string} name Client name
	 * @param {any} opts
	 *
	 * @memberof RedisTransporter
	 * @returns {Promise<Cluster|Redis>)}
	 */
	createRedisClient(name, opts) {
		return new Promise((resolve, reject) => {
			/** @type {Cluster|Redis} */
			let client;
			if (opts && opts.cluster) {
				if (!opts.cluster.nodes || opts.cluster.nodes.length === 0) {
					throw new ServiceSchemaError("No nodes defined for cluster");
				}
				client = new Redis.Cluster(opts.cluster.nodes, opts.cluster.clusterOptions);
			} else {
				client = new Redis(opts);
			}

			let isConnected = false;
			client.on("connect", () => {
				this.logger.info(`Redis-Channel-Client-${name} adapter is connected.`);
				isConnected = true;
				resolve(client);
			});

			/* istanbul ignore next */
			client.on("error", err => {
				this.logger.error(`Redis-Channel-Client-${name} adapter error`, err.message);
				this.logger.debug(err);
				if (!isConnected) reject(err);
			});

			client.on("close", () => {
				this.logger.info(`Redis-Channel-Client-${name} adapter is disconnected.`);
			});
		});
	}

	/**
	 * Subscribe to a channel with a handler.
	 *
	 * @param {Channel} chan
	 */
	async subscribe(chan) {
		this.logger.debug(
			`Subscribing to '${chan.name}' chan with '${chan.group}' group...'`,
			chan.id
		);

		// Create a connection for current subscription
		let chanSub;
		if (this.clients.has(chan.id)) {
			chanSub = this.clients.get(chan.id);
		} else {
			chanSub = await this.createRedisClient(chan.id, this.opts.redis);
			this.clients.set(chan.id, chanSub);
		}

		this.initChannelActiveMessages(chan.id);

		// 1. Create stream and consumer group
		try {
			// https://redis.io/commands/XGROUP
			await chanSub.xgroup(
				"CREATE",
				chan.name, // Stream name
				chan.group, // Consumer group
				`$`, // Only the latest data
				`MKSTREAM` // Create stream if doesn't exist
			);
		} catch (err) {
			if (err.message.includes("BUSYGROUP")) {
				// Silently ignore the error. Channel or Consumer Group already exists
				this.logger.debug(`Consumer group '${chan.group}' already exists.`);
			} else {
				this.logger.error(
					`Unable to create the '${chan.name}' stream or consumer group '${chan.group}'.`,
					err
				);
			}
		}

		// Inspired on https://stackoverflow.com/questions/62179656/node-redis-xread-blocking-subscription
		chan.xreadgroup = async () => {
			// Adapter is stopping. Reading no longer is allowed
			if (this.stopping) return;

			this.logger.debug(`Next xreadgroup...`, chan.id);

			try {
				// this.logger.debug(`Subscription ${chan.id} is armed and waiting....`)
				// https://redis.io/commands/xreadgroup
				let message;
				try {
					message = await chanSub.xreadgroup(
						`GROUP`,
						chan.group, // Group name
						chan.id, // Consumer name
						`BLOCK`,
						0, // Never timeout while waiting for messages
						`COUNT`,
						chan.maxInFlight || 1, // Max number of messages to receive in a single read
						`STREAMS`,
						chan.name, // Channel name
						`>` //  Read messages never delivered to other consumers so far
					);
				} catch (error) {
					if (chan.unsubscribing) {
						// Caused by unsubscribe()
						return; // Exit the loop.
					} else {
						this.logger.error(error);
					}
				}

				if (message) {
					chan.messageLock = true;

					const { ids, parsedMessages } = this.parseMessage(message);

					this.addChannelActiveMessages(chan.id, ids);

					const promises = parsedMessages.map(entry => {
						// Call the actual user defined handler
						return chan.handler(entry);
					});

					const promiseResults = await Promise.allSettled(promises);

					for (const result of promiseResults) {
						if (result.status == "fulfilled") {
							// Send ACK message
							// https://redis.io/commands/xack
							// Use pubClient to ensure that ACK is delivered to redis
							const pubClient = this.clients.get(this.pubName);
							await pubClient.xack(chan.name, chan.group, ids);
							this.logger.debug(`Messages is ACKed.`, {
								id: ids,
								name: chan.name,
								group: chan.group
							});
						} else {
							// Rejected
						}

						this.removeChannelActiveMessages(chan.id, ids);
					}

					chan.messageLock = false;
				}
			} catch (error) {
				this.logger.error(error);
			}

			setTimeout(() => chan.xreadgroup(), 0);
		};

		// Init the subscription loop
		chan.xreadgroup();
	}

	/**
	 * Parse the message(s)
	 * @param {Array} messages
	 * @returns {Array}
	 */
	parseMessage(messages) {
		return messages[0][1].reduce(
			(accumulator, currentVal) => {
				accumulator.ids.push(currentVal[0]);
				accumulator.parsedMessages.push(this.serializer.deserialize(currentVal[1][1]));

				return accumulator;
			},
			{
				ids: [], // for XACK
				parsedMessages: []
			}
		);
	}

	/**
	 * Unsubscribe from a channel.
	 *
	 * @param {Channel} chan
	 */
	async unsubscribe(chan) {
		return (
			Promise.resolve()
				.then(() => {
					// "Break" the xreadgroup() by disconnecting the client
					// Will trigger an error that has to be handled
					chan.unsubscribing = true;
					this.clients.get(chan.id).disconnect();
				})
				// Add delay to ensure that client is disconnected
				.then(() => new Promise(resolve => setTimeout(resolve, 100)))
				.then(() => {
					return new Promise((resolve, reject) => {
						const checkPendingMessages = () => {
							if (
								this.getNumberOfChannelActiveMessages(chan.id) === 0 &&
								chan.messageLock === false
							) {
								this.logger.debug(
									`Unsubscribing from '${chan.name}' chan with '${chan.group}' group...'`
								);

								return Promise.resolve()
									.then(() => {
										// Unsubscribed. Delete the client and release the memory
										this.clients.delete(chan.id);

										// Stop tracking channel's active messages
										this.stopChannelActiveMessages(chan.id);
									})
									.then(() => {
										const pubClient = this.clients.get(this.pubName);
										// 1. Delete consumer from the consumer group
										// 2. Do NOT destroy the consumer group
										// https://redis.io/commands/XGROUP
										return pubClient.xgroup(
											"DELCONSUMER",
											chan.name, // Stream Name
											chan.group, // Consumer Group
											chan.id // Consumer ID
										);
									})
									.then(() => resolve())
									.catch(err => reject(err));
							} else {
								this.logger.warn(
									`Processing ${this.getNumberOfChannelActiveMessages(
										chan.id
									)} message(s) of ${chan.id}...`
								);

								setTimeout(checkPendingMessages, 100);
							}
						};

						setImmediate(checkPendingMessages);
					});
				})
		);
	}

	/**
	 * Publish a payload to a channel.
	 * @param {String} channelName
	 * @param {any} payload
	 * @param {Object?} opts
	 */
	async publish(channelName, payload, opts = {}) {
		// Adapter is stopping. Publishing no longer is allowed
		if (this.stopping) return;

		this.logger.debug(`Publish a message to '${channelName}' channel...`, payload, opts);

		const clientPub = this.clients.get(this.pubName);

		try {
			// https://redis.io/commands/XADD
			const id = await clientPub.xadd(
				channelName, // Stream name
				"*", // Auto ID
				"payload", // Entry
				this.serializer.serialize(payload) // Actual payload
			);
			this.logger.debug(`Message ${id} was published at '${channelName}'`);
		} catch (error) {
			this.logger.error(`Cannot publish to '${channelName}'`, error);
		}
	}
}

module.exports = RedisAdapter;
