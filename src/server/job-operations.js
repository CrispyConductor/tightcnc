const Operation = require('./operation');
const fs = require('fs');
const path = require('path');
const objtools = require('objtools');


function _checkFile(filename, tightcnc) {
	if (path.isAbsolute(filename)) throw new XError(XError.INVALID_ARGUMENT, 'Only files in the data directory may be used');
	if (filename.split(path.sep).indexOf('..') !== -1) throw new XError(XError.INVALID_ARGUMENT, 'Only files in the data directory may be used');
	return filename;
}

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
		let dir = this.tightcnc.config.dataDir;
		let jobOptions = {
			filename: _checkFile(params.filename, this.tightcnc),
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
		let dir = this.tightcnc.config.dataDir;
		let jobOptions = {
			filename: _checkFile(params.filename, this.tightcnc),
			gcodeProcessors: params.gcodeProcessors,
			rawFile: params.rawFile
		};
		return await this.tightcnc.jobManager.dryRunJob(jobOptions, params.outputFilename ? _checkFile(params.outputFilename, this.tightcnc) : null);
	}
}


function registerOperations(tightcnc) {
	tightcnc.registerOperation('startJob', OpStartJob);
	tightcnc.registerOperation('jobDryRun', OpJobDryRun);
}

module.exports = registerOperations;


