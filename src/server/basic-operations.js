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
		await this.opmanager.controller.home(params.axes);
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
		await this.opmanager.controller.probe(params.pos, params.feed);
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
	opmanager.registerOperation('probe', OpProbe);
}

module.exports = registerOperations;


