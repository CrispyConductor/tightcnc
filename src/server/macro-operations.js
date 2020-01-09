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
		let list = await this.tightcnc.macros.listAllMacros();
		list.sort((a, b) => {
			if (a.name < b.name) return -1;
			if (a.name > b.name) return 1;
			return 0;
		});
		return list;
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


