const XError = require('xerror');
const GcodeLine = require('../../lib/gcode-line');
const pasync = require('pasync');
const AsyncFunction = Object.getPrototypeOf(async function(){}).constructor;
const fs = require('fs');

class Macros {

	constructor(tightcnc) {
		this.tightcnc = tightcnc;
	}

	_prepMacroParam(value, key, env) {
		let axisLabels = this.tightcnc.controller.axisLabels;
		// allow things that look like coordinate arrays to be accessed by their axis letters
		if (Array.isArray(value) && (value.length <= axisLabels.length || value.length < 6)) {
			let axisLabels = this.tightcnc.controller.axisLabels;
			for (let axisNum = 0; axisNum < value.length && axisNum < axisLabels.length; axisNum++) {
				let axis = axisLabels[axisNum].toLowerCase();
				value[axis] = value[axisNum];
				value[axis.toUpperCase()] = value[axisNum];
				if (key === 'pos' && env && !(axis in env) && !(axis.toUpperCase() in env)) {
					env[axis] = value[axisNum];
					env[axis.toUpperCase()] = value[axisNum];
				}
			}
		}
		return value;
	}

	_makeMacroEnv(params, options) {
		let mostRecentSentGline = null;
		let mostRecentSentGlineExecuted = true;
		let mostRecentSentGlineError = null;
		let mostRecentSentGlineWaiter = null;
		let env = {
			// push gcode function available inside macro.  In gcode processor, pushes onto the gcode processor stream.
			// Otherwise, sends to controller.  Tracks if the most recent sent line is executed for syncing.
			push: (gline) => {
				if (typeof gline === 'string') gline = new GcodeLine(gline);
				mostRecentSentGline = gline;
				mostRecentSentGlineExecuted = false;
				mostRecentSentGlineError = null;
				let waiter = pasync.waiter();
				mostRecentSentGlineWaiter = waiter;
				gline.hookSync('executed', () => {
					if (mostRecentSentGline === gline) {
						mostRecentSentGlineExecuted = true;
						waiter.resolve();
					}
				});
				gline.hookSync('error', (err) => {
					if (mostRecentSentGline === gline) {
						mostRecentSentGlineError = err;
						waiter.reject(err);
					}
				});
				if (options.push) {
					options.push(gline);
				} else if (options.gcodeProcessor) {
					options.gcodeProcessor.pushGcode(gline);
				} else {
					this.tightcnc.controller.sendGcode(gline);
				}
			},

			// Waits until all sent gcode has been executed and machine is stopped
			sync: async() => {
				if (options.sync) return await options.sync();
				if (!mostRecentSentGlineExecuted) {
					await mostRecentSentGlineWaiter.promise;
				}
				await this.tightcnc.controller.waitSync();
			},

			// Runs a named operation
			op: async(name, params) => {
				return await this.tightcnc.runOperation(name, params);
			},

			tightcnc: this.tightcnc,
			gcodeProcessor: options.gcodeProcessor,
			controller: this.tightcnc.controller
		};
		for (let key in params) {
			if (!(key in env)) {
				let value = this._prepMacroParam(params[key]);
				params[key] = value;
				env[key] = value;
			}
		}
		return env;
	}

	async runJS(code, params = {}, options = {}) {
		if (options.waitSync) code += '\n;sync();';
		let env = this._makeMacroEnv(params, options);
		let envKeys = Object.keys(env);
		let fnCtorArgs = envKeys.concat([ code ]);
		let fn = new AsyncFunction(...fnCtorArgs);
		let fnArgs = [];
		for (let key of envKeys) {
			fnArgs.push(env[key]);
		}
		return await fn(...fnArgs);
	}

	/**
	 * Run a macro in any of the macro formats.
	 *
	 * Macros are just javascript code that is executed in an environment with a few easy-to-access
	 * functions and variables.  They run in a trusted context and only trusted macros should be run.
	 *
	 * The macro can be one of:
	 * - A string, which maps to a file in the macro directory.  '.js' is automatically appended to the name.
	 * - A string containing a semicolon, which is treated directly as javascript code.
	 * - An array of string gcode lines.  These string gcode lines can contain substitutions as in JS backtick ``
	 *   substitution.
	 *
	 * Macros run in a context with the following functions/variables available:
	 * - tightcnc - The tightcnc instance
	 * - controller - Alias for tightcnc.controller
	 * - gcodeProcessor - The GcodeProcessor, if running within a GcodeProcessor context
	 * - push(gline) - Send out a gcode line, either as a GcodeLine instance or a string (which is parsed).  If running
	 *   in a GcodeProcessor context, this pushes onto the output stream.  Otherwise, the line is sent directly to
	 *   the controller.
	 * - sync() - Wait for all sent gcode lines to be executed.  Returns a Promise.  Use it as 'await sync();' - macros
	 *   can use 'await'.
	 * - op(name, params) - Runs a named tightcnc operation.  Returns a promise.
	 * 
	 * All axis-array positions passed as parameters are detected (as numeric arrays of short length) as coordinates
	 * and are assigned properties corresponding to the axis labels (ie, pos.x, pos.y, etc).  Additionally, if there is
	 * a parameter named simply 'pos', the axis letters are exposed directly as variables in the macro context.
	 *
	 * @method runMacro
	 * @param {String|String[]} macro
	 * @param {Object} params - Any parameters to pass as variables to the macro.
	 * @param {Object} options - Options for macro execution.
	 *   @param {GcodeProcessor} options.gcodeProcessor - Provide this if running in the context of a gcode processor.  This provides
	 *     the gcode processor in the environment of the macro and also causes the push() method to push onto the gcode processor's
	 *     output stream instead of being directly executed on the controller.
	 *   @param {Function} options.push - Provide a function for handling pushing gcode lines.
	 */
	async runMacro(macro, params = {}, options = {}) {
		if (typeof macro === 'string' && macro.indexOf(';') !== -1) {
			// A javascript string blob
			return await this.runJS(macro, params, options);
		} else if (typeof macro === 'string') {
			// A filename to a javascript file
			let filename = this.tightcnc.getFilename(macro + '.js', 'macro', false);
			let code = await new Promise((resolve, reject) => {
				fs.readFile(filename, { encoding: 'utf8' }, (err, data) => {
					if (err) reject(err);
					else resolve(data);
				});
			});
			return await this.runJS(code, params, options);
		} else if (Array.isArray(macro) && typeof macro[0] === 'string') {
			// An array of strings with substitutions
			let code = '';
			for (let str of macro) {
				code += 'push(`' + str + '`);\n';
			}
			return await this.runJS(code, params, options);
		} else {
			throw new XError(XError.INVALID_ARGUMENT, 'Unknown macro type');
		}
	}

}

module.exports = Macros;

