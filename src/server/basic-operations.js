const Operation = require('./operation');

class OpGetStatus extends Operation {

	async run(params) {
		if (params.sync) {
			await this.opmanager.controller.waitSync();
		}
		let fields = params && params.fields;
		let c = this.opmanager.controller;
		let stat = {
			ready: c.ready,
			axisLabels: c.axisLabels,
			usedAxes: c.usedAxes,
			mpos: c.mpos,
			pos: c.getPos(),
			mposOffset: c.getCoordOffsets(),
			activeCoordSys: c.activeCoordSys,
			offset: c.offset,
			offsetEnabled: c.offsetEnabled,
			storedPositions: c.storedPositions,
			homed: c.homed,
			paused: c.paused,
			units: c.units,
			feed: c.feed,
			incremental: c.incremental,
			moving: c.moving,
			coolant: c.coolant,
			spindle: c.spindle,
			line: c.line,
			error: c.error,
			errorData: c.errorData,
			programRunning: c.programRunning
		};
		if (!fields) return stat;
		let ret = {};
		for (let field of fields) {
			if (field in stat) {
				ret[field] = stat[field];
			}
		}
		return ret;
	}

	getParamSchema() {
		return {
			fields: {
				type: 'array',
				elements: String,
				description: 'List of status fields to return.'
			},
			sync: {
				type: 'boolean',
				default: false,
				description: 'Whether to wait for machine to stop and all commands to be processed before returning status'
			}
		};
	}
}

class OpSend extends Operation {
	getParamSchema() {
		return {
			line: { type: String, required: true, description: 'Line of gcode to send' },
			wait: { type: Boolean, default: false, description: 'Whether to wait for the line to be received' }
		};
	}
	async run(params) {
		if (params.wait) {
			await this.opmanager.controller.sendWait(params.line);
		} else {
			this.opmanager.controller.send(params.line);
		}
	}
}

class OpHold extends Operation {
	getParamSchema() { return {}; }
	run() {
		this.opmanager.controller.hold();
	}
}

class OpResume extends Operation {
	getParamSchema() { return {}; }
	run() {
		this.opmanager.controller.resume();
	}
}

class OpCancel extends Operation {
	getParamSchema() { return {}; }
	run() {
		this.opmanager.controller.cancel();
	}
}

class OpReset extends Operation {
	getParamSchema() { return {}; }
	run() {
		this.opmanager.controller.reset();
	}
}

class OpRealTimeMove extends Operation {
	getParamSchema() {
		return {
			axis: {
				type: Number,
				required: true,
				description: 'Axis number to move'
			},
			inc: {
				type: Number,
				required: true,
				description: 'Amount to move the axis'
			}
		};
	}
	run(params) {
		this.checkReady();
		this.opmanager.controller.realTimeMove(params.axis, params.inc);
	}
}

class OpMove extends Operation {
	getParamSchema() {
		return {
			pos: {
				type: 'array',
				elements: Number,
				required: true,
				description: 'Position to move to'
			},
			feed: {
				type: Number,
				description: 'Feed rate'
			}
		};
	}
	async run(params) {
		this.checkReady();
		await this.opmanager.controller.move(params.pos, params.feed);
	}
}

class OpHome extends Operation {
	getParamSchema() {
		return {
			axes: {
				type: 'array',
				elements: Boolean,
				description: 'True for each axis to home.  False for axes not to home.'
			}
		};
	}
	async run(params) {
		this.checkReady();
		await this.opmanager.controller.home(params.axes);
	}
}

class OpSetAbsolutePos extends Operation {
	getParamSchema() {
		return {
			pos: {
				type: 'array',
				elements: {
					type: 'or',
					alternatives: [
						{ type: Number },
						{ type: Boolean }
					]
				},
				description: 'Positions of axes to set.  If null, 0 is used for all axes.  Elements can also be true (synonym for 0) or false (to ignore that axis).'
			}
		};
	}
	async run(params) {
		let pos = params.pos;
		await this.opmanager.controller.waitSync();
		if (!pos) {
			pos = [];
			for (let axisNum = 0; axisNum < this.opmanager.controller.usedAxes.length; axisNum++) {
				if (this.opmanager.controller.usedAxes[axisNum]) {
					pos.push(0);
				} else {
					pos.push(false);
				}
			}
		} else {
			for (let axisNum = 0; axisNum < pos.length; axisNum++) {
				if (pos[axisNum] === true) pos[axisNum] = 0;
			}
		}
		let gcode = 'G28.3';
		for (let axisNum of this.opmanager.controller.listUsedAxisNumbers()) {
			let axis = this.opmanager.controller.axisLabels[axisNum].toUpperCase();
			if (typeof pos[axisNum] === 'number') {
				gcode += ' ' + axis + pos[axisNum];
			}
		}
		await this.opmanager.controller.sendWait(gcode);
	}
}

class OpProbe extends Operation {
	getParamSchema() {
		return {
			pos: {
				type: 'array',
				elements: Number,
				required: true,
				description: 'Position to probe to'
			},
			feed: {
				type: Number,
				description: 'Feed rate'
			}
		};
	}
	async run(params) {
		this.checkReady();
		return await this.opmanager.controller.probe(params.pos, params.feed);
	}
}

class OpSetOrigin extends Operation {
	getParamSchema() {
		return {
			coordSys: {
				type: Number,
				description: 'Coordinate system to set origin for; 0 = G54.  If null, current coord sys is used.'
			},
			pos: {
				type: 'array',
				elements: {
					type: 'or',
					alternatives: [
						{ type: Number },
						{ type: Boolean }
					]
				},
				description: 'Position offsets of new origin.  If null, current position is used.  Elements can also be true (to use current position for that axis) or false (to ignore that axis).'
			}
		};
	}
	async run(params) {
		let pos = params.pos;
		let posHasBooleans = pos && pos.some((c) => typeof c === 'boolean');
		if (!pos || posHasBooleans || typeof params.coordSys !== 'number') {
			await this.opmanager.controller.waitSync();
		}
		if (!pos) {
			pos = this.opmanager.controller.mpos;
		} else {
			for (let axisNum = 0; axisNum < pos.length; axisNum++) {
				if (pos[axisNum] === true) pos[axisNum] = this.opmanager.controller.mpos[axisNum];
			}
		}
		let coordSys = params.coordSys;
		if (typeof params.coordSys !== 'number') {
			coordSys = this.opmanager.controller.activeCoordSys || 0;
		}
		let gcode = 'G10 L2 P' + (coordSys + 1);
		for (let axisNum of this.opmanager.controller.listUsedAxisNumbers()) {
			let axis = this.opmanager.controller.axisLabels[axisNum].toUpperCase();
			if (typeof pos[axisNum] === 'number') {
				gcode += ' ' + axis + pos[axisNum];
			}
		}
		await this.opmanager.controller.sendWait(gcode);
	}
}

function registerOperations(opmanager) {
	opmanager.registerOperation('getStatus', OpGetStatus);
	opmanager.registerOperation('send', OpSend);
	opmanager.registerOperation('hold', OpHold);
	opmanager.registerOperation('resume', OpResume);
	opmanager.registerOperation('cancel', OpCancel);
	opmanager.registerOperation('reset', OpReset);
	opmanager.registerOperation('realTimeMove', OpRealTimeMove);
	opmanager.registerOperation('move', OpMove);
	opmanager.registerOperation('home', OpHome);
	opmanager.registerOperation('setAbsolutePos', OpSetAbsolutePos);
	opmanager.registerOperation('probe', OpProbe);
	opmanager.registerOperation('setOrigin', OpSetOrigin);
}

module.exports = registerOperations;


