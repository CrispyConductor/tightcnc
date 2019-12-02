const XError = require('xerror');

/**
 * This is the central class for the application server.  Operations, gcode processors, and controllers
 * are registered here.
 *
 * @class OpManager
 */
class OpManager {

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
	}

	/**
	 * Initialize class.  To be called after everything's registered.
	 *
	 * @method init
	 */
	async init() {
		let controllerClass = this.controllerClasses[this.config.controller];
		let controllerConfig = this.config.controllers[this.config.controller];
		this.controller = new controllerClass(controllerConfig);
		await this.controller.initConnection(true);
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

	registerGcodeProcessor(name, cls, dependencies = []) {
	}

	async runOperation(opname, params) {
		if (!(opname in this.operations)) {
			throw new XError(XError.NOT_FOUND, 'No such operation: ' + opname);
		}
		return await this.operations[name].run(params);
	}

}

module.exports = OpManager;

