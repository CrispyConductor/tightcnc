const XError = require('xerror');
const objtools = require('objtools');
const LoggerDisk = require('./logger-disk');
const LoggerMem = require('./logger-mem');
const mkdirp = require('mkdirp');
const GcodeProcessor = require('../../lib/gcode-processor');
const GcodeLine = require('../../lib/gcode-line');
const zstreams = require('zstreams');
const EventEmitter = require('events');
const path = require('path');
const fs = require('fs');
const JobManager = require('./job-manager');
const stable = require('stable');
const Macros = require('./macros');

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
		this.baseDir = this.config.baseDir;

		this.macros = new Macros(this);

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

		// Create directories if missing
		this.getFilename(null, 'data', true, true, true);
		this.getFilename(null, 'macro', true, true, true);

		// Initialize the disk and in-memory communications loggers
		this.loggerDisk = new LoggerDisk(this.config.logger, this);
		await this.loggerDisk.init();
		this.loggerMem = new LoggerMem(this.config.loggerMem || {});
		this.loggerMem.log('other', 'Server started.');
		this.loggerDisk.log('other', 'Server started.');

		// Set up the controller
		if (this.config.controller) {
			let controllerClass = this.controllerClasses[this.config.controller];
			let controllerConfig = this.config.controllers[this.config.controller];
			this.controller = new controllerClass(controllerConfig);
			this.controller.tightcnc = this;
			let lastError = null; // used to suppress duplicate error messages on repeated connection retries
			this.controller.on('error', (err) => {
				let errrep = JSON.stringify(err.toObject ? err.toObject() : err.toString) + err;
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

	debug(str) {
		if (!this.config.enableDebug) return;
		if (this.config.debugToStdout) {
			console.log('Debug: ' + str);
		}
		if (this.loggerDisk) {
			this.loggerDisk.log('other', 'Debug: ' + str);
		}
	}

	getFilename(name, place = null, allowAbsolute = false, createParentsIfMissing = false, createAsDirIfMissing = false) {
		if (name && path.isAbsolute(name) && !allowAbsolute) throw new XError(XError.INVALID_ARGUMENT, 'Absolute paths not allowed');
		if (name && name.split(path.sep).indexOf('..') !== -1 && !allowAbsolute) throw new XError(XError.INVALID_ARGUMENT, 'May not ascend directories');
		let base = this.baseDir;
		if (place) {
			let placePath = this.config.paths[place];
			if (!placePath) throw new XError(XError.INVALID_ARGUMENT, 'No such place ' + place);
			base = path.resolve(base, placePath);
		}
		if (name) {
			base = path.resolve(base, name);
		}
		let absPath = base;
		if (createParentsIfMissing) {
			mkdirp.sync(path.dirname(absPath));
		}
		if (createAsDirIfMissing) {
			if (!fs.existsSync(absPath)) {
				fs.mkdirSync(absPath);
			}
		}
		return absPath;
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
	 *     @param {Number} [options.gcodeProcessors.#.order] - Optional order number.  Gcode processors with associated order numbers
	 *       are reordered according to the numbers.
	 *   @param {Boolean} options.rawStrings=false - If true, the stream returns strings (lines) instead of GcodeLine instances.
	 *   @param {Boolean} options.dryRun=false - If true, sets dryRun flag on gcode processors.
	 *   @param {JobState} options.job - Optional job object associated.
	 * @return {ReadableStream} - a readable object stream of GcodeLine instances.  The stream will have
	 *   the additional property 'gcodeProcessorChain' containing an array of all GcodeProcessor's in the chain.  This property
	 *   is only available once the 'processorChainReady' event is fired on the returned stream;
	 */
	getGcodeSourceStream(options) {
		// Handle case where returning raw strings
		if (options.rawStrings) {
			if (options.filename) {
				let filename = options.filename;
				filename = this.getFilename(filename, 'data', true);
				return zstreams.fromFile(filename).pipe(new zstreams.SplitStream());
			} else {
				return zstreams.fromArray(options.data);
			}
		}

		// Sort gcode processors
		let sortedGcodeProcessors = stable(options.gcodeProcessors || [], (a, b) => {
			let aorder = ('order' in a) ? a.order : 0;
			let border = ('order' in b) ? b.order : 0;
			if (aorder > border) return 1;
			if (aorder < border) return -1;
			return 0;
		});

		// Construct gcode processor chain
		let gcodeProcessorInstances = [];
		for (let gcpspec of sortedGcodeProcessors) {
			if (gcpspec.inst) {
				if (options.dryRun) gcpspec.inst.dryRun = true;
				gcodeProcessorInstances.push(gcpspec.inst);
			} else {
				let cls = this.gcodeProcessors[gcpspec.name];
				if (!cls) throw new XError(XError.NOT_FOUND, 'Gcode processor not found: ' + gcpspec.name);
				let opts = objtools.deepCopy(gcpspec.options || {});
				opts.tightcnc = this;
				if (options.job) opts.job = options.job;
				let inst = new cls(opts);
				if (options.dryRun) inst.dryRun = true;
				gcpspec.inst = inst;
				gcodeProcessorInstances.push(inst);
			}
		}
		return GcodeProcessor.buildProcessorChain(options.filename || options.data, gcodeProcessorInstances, false);
	}

	async runMacro(macro, params = {}, options = {}) {
		return await this.macros.runMacro(macro, params, options);
	}

}

module.exports = TightCNCServer;

