const XError = require('xerror');
const GcodeProcessor = require('../../lib/gcode-processor');
const GcodeLine = require('../../lib/gcode-line');
const GcodeVM = require('../../lib/gcode-vm');
const objtools = require('objtools');
const Operation = require('../server/operation');
const pasync = require('pasync');

class ToolChangeProcessor extends GcodeProcessor {

	constructor(options = {}) {
		super(options, 'toolchange', true);
		this.vm = new GcodeVM(options);
		this.bufferedGcode = null;
		this.lastToolNumber = null;
		this.stopSwitch = options.stopSwitch || false;
		this.handleT = ('handleT' in options) ? options.handleT : true;
		this.handleM6 = ('handleM6' in options) ? options.handleM6 : true;
		this.toolChangeOnT = ('toolChangeOnT' in options) ? options.toolChangeOnT : true;
		this.handleProgramStop = ('handleProgramStop' in options) ? options.handleProgramStop : true;
		this.programStopWaiter = null;
		this.maxDwell = 0;
		this.currentToolOffset = 0;
		this.toolOffsetAxis = this.tightcnc.config.toolChange.toolOffsetAxis;
		this.toolOffsetAxisLetter = this.tightcnc.controller.axisLabels[this.toolOffsetAxis];
		this.currentlyStopped = false;
	}

	getStatus() {
		return {
			stopped: this.currentlyStopped, // false, or string indicating why stopped
			tool: this.lastToolNumber,
			stopSwitch: this.stopSwitch,
			toolOffset: this.currentToolOffset
		};
	}

	resumeFromStop() {
		if (!this.programStopWaiter) throw new XError(XError.INVALID_ARGUMENT, 'Program is not stopped');
		this.programStopWaiter.resolve();
	}

	pushGcode(gline) {
		if (typeof gline === 'string') gline = new GcodeLine(gline);
		// handle tool offset by adjusting Z if present
		if (this.currentToolOffset && gline.has(this.toolOffsetAxisLetter)) {
			// by default use positive tool offsets (ie, a larger tool offset means a longer tool and increased Z height)
			gline.set(this.toolOffsetAxisLetter, gline.get(this.toolOffsetAxisLetter) + this.currentToolOffset * (this.tightcnc.config.toolChange.negateToolOffset ? -1 : 1));
			gline.addComment('to'); // to=tool offset
		}
		super.pushGcode(gline);
		this.vm.runGcodeLine(gline);
		if (this.vm.getState().incremental) throw new XError(XError.INTERNAL_ERROR, 'Incremental mode not supported with tool change');
	}

	async _doToolChange() {
		// create a map from axis letters to current position in job
		let vmState = objtools.deepCopy(this.vm.getState());
		let controller = this.tightcnc.controller;

		// If spindle/coolant on, turn them off
		let changedMachineProp = false;
		if (controller.spindle) {
			changedMachineProp = true;
			this.pushGcode('M5');
		}
		if (controller.coolant) {
			changedMachineProp = true;
			this.pushGcode('M9');
		}
		let origFeed = controller.feed;
		if (changedMachineProp) await controller.waitSync();

		// Run pre-toolchange macro
		let preToolChange = this.tightcnc.config.toolChange.preToolChange;
		await this.tightcnc.runMacro(preToolChange, { pos: vmState.pos }, { gcodeProcessor: this, waitSync: true });

		// Wait for resume
		await this._doProgramStop('tool_change');

		// Run post-toolchange macro
		let postToolChange = this.tightcnc.config.toolChange.postToolChange;
		await this.tightcnc.runMacro(postToolChange, { pos: vmState.pos }, { gcodeProcessor: this, waitSync: true });

		// Restart spindle/coolant
		if (changedMachineProp) {
			let lines = this.vm.syncMachineToState({ vmState: vmState, include: [ 'spindle', 'coolant' ] });
			for (let line of lines) this.pushGcode(line);
			await controller.waitSync();
		}
		if (origFeed) this.pushGcode('F' + origFeed);

		// Add dwell corresponding to longest seen in job
		if (this.maxDwell) this.pushGcode('G4 P' + this.maxDwell);

		// Move to position to restart job
		let moveBackGcode = (vmState.motionMode || 'G0');
		for (let axisNum = 0; axisNum < vmState.pos.length; axisNum++) {
			if (vmState.hasMovedToAxes(axisNum)) {
				moveBackGcode += ' ' + vmState.axisLabels[axisNum].toUpperCase() + vmState.pos[axisNum];
			}
		}
		this.pushGcode(moveBackGcode);
	}

	async _doProgramStop(waitname = 'program_stop') {
		if (this.programStopWaiter) return await this.programStopWaiter.promise;
		this.currentlyStopped = waitname;
		this.job.addWait(waitname);
		this.programStopWaiter = pasync.waiter();
		await this.programStopWaiter.promise;
		this.programStopWaiter = null;
		this.job.removeWait(waitname);
		this.currentlyStopped = false;
	}

	async processGcode(gline) {
		// Track the tool number
		if (gline.has('T')) this.lastToolNumber = gline.get('T');

		// Check if a pause
		if (gline.has('G4') && gline.has('P') && gline.get('P') > this.maxDwell) this.maxDwell = gline.get('P');

		// Determine if this line contains an word that will trigger a program stop
		let isToolChange = (this.handleT && this.toolChangeOnT && gline.has('T')) || (this.handleM6 && gline.has('M6'));
		let isProgramStop = this.handleProgramStop && (gline.has('M0') || gline.has('M60') || (gline.has('M1') && this.stopSwitch));

		// Remove from the gline anything we're handling, and add a comment to it
		if (this.handleT && gline.has('T')) {
			gline.remove('T');
			gline.addComment(this.toolChangeOnT ? 'tool change' : 'tool sel');
		}
		if (this.handleM6 && gline.has('M6')) {
			gline.remove('M6');
			gline.addComment('tool change');
		}
		if (this.handleProgramStop && (gline.has('M0') || gline.has('M1') || gline.has('M60'))) {
			gline.remove('M0');
			gline.remove('M1');
			gline.remove('M60');
			gline.addComment('pgm stop');
		}

		// If this is a dry run, don't do anything further, just return the gcode line without the program-stop-related words
		if (this.dryRun) return gline;

		// Check if this line indicates a program stop we have to handle
		if (isToolChange || isProgramStop) {

			// Attach an executed handler to the buffered line and wait for it to be executed (so we know the prior gcode line has completed)
			if (this.bufferedGcode) {
				await new Promise((resolve, reject) => {
					let bufLine = this.bufferedGcode;
					bufLine.hookSync('executed', () => resolve());
					bufLine.hookSync('error', (err) => reject(err));
					this.pushGcode(bufLine);
					this.bufferedGcode = null;
				});
			}

			// Wait for controller to sync
			await this.tightcnc.controller.waitSync();

			// Handle the operation
			if (isToolChange) await this._doToolChange();
			else if (isProgramStop) await this._doProgramStop();

			// Put this line into the (newly vacated) buffer and resume normal operation
			this.bufferedGcode = gline;

		} else {
			// This is not a line triggering a tool change.  Push out the buffered gcode line and store this one.
			if (this.bufferedGcode) {
				this.pushGcode(this.bufferedGcode);
			}
			this.bufferedGcode = gline;
		}

		return undefined;
	}

	flushGcode() {
		if (this.bufferedGcode) {
			this.pushGcode(this.bufferedGcode);
			this.bufferedGcode = null;
		}
	}

}


function findCurrentJobGcodeProcessor(tightcnc, name, throwOnMissing = true) {
	let currentJob = this.tightcnc.jobManager.currentJob;
	if (!currentJob || currentJob.state === 'cancelled' || currentJob.state === 'error' || currentJob.state === 'complete') {
		throw new XError(XError.INTERNAL_ERROR, 'No currently running job');
	}
	let gcodeProcessors = currentJob.gcodeProcessors || {};
	for (let key in gcodeProcessors) {
		if (gcodeProcessors[key].gcodeProcessorName === name) {
			return gcodeProcessors[key];
		}
	}
	if (throwOnMissing) {
		throw new XError(XError.INTERNAL_ERROR, 'No ' + name + ' gcode processor found');
	} else {
		return null;
	}
}


class ResumeFromStopOperation extends Operation {

	getParamSchema() {
		return {};
	}

	async run(params) {
		findCurrentJobGcodeProcessor(this.tightcnc, 'toolchange').resumeFromStop();
		return { success: true };
	}

}


class SetToolOffsetOperation extends Operation {

	getParamSchema() {
		return {
			toolOffset: {
				type: 'number',
				description: 'Tool offset.  If not supplied, use current Z position.'
			},
			accountForAutolevel: {
				type: 'boolean',
				default: true,
				description: 'If true, and an autolevel processor is enabled for this job, use its surface map to adjust for tool length at the current X,Y position.  (Not used if toolOffset is supplied)'
			}
		};
	}

	async run(params) {
		let toolchange = findCurrentJobGcodeProcessor(this.tightcnc, 'toolchange');
		if (typeof params.toolOffset === 'number') {
			toolchange.currentToolOffset = params.toolOffset;
		} else {
			let controller = this.tightcnc.controller;
			let axisNum = this.tightcnc.config.toolChange.toolOffsetAxis;
			let pos = controller.getPos();
			let off = pos[axisNum];
			if (params.accountForAutolevel) {
				let autolevel = findCurrentJobGcodeProcessor(this.tightcnc, 'autolevel', false);
				if (autolevel && autolevel.surfaceMap && axisNum === 2) {
					let surfaceOffset = autolevel.surfaceMap.predictZ(pos.slice(0, 2));
					if (typeof surfaceOffset === 'number') {
						off -= surfaceOffset;
					}
				}
			}
			toolchange.currentToolOffset = off;
		}
		return { success: true };
	}
}




module.exports.ToolChangeProcessor = ToolChangeProcessor;
module.exports.registerServerComponents = function (tightcnc) {
	tightcnc.registerGcodeProcessor('toolchange', ToolChangeProcessor);
	tightcnc.registerOperation('resumeFromStop', ResumeFromStopOperation);
	tightcnc.registerOperation('setToolOffset', SetToolOffsetOperation);
};

