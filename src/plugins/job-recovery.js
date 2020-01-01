const XError = require('xerror');
const GcodeProcessor = require('../../lib/gcode-processor');
const GcodeLine = require('../../lib/gcode-line');
const GcodeVM = require('../../lib/gcode-vm');
const objtools = require('objtools');
const pasync = require('pasync');
const fs = require('fs');
const path = require('path');

const getRecoveryFilename = (tightcnc) => {
	return path.resolve(tightcnc.config.dataDir, tightcnc.config.recoveryFile || '_recovery.json');
};

class JobRecoveryTracker extends GcodeProcessor {

	constructor(options = {}) {
		super(options, 'recoverytracker', true);
		this.vm = new GcodeVM(options);
		this.recoverySaveInterval = options.recoverySaveInterval || 10;
		this.hasEnded = false;
		this.saveData = {
			jobOptions: this.job && this.job.jobOptions,
			lineCountOffset: 0,
			predictedTimeOffset: 0
		};
	}

	initProcessor() {
		if (this.dryRun) return;

		const saveLoop = async() => {
			while (!this.hasEnded) {
				await pasync.setTimeout(this.recoverySaveInterval);
				if (this.hasEnded) break;
				let data = JSON.stringify(this.saveData) + '\n';
				await new Promise((resolve, reject) => {
					fs.writeFile(getRecoveryFilename(this.tightcnc), data, (err) => {
						if (err) reject(err);
						else resolve();
					});
				});
			}
		};
		this.job.on('complete', () => {
			this.hasEnded = true;
			fs.unlink(getRecoveryFilename(this.tightcnc), () => {});
		});
		this.on('end', () => {
			this.hasEnded = true;
		});
		this.on('chainerror', () => {
			this.hasEnded = true;
		});
		saveLoop();
	}

	processGcode(gline) {
		if (this.dryRun) return gline; // don't save recovery state during dry runs
		this.vm.runGcodeLine(gline);
		let vmState = objtools.deepCopy(this.vm.getState());
		gline.hookSync('executed', () => {
			this.saveData.jobOptions = this.job && this.job.jobOptions;
			this.saveData.lineCountOffset = this.vm.getState().lineCounter;
			this.saveData.predictedTimeOffset = this.vm.getState().totalTime;
		});
		return gline;
	}

}

module.exports.JobRecoveryTracker = JobRecoveryTracker;
module.exports.registerServerComponents = function (tightcnc) {
	tightcnc.registerGcodeProcessor('recoverytracker', JobRecoveryTracker);
};
module.exports.registerConsoleUIComponents = function (consoleui) {
	consoleui.on('newJobObject', (jobOptions) => {
		if (!jobOptions.gcodeProcessors) jobOptions.gcodeProcessors = [];
		jobOptions.gcodeProcessors.push({
			name: 'recoverytracker',
			options: {}
		});
	});
};

