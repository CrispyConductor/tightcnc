const XError = require('xerror');

/**
 * Base class for an operation that can be performed.  Operations pretty much map
 * one-to-one to API calls.
 *
 * @class Operation
 */
class Operation {

	constructor(opmanager, config) {
		this.opmanager = opmanager;
		this.config = config;
	}

	/**
	 * Initialize the operation.  May return a Promise.
	 *
	 * @method init
	 * @return {Promise|undefined}
	 */
	init() {}

	/**
	 * Run the operation with the given params.
	 *
	 * @method run
	 * @param {Object} params
	 * @return {Mixed}
	 */
	run(params) {}

	/**
	 * Return a common-schema Schema object corresponding to the accepted parameters for the operation.
	 *
	 * @method getParamSchema
	 * @return {Object|Schema}
	 */
	getParamSchema() {}

	checkReady() {
		if (!this.opmanager.controller || !this.opmanager.controller.ready) {
			throw new XError(XError.BAD_REQUEST, 'Controller not ready');
		}
	}

}

module.exports = Operation;

