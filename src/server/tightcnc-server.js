const XError = require('xerror');
const objtools = require('objtools');
const LoggerDisk = require('./logger-disk');
const LoggerMem = require('./logger-mem');
const mkdirp = require('mkdirp');
const GcodeProcessor = require('../../lib/gcode-processor');
const zstreams = require('zstreams');
const EventEmitter = require('events');
const path = require('path');
const JobManager = require('./job-manager');

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
		super();

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
		require('./job-operations')(this);
		this.registerGcodeProcessor('gcodevm', require('../../lib/gcode-processors/gcode-vm'));

		// Register bundled plugins
		require('../plugins').registerServerComponents(this);

		// Register external plugins
		for (let plugin of (this.config.plugins || [])) {
			let p = require(plugin);
			if (p.registerServerComponents) {
				require(plugin).registerServerComponents(this);
			}
		}
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

		// Set up the job manager
		this.jobManager = new JobManager(this);
		await this.jobManager.initialize();

		// Initialize operations
		for (let opname in this.operations) {
			await this.operations[opname].init();
		}
	}

	validateDataFilename(filename, convertToAbsolute = false) {
		if (path.isAbsolute(filename)) throw new XError(XError.INVALID_ARGUMENT, 'Only files in the data directory may be used');
		if (filename.split(path.sep).indexOf('..') !== -1) throw new XError(XError.INVALID_ARGUMENT, 'Only files in the data directory may be used');
		if (convertToAbsolute) return path.resolve(this.config.dataDir, filename);
		return filename;
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
		try {
			return await this.operations[opname].run(params);
		} catch (err) {
			console.error('Error running operation ' + opname);
			console.error(err);
			if (err.stack) console.error(err.stack);
			throw err;
		}
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
		statusObj.job = this.jobManager ? this.jobManager.getStatus() : undefined;

		// Emit 'statusRequest' event so other components can modify the status object directly
		this.emit('statusRequest', statusObj);

		// Return status
		return statusObj;
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
	 *     instances under the key 'inst' (unless the 'inst' key already exists, in which case it is used).
	 *     @param {String} options.gcodeProcessors.#.name - Name of gcode processor.
	 *     @param {Object} options.gcodeProcessors.#.options - Additional options to pass to gcode processor constructor.
	 *   @param {Boolean} options.rawStrings=false - If true, the stream returns strings (lines) instead of GcodeLine instances.
	 *   @param {Boolean} options.dryRun=false - If true, sets dryRun flag on gcode processors.
	 * @return {Promise{ReadableStream}} - A promise that resolves with a readable object stream of GcodeLine instances.  The stream will have
	 *   the additional property 'gcodeProcessorStream' containing an array of all GcodeProcessor's in the chain.
	 */
	async getGcodeSourceStream(options) {
		// Handle case where returning raw strings
		if (options.rawStrings) {
			if (options.filename) {
				let filename = options.filename;
				if (!path.isAbsolute(filename)) filename = path.join(this.config.dataDir, filename);
				return zstreams.fromFile(filename).pipe(new zstreams.SplitStream());
			} else {
				return zstreams.fromArray(options.data);
			}
		}

		// Construct gcode processor chain
		let gcodeProcessorInstances = [];
		for (let gcpspec of (options.gcodeProcessors || [])) {
			if (gcpspec.inst) {
				if (options.dryRun) gcpspec.inst.dryRun = true;
				gcodeProcessorInstances.push(gcpspec.inst);
			} else {
				let cls = this.gcodeProcessors[gcpspec.name];
				if (!cls) throw new XError(XError.NOT_FOUND, 'Gcode processor not found: ' + gcpspec.name);
				let opts = objtools.deepCopy(gcpspec.options || {});
				opts.tightcnc = this;
				let inst = new cls(opts);
				if (options.dryRun) inst.dryRun = true;
				gcpspec.inst = inst;
				gcodeProcessorInstances.push(inst);
			}
		}
		return await GcodeProcessor.buildProcessorChain(options.filename || options.data, gcodeProcessorInstances, false);
	}

}

module.exports = TightCNCServer;

