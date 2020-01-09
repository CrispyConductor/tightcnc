const Operation = require('./operation');
const fs = require('fs');
const path = require('path');
const commonSchema = require('common-schema');
const XError = require('xerror');

class OpListMacros extends Operation {
	getParamSchema() {
		return {};
	}
	async run(params) {
		let dirs = [ this.tightcnc.getFilename(null, 'macro', false, true, true), path.join(__dirname, 'macro') ];
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
						ret.push(file.slice(0, -3));
					}
				}
			} catch (err) {}
		}
		ret.sort();
		return ret;
	}
}

class OpRunMacro extends Operation {

	getParamSchema() {
		return {
			macro: {
				type: 'string',
				required: true,
				description: 'Name of macro to run',
				validate: (val) => {
					if (val.indexOf(';') !== -1) throw new commonSchema.FieldError('invalid', 'Raw javascript not allowed from client');
				}
			},
			params: {
				type: 'mixed',
				default: {}
			},
			waitSync: {
				type: 'boolean',
				default: true,
				description: 'Whether to wait until all pushed gcode runs'
			}
		};
	}

	async run(params) {
		this.checkReady();
		await this.tightcnc.runMacro(params.macro, params.params, { waitSync: params.waitSync });
		return { success: true };
	}

}

function registerOperations(tightcnc) {
	tightcnc.registerOperation('listMacros', OpListMacros);
	tightcnc.registerOperation('runMacro', OpRunMacro);
}

module.exports = registerOperations;


