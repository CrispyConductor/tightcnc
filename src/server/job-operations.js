const Operation = require('./operation');
const fs = require('fs');
const path = require('path');
const objtools = require('objtools');


const jobOptionsSchema = {
	filename: { type: String, required: true, description: 'Filename of gcode to run' },
	rawFile: { type: Boolean, default: false, description: 'Do not process the gcode in the file at all.  Also disables stats.' },
	gcodeProcessors: [
		{
			name: { type: String, description: 'Name of gcode processor' },
			options: { type: 'mixed', description: 'Options to pass to the gcode processor' }
		}
	]
};



class OpStartJob extends Operation {
	getParamSchema() {
		return jobOptionsSchema;
	}
	async run(params) {
		let jobOptions = {
			filename: this.tightcnc.getFilename(params.filename, 'data'),
			gcodeProcessors: params.gcodeProcessors,
			rawFile: params.rawFile
		};
		return await this.tightcnc.jobManager.startJob(jobOptions);
	}
}

class OpJobDryRun extends Operation {
	getParamSchema() {
		return objtools.merge({}, jobOptionsSchema, {
			outputFilename: { type: String, description: 'Save processed gcode from dry run into this file' }
		});
	}
	async run(params) {
		let jobOptions = {
			filename: this.tightcnc.getFilename(params.filename, 'data'),
			gcodeProcessors: params.gcodeProcessors,
			rawFile: params.rawFile
		};
		return await this.tightcnc.jobManager.dryRunJob(jobOptions, params.outputFilename ? this.tightcnc.getFilename(params.outputFilename, 'data') : null);
	}
}


function registerOperations(tightcnc) {
	tightcnc.registerOperation('startJob', OpStartJob);
	tightcnc.registerOperation('jobDryRun', OpJobDryRun);
}

module.exports = registerOperations;


