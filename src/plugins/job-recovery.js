/*
 * This plugin contains facilities for recovering from jobs that are interrupted in the middle.  The general strategy
 * here is track how much of the job has executed (as both line count and predicted time, to enable seeking on both)
 * and periodically save it out to a file.  To recover, a gcode processor skips all lines up to that point (or a little
 * before to account for uncertainties in actual execution times), then starts the job from there.  Additionally,
 * some machine state (spindle, coolant, etc) is tracked with a vm for all prior lines, and the machine is set to that
 * state information prior to resuming.  The maximum G4 pause is also tracked and is sent before resuming to ensure the
 * spindle has time to spin up.
 *
 * Before starting recovery, the spindle is moved into a clearance position, then into a position above the first move
 * in the recovery, before being lowered into position to start the recovery.  There are various configuration options
 * for these clearance movements, including the ability to use different axes.  The default assumes a typical x, y, z
 * axis configuration with clearance on Z at machine position 0 (ie, G53 G0 Z0).
 */

const XError = require('xerror');
const GcodeProcessor = require('../../lib/gcode-processor');
const GcodeLine = require('../../lib/gcode-line');
const GcodeVM = require('../../lib/gcode-vm');
const Operation = require('../server/operation');
const objtools = require('objtools');
const pasync = require('pasync');
const fs = require('fs');
const path = require('path');

const getRecoveryFilename = (tightcnc) => {
	return path.resolve(tightcnc.config.dataDir, tightcnc.config.recoveryFile || '_recovery.json');
};

/**
 * This gcode processor is added to a job to periodically save out job state and enable recovery.  It should be
 * positioned in the processor chain at the end of the chain, with the exception of being before a JobRecoveryProcessor
 * if an existing recovery is in progress.
 *
 * @class JobRecoveryTracker
 */
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
				await pasync.setTimeout(this.recoverySaveInterval * 1000);
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
		let vmState = this.vm.getState();
		let lineCounter = vmState.lineCounter;
		let totalTime = vmState.totalTime;
		gline.hookSync('executed', () => {
			this.saveData.jobOptions = this.job && this.job.jobOptions;
			this.saveData.lineCountOffset = lineCounter;
			this.saveData.predictedTimeOffset = totalTime;
		});
		return gline;
	}

}


/**
 * This gcode processor is used to recovery a job that was interrupted before it could be completed.  It loads the
 * recovery file, then skips past all gcode lines in the job up until the recovery point is reached.  Once the recovery
 * point is reached the machine moves into a clearance position above the recovery point, machine state (eg. spindle state)
 * is synchronized to what it would have been at that point in the job, and a dwell is executed to allow the spindle
 * to spin up.  Then further gcode lines in the job are passed through unaltered.
 *
 * @class JobRecoveryProcessor
 * @constructor
 * @param {Object} options - Gcode processor options.  There are some recovery-specific ones listed here.  All of the
 *   recovery-specific options have defaults defined in the config in the recovery section.
 *   @param {Number} options.backUpTime - Once the recovery point in the job has been reached, additionally "rewind"
 *     this number of seconds.
 *   @param {Number} options.backUpLines - In addition to backing up the backUpTime number of seconds, also back up
 *     this number of gcode lines.  This is useful in cases that the 'executed' hook on gcode lines is not entirely
 *     deterministic, so this adds an additional buffer for safety.
 *   @param {String[]} options.moveToClearance - An array of gcode strings to execute to move the machine into a clearance
 *     position above the recovery position.  The values {x}, {y}, etc. are substituted in the strings for the
 *     coordinates of the job recovery position.
 *   @param {String[]} options.moveToWorkpiece - An array of gcode strings to execute to move the machine from the
 *     clearance position to the position to start recovery.
 */
class JobRecoveryProcessor extends GcodeProcessor {

	constructor(options = {}) {
		super(options, 'recoveryprocessor', true);
		this.vm = new GcodeVM(options);
		this.recoveryConfig = this.tightcnc.config.recovery;
		this.recoveryParams = {
			backUpLines: typeof options.backUpLines === 'number' ? options.backUpLines : this.recoveryConfig.backUpLines,
			backUpTime: typeof options.backUpTime === 'number' ? options.backUpTime : this.recoveryConfig.backUpTime
		};
		this.clearanceParams = {
			moveToClearance: options.moveToClearance || this.recoveryConfig.moveToClearance,
			moveToWorkpiece: options.moveToWorkpiece || this.recoveryConfig.moveToWorkpiece
		};
		this.maxDwell = 0;
		// If true, we've passed the point of skipping lines and are now passing everything through.
		this.startedPassThrough = false;
		// A rotating buffer of backUpLines glines, so we can back up that number of lines after the resume condition is met.
		this.recoveryLineBuffer = [];
	}

	async initProcessor() {
		// Load recovery file
		this.recoveryInfo = await new Promise((resolve, reject) => {
			fs.readFile(getRecoveryFilename(this.tightcnc), { encoding: 'utf8' }, (err, str) => {
				if (err) return reject(err);
				try {
					let j = JSON.parse(str);
					resolve(j);
				} catch (err2) {
					reject(err2);
				}
			});
		});
	}

	async copyProcessor() {
		return super.copyProcessor();
	}

	syncMachineToVMState(vmState) {
		// motion mode
		if (vmState.motionMode) {
			this.pushGcode(new GcodeLine(vmState.motionMode));
		}

		// feed rate
		if (vmState.feed) {
			this.pushGcode(new GcodeLine('F' + vmState.feed));
		}

		// arc plane
		if (typeof vmState.arcPlane === 'number') {
			if (vmState.arcPlane === 0) {
				this.pushGcode(new GcodeLine('G17'));
			} else if (vmState.arcPlane === 1) {
				this.pushGcode(new GcodeLine('G18'));
			} else if (vmState.arcPlane === 2) {
				this.pushGcode(new GcodeLine('G19'));
			}
		}

		// incremental mode
		if (vmState.incremental) {
			this.pushGcode(new GcodeLine('G91'));
		} else {
			this.pushGcode(new GcodeLine('G90'));
		}

		// feed rate mode
		if (vmState.inverseFeed) {
			this.pushGcode(new GcodeLine('G93'));
		} else {
			this.pushGcode(new GcodeLine('G94'));
		}

		// units
		if (vmState.units === 'in') {
			this.pushGcode(new GcodeLine('G20'));
		} else if (vmState.units === 'mm') {
			this.pushGcode(new GcodeLine('G21'));
		}

		// spindle
		if (vmState.spindle) {
			let word = (vmState.spindleDirection === -1) ? 'M4' : 'M3';
			let sword = vmState.spindleSpeed ? (' S' + vmState.spindleSpeed) : '';
			this.pushGcode(new GcodeLine(word + sword));
		} else {
			this.pushGcode(new GcodeLine('M5'));
		}

		// coolant
		if (vmState.coolant === 1 || vmState.coolant === 3) {
			this.pushGcode(new GcodeLine('M7'));
		}
		if (vmState.coolant === 2 || vmState.coolant === 3) {
			this.pushGcode(new GcodeLine('M8'));
		}
		if (!vmState.coolant) {
			this.pushGcode(new GcodeLine('M9'));
		}
	}

	clearanceMoves(moves, params) {
		for (let move of moves) {
			for (let pkey in params) {
				let prex = new RegExp('\\{' + pkey + '\\}', 'ig');
				move = move.replace(prex, '' + params[pkey]);
			}
			this.pushGcode(new GcodeLine(move));
		}
	}

	beginRecovery() {
		let preRecoveryVMState = this.recoveryLineBuffer[0].vmStateBefore;
		let moveParams = {};
		for (let axisNum = 0; axisNum < preRecoveryVMState.pos.length; axisNum++) {
			if (preRecoveryVMState.axisLabels[axisNum]) {
				moveParams[preRecoveryVMState.axisLabels[axisNum]] = preRecoveryVMState.pos[axisNum];
			}
		}

		// Move to clearance position, "above" workpiece
		this.clearanceMoves(this.clearanceParams.moveToClearance, moveParams);

		// Synchronize machine to pre recovery VM state
		this.syncMachineToVMState(preRecoveryVMState);

		// Run dwell
		if (this.maxDwell) {
			this.pushGcode(new GcodeLine('G4 P' + this.maxDwell));
		}

		// Move to starting position
		this.clearanceMoves(this.clearanceParams.moveToWorkpiece, moveParams);

		// Push all the lines in the rotating buffer
		while (this.recoveryLineBuffer.length) {
			let { gline } = this.recoveryLineBuffer.shift();
			this.pushGcode(gline);
		}

		this.startedPassThrough = true;
	}

	processGcode(gline) {
		if (this.startedPassThrough) return gline;
		let vmStateBefore = objtools.deepCopy(this.vm.getState());
		this.vm.runGcodeLine(gline);
		let vmState = this.vm.getState();
		if (gline.has('G4') && gline.has('P') && gline.get('P') > this.maxDwell) {
			this.maxDwell = gline.get('P');
		}

		// rotate the line buffer
		if (this.recoveryParams.backUpLines > 0) {
			this.recoveryLineBuffer.push({
				gline,
				vmStateAfter: objtools.deepCopy(vmState),
				vmStateBefore
			});
			if (this.recoveryLineBuffer.length > this.recoveryParams.backUpLines) {
				this.recoveryLineBuffer.shift();
			}
		}

		// check if this meets the time resume condition
		if (vmState.totalTime >= this.recoveryInfo.predictedTimeOffset) {
			if (!this.recoveryLineBuffer.length) {
				this.recoveryLineBuffer.push({
					gline,
					vmStateAfter: objtools.deepCopy(vmState),
					vmStateBefore: vmStateBefore
				});
			}
			beginRecovery();
		} else {
			// Blackhole the gline by calling all the hooks on it
			gline.triggerSync('queued');
			gline.triggerSync('sent');
			gline.triggerSync('ack');
			gline.triggerSync('executing');
			gline.triggerSync('executed');
		}

		return undefined;
	}

}


/**
 * This operation attempts to recover the most recent interrupted job.
 *
 * @class JobRecoveryOperation
 */
class JobRecoveryOperation extends Operation {

	getParamSchema() {
		return {
			backUpTime: {
				type: 'number',
				description: 'Number of seconds to rewind before restarting the job'
			}
		};
	}

	async run(params) {
		// Load the recovery file (to get the original job options)
		let recoveryInfo = await new Promise((resolve, reject) => {
			fs.readFile(getRecoveryFilename(this.tightcnc), { encoding: 'utf8' }, (err, str) => {
				if (err) return reject(new XError(XError.INTERNAL_ERROR, 'Could not read job recovery file', err));
				try {
					let j = JSON.parse(str);
					resolve(j);
				} catch (err2) {
					reject(err2);
				}
			});
		});

		// Manipulate the gcode processors
		let jobOptions = recoveryInfo.jobOptions;
		if (!jobOptions.gcodeProcessors) jobOptions.gcodeProcessors = [];
		// Remove any existing recovery processors in the gcode processor chain
		jobOptions.gcodeProcessors = jobOptions.gcodeProcessors.filter((gp) => gp.name !== 'recoveryprocessor');
		// Add the recovery processor to the chain immediately after the recovery tracker
		let newprocessor = {
			name: 'recoveryprocessor',
			options: {
				backUpTime: params.backUpTime
			}
		};
		let foundRecoveryTracker = false;
		for (let i = 0; i < jobOptions.gcodeProcessors.length; i++) {
			if (jobOptions.gcodeProcessors[i].name === 'recoverytracker') {
				foundRecoveryTracker = true;
				jobOptions.gcodeProcessors.splice(i + 1, 0, newprocessor);
				break;
			}
		}
		if (!foundRecoveryTracker) jobOptions.gcodeProcessors.push(newprocessor);

		// Start the recovery job
		return await this.tightcnc.jobManager.startJob(jobOptions);
	}

}


module.exports.JobRecoveryTracker = JobRecoveryTracker;
module.exports.JobRecoveryProcessor = JobRecoveryProcessor;
module.exports.JobRecoveryOperation = JobRecoveryOperation;

module.exports.registerServerComponents = function (tightcnc) {
	tightcnc.registerGcodeProcessor('recoverytracker', JobRecoveryTracker);
	tightcnc.registerGcodeProcessor('recoveryprocessor', JobRecoveryProcessor);
	tightcnc.registerOperation('recoverJob', JobRecoveryOperation);
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

