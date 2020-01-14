const XError = require('xerror');
const GcodeLine = require('../../lib/gcode-line');
const pasync = require('pasync');
const AsyncFunction = Object.getPrototypeOf(async function(){}).constructor;
const fs = require('fs');
const path = require('path');
const zstreams = require('zstreams');
const objtools = require('objtools');
const { createSchema } = require('common-schema');

class Macros {

	constructor(tightcnc) {
		this.tightcnc = tightcnc;
		this.macroCache = {};
	}

	async initMacros() {
		// Load macro cache and start cache refresh loop
		await this._loadMacroCache();
		setInterval(() => {
			this._updateMacroCache()
				.catch((err) => {
					console.error('Error updating macro cache', err);
				});
		}, 10000);
	}

	async listAllMacros() {
		let ret = [];
		for (let key in this.macroCache) {
			ret.push({
				name: key,
				params: this.macroCache[key].metadata && this.macroCache[key].metadata.params
			});
		}
		return ret;
	}

	getMacroParams(name) {
		if (!this.macroCache[name]) throw new XError(XError.NOT_FOUND, 'Macro ' + name + ' not found');
		let metadata = this.macroCache[name].metadata;
		if (!metadata) return null;
		if (!metadata.params && !metadata.mergeParams) return null;
		let params = objtools.deepCopy(metadata.params || {});
		if (metadata.mergeParams) {
			let otherMacros = metadata.mergeParams;
			if (!Array.isArray(otherMacros)) otherMacros = [ otherMacros ];
			this._mergeParams(params, ...otherMacros);
		}
		return params;
	}

	async _loadMacroCache() {
		let newMacroCache = {};
		let fileObjs = await this._listMacroFiles();
		for (let fo of fileObjs) {
			try {
				fo.metadata = await this._loadMacroMetadata(await this._readFile(fo.absPath));
			} catch (err) {
				console.error('Error loading macro metadata', fo.name, err);
			}
			newMacroCache[fo.name] = fo;
		}
		this.macroCache = newMacroCache;
	}

	async _updateMacroCache() {
		let fileObjs = await this._listMacroFiles();
		let fileObjMap = {};
		for (let fo of fileObjs) fileObjMap[fo.name] = fo;

		// Delete anything from the cache that doesn't exist in the new listing
		for (let key in this.macroCache) {
			if (!(key in fileObjMap)) delete this.macroCache[key];
		}

		// For each macro file, if it has been updated (or is new) since the cache load, reload it
		for (let key in fileObjMap) {
			if (!(key in this.macroCache) || fileObjMap[key].stat.mtime.getTime() > this.macroCache[key].stat.mtime.getTime()) {
				try {
					fileObjMap[key].metadata = await this._loadMacroMetadata(await this._readFile(fileObjMap[key].absPath));
				} catch (err) {
					console.error('Error loading macro metadata', key, err);
				}
				this.macroCache[key] = fileObjMap[key];
			}
		}
	}

	async _updateMacroCacheOne(macroName) {
		if (!(macroName in this.macroCache)) {
			await this._updateMacroCache();
			return;
		}
		let fo = this.macroCache[macroName];
		let stat = await new Promise((resolve, reject) => {
			fs.stat(fo.absPath, (err, stat) => {
				if (err) reject(err);
				else resolve(stat);
			});
		});
		if (stat.mtime.getTime() > fo.stat.mtime.getTime()) {
			try {
				fo.stat = stat;
				fo.metadata = await this._loadMacroMetadata(await this._readFile(fo.absPath));
			} catch (err) {
				console.error('Error loading macro metadata', macroName, err);
			}
		}
	}

	async _listMacroFiles() {
		// later directories in this list take precedence in case of duplicate names
		let dirs = [ path.join(__dirname, 'macro'), this.tightcnc.getFilename(null, 'macro', false, true, true) ];
		let ret = [];
		for (let dir of dirs) {
			try {
				let files = await new Promise((resolve, reject) => {
					fs.readdir(dir, (err, files) => {
						if (err) reject(err);
						else resolve(files);
					});
				});
				for (let file of files) {
					if (/\.js$/.test(file)) {
						try {
							let absPath = path.resolve(dir, file);
							let stat = await new Promise((resolve, reject) => {
								fs.stat(absPath, (err, stat) => {
									if (err) reject(err);
									else resolve(stat);
								});
							});
							ret.push({
								name: file.slice(0, -3),
								absPath: absPath,
								stat: stat
							});
						} catch (err) {
							console.error('Error stat-ing macro file ' + absPath, err);
						}
					}
				}
			} catch (err) {}
		}
		return ret;
	}

	async _loadMacroMetadata(code) {
		/* Macro metadata (parameters) is specified inside the macro file itself.  It looks like this:
		 * macroMeta({ value: 'number', pos: [ 'number' ] })
		 * The parameter to macroMeta is a commonSchema-style object specifying the macro parameters.
		 * When running the macro, this function is a no-op and does nothing.  When extracting the
		 * metadata, the macro is run, and the function throws an exception (which is then caught here).
		 * When retrieving metadata, no other macro environment functions are available.  The macroMeta
		 * function should be the first code executed.
		 */

		// Detect if there's a call to macroMeta
		let hasMacroMeta = false;
		for (let line of code.split(/\r?\n/g)) {
			if (/^\s*macroMeta\s*\(/.test(line)) {
				hasMacroMeta = true;
				break;
			}
		}
		if (!hasMacroMeta) return null;

		// Construct the function to call and the macroMeta function
		let fn = new AsyncFunction('tightcnc', 'macroMeta', code);
		const macroMeta = (metadata) => {
			throw { metadata, isMacroMetadata: true };
		};

		// Run the macro and trap the exception containing metadata
		let gotMacroMetadata = null;
		try {
			await fn(this.tightcnc, macroMeta);
			throw new XError(XError.INTERNAL_ERROR, 'Expected call to macroMeta() in macro');
		} catch (err) {
			if (err && err.isMacroMetadata) {
				gotMacroMetadata = err.metadata;
			} else {
				throw new XError(XError.INTERNAL_ERROR, 'Error getting macro metadata', err);
			}
		}
		if (!gotMacroMetadata) return null;

		// Return the metadata
		let metadata = gotMacroMetadata;
		if (metadata.params) {
			metadata.params = createSchema(metadata.params).getData();
		}
		return metadata;
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

	_mergeParams(ourParams, ...otherMacroNames) {
		for (let name of otherMacroNames) {
			let otherParams = this.getMacroParams(name);
			if (otherParams) {
				for (let key in otherParams) {
					if (!(key in ourParams)) {
						ourParams[key] = objtools.deepCopy(otherParams[key]);
					}
				}
			}
		}
		return ourParams;
	}

	async _makeMacroEnv(code, params, options) {
		let env;
		env = {
			// push gcode function available inside macro.  In gcode processor, pushes onto the gcode processor stream.
			// Otherwise, sends to controller.  Tracks if the most recent sent line is executed for syncing.
			push: (gline) => {
				if (typeof gline === 'string') gline = new GcodeLine(gline);
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
				if (options.gcodeProcessor) {
					await options.gcodeProcessor.flushDownstreamProcessorChain();
				}
				await this.tightcnc.controller.waitSync();
			},

			// Runs a named operation
			op: async(name, params) => {
				return await this.tightcnc.runOperation(name, params);
			},

			runMacro: async(macro, params = {}) => {
				await this.runMacro(macro, params, options);
			},

			input: async(prompt, schema) => {
				await env.sync();
				return await this.tightcnc.requestInput(prompt, schema);
			},

			message: (msg) => {
				this.tightcnc.message(msg);
			},

			tightcnc: this.tightcnc,
			gcodeProcessor: options.gcodeProcessor,
			controller: this.tightcnc.controller,
			axisLabels: this.tightcnc.controller.axisLabels,

			macroMeta: () => {} // this function is a no-op in normal operation
		};
		let meta = await this._loadMacroMetadata(code);
		let schema = meta && meta.params;
		let pkeys;
		if (schema && schema.type === 'object' && schema.properties) {
			pkeys = Object.keys(schema.properties);
		} else {
			pkeys = Object.keys(params);
		}
		for (let key of pkeys) {
			if (!(key in env)) {
				let value = this._prepMacroParam(params[key], key, env);
				params[key] = value;
				env[key] = value;
			}
		}
		env.allparams = params;
		return env;
	}

	async runJS(code, params = {}, options = {}) {
		if (options.waitSync) code += '\n;await sync();';
		let env = await this._makeMacroEnv(code, params, options);
		let envKeys = Object.keys(env);
		let fnCtorArgs = envKeys.concat([ code ]);
		let fn = new AsyncFunction(...fnCtorArgs);
		let fnArgs = [];
		for (let key of envKeys) {
			fnArgs.push(env[key]);
		}
		return await fn(...fnArgs);
	}

	_readFile(filename) {
		return new Promise((resolve, reject) => {
			fs.readFile(filename, { encoding: 'utf8' }, (err, data) => {
				if (err) {
					if (err && err.code === 'ENOENT') {
						reject(new XError(XError.NOT_FOUND, 'File not found'));
					} else {
						reject(err);
					}
				} else {
					resolve(data);
				}
			});
		});
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
	 * - axisLabels - An array of axis labels corresponding to position arrays
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
			if (macro.indexOf('..') !== -1 || path.isAbsolute(macro)) throw new XError(XError.INVALID_ARGUMENT, '.. is not allowed in macro names');
			// Get the macro metadata
			await this._updateMacroCacheOne(macro);
			if (!this.macroCache[macro]) throw new XError(XError.NOT_FOUND, 'Macro ' + macro + ' not found');
			// Normalize the params
			let paramsSchema = this.getMacroParams(macro);
			if (paramsSchema) {
				createSchema(paramsSchema).normalize(params, { removeUnknownFields: true });
			}
			// Load the macro code
			let code = await this._readFile(this.macroCache[macro].absPath);
			if (!code) throw new XError(XError.NOT_FOUND, 'Macro ' + macro + ' not found');
			// Run the macro
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

	generatorMacroStream(macro, params) {
		return new MacroGcodeSourceStream(this, macro, params);
	}

}






class MacroGcodeSourceStream extends zstreams.Readable {

	constructor(macros, macro, macroParams) {
		super({ objectMode: true });
		this.pushReadWaiter = null;
	
		let gotChainError = false;
		this.on('chainerror', (err) => {
			gotChainError = true;
			if (this.pushReadWaiter) {
				this.pushReadWaiter.reject(err);
				this.pushReadWaiter = null;
			}
		});

		macros.runMacro(macro, macroParams, {
			push: async (gline) => {
				let r = this.push(gline);
				if (!r) {
					// wait until _read is called
					if (!this.pushReadWaiter) {
						this.pushReadWaiter = pasync.waiter();
					}
					await this.pushReadWaiter.promise;
				}
			},
			sync: async() => {
				throw new XError(XError.UNSUPPORTED_OPERATION, 'sync() not supported in generator macros');
			}

		})
			.then(() => {
				this.push(null);
			})
			.catch((err) => {
				if (!gotChainError) {
					this.emit('error', new XError(XError.INTERNAL_ERROR, 'Error running generator macro', err));
				}
			});
	}

	_read() {
		if (this.pushReadWaiter) {
			this.pushReadWaiter.resolve();
			this.pushReadWaiter = null;
		}
	}

}



module.exports = Macros;

