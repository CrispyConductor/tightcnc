const XError = require('xerror');
const objtools = require('objtools');
const LoggerDisk = require('./logger-disk');
const LoggerMem = require('./logger-mem');
const mkdirp = require('mkdirp');
const GcodeProcessor = require('../../lib/gcode-processor');
const zstreams = require('zstreams');
const EventEmitter = require('events');

/**
 * This is the central class for the application server.  Operations, gcode processors, and controllers
 * are registered here.
 *
 * @class TightCNCServer
 */
class TightCNCServer extends EventEmitter {

	/**
	 * Class constructor.
	 *
	 * @constructor
	 * @param {Object} config
	 */
	constructor(config = null) {
		if (!config) {
			config = require('littleconf').getConfig();
		}
		this.config = config;

		this.controllerClasses = {};
		this.controller = null;

		this.operations = {};

		this.gcodeProcessors = {};

		// Register builtin modules
		this.registerController('TinyG', require('./tinyg-controller'));
		require('./basic-operations')(this);
		require('./file-operations')(this);
		this.registerGcodeProcessor('gcodevm', require('../../lib/gcode-processors/gcode-vm'));
	}

	/**
	 * Initialize class.  To be called after everything's registered.
	 *
	 * @method initServer
	 */
	async initServer() {
		// Whether to suppress duplicate error messages from being output sequentially
		const suppressDuplicateErrors = this.config.suppressDuplicateErrors === undefined ? true : this.config.suppressDuplicateErrors;

		// Create data directory if it doesn't exist
		await new Promise((resolve, reject) => {
			mkdirp(this.config.dataDir, (err) => {
				if (err) reject(err);
				else resolve();
			});
		});

		// Initialize the disk and in-memory communications loggers
		this.loggerDisk = new LoggerDisk(this.config.logger);
		await this.loggerDisk.init();
		this.loggerMem = new LoggerMem(this.config.loggerMem || {});
		this.loggerMem.log('other', 'Server started.');
		this.loggerDisk.log('other', 'Server started.');

		// Set up the controller
		if (this.config.controller) {
			let controllerClass = this.controllerClasses[this.config.controller];
			let controllerConfig = this.config.controllers[this.config.controller];
			this.controller = new controllerClass(controllerConfig);
			let lastError = null; // used to suppress duplicate error messages on repeated connection retries
			this.controller.on('error', (err) => {
				let errrep = err.toObject ? err.toObject() : err.toString;
				if (objtools.deepEquals(errrep, lastError) && suppressDuplicateErrors) return;
				lastError = errrep;
				console.error('Controller error: ', err);
				if (err.toObject) console.error(err.toObject());
				if (err.stack) console.error(err.stack);
			});
			this.controller.on('ready', () => {
				lastError = null;
				console.log('Controller ready.');
			});
			this.controller.on('sent', (line) => {
				this.loggerMem.log('send', line);
				this.loggerDisk.log('send', line);
			});
			this.controller.on('received', (line) => {
				this.loggerMem.log('receive', line);
				this.loggerDisk.log('receive', line);
			});
			this.controller.initConnection(true);
		} else {
			console.log('WARNING: Initializing without a controller enabled.  For testing only.');
			this.controller = {};
		}

		// Initialize operations
		for (let opname in this.operations) {
			await this.operations[opname].init();
		}
	}

	registerController(name, cls) {
		this.controllerClasses[name] = cls;
	}

	registerOperation(name, cls) {
		this.operations[name] = new cls(this, this.config.operations[name] || {});
	}

	registerGcodeProcessor(name, cls) {
		this.gcodeProcessors[name] = cls;
	}

	async runOperation(opname, params) {
		if (!(opname in this.operations)) {
			throw new XError(XError.NOT_FOUND, 'No such operation: ' + opname);
		}
		return await this.operations[name].run(params);
	}

	/**
	 * Return the current status object.
	 *
	 * @method getStatus
	 * @return {Promise{Object}}
	 */
	async getStatus() {
		let statusObj = {};
		// Fetch controller status
		statusObj.controller = this.controller ? this.controller.getStatus() : {};

		// Fetch job status

		// Emit 'statusRequest' event so other components can modify the status object directly
		this.emit('statusRequest', statusObj);

		// Return status
		return statusObj

	}

	/**
	 * Returns a stream of gcode data that can be piped to a controller.
	 *
	 * @method getGcodeSourceStream
	 * @param {Object} options
	 *   @param {String} options.filename - Filename to read source gcode from.
	 *   @param {String[]} options.data - Array of gcode line strings.  Can be supplied instead of filename.
	 *   @param {Object[]} options.gcodeProcessors - The set of gcode processors to apply, in order, along with
	 *     options for each.  These objects are modified by this function to add the instantiated gcode processor
	 *     instances under the key 'inst'.
	 *     @param {String} options.gcodeProcessors.#.name - Name of gcode processor.
	 *     @param {Object} options.gcodeProcessors.#.options - Additional options to pass to gcode processor constructor.
	 * @return {Promise{ReadableStream}} - A promise that resolves with a readable data stream.  The stream will have
	 *   the additional property 'gcodeProcessorStream' containing an array of all GcodeProcessor's in the chain.
	 */
	async getGcodeSourceStream(options) {
		// Handle case where there are no gcode processors
		if (!options.gcodeProcessors || !options.gcodeProcessors.length) {
			if (options.filename) {
				return zstreams.fromFile(options.filename);
			} else {
				return zstreams.fromString(options.data.join('\n') + '\n');
			}
		}

		// Construct gcode processor chain
		let gcodeProcessorInstances = [];
		for (let gcpspec of (this.options.gcodeProcessors || [])) {
			let cls = this.gcodeProcessors[gcpspec.name];
			if (!cls) throw new XError(XError.NOT_FOUND, 'Gcode processor not found: ' + gcpspec.name);
			let inst = new cls(gcpspec.options || []);
			gcpspec.inst = inst;
			gcodeProcessorInstances.push(inst);
		}
		return await GcodeProcessor.buildProcessorChain(options.filename || options.data, gcodeProcessorInstances);
	}

}

module.exports = TightCNCServer;

