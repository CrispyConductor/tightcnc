const XError = require('xerror');
const GcodeProcessor = require('../../lib/gcode-processor');
const GcodeLine = require('../../lib/gcode-line');
const GcodeVM = require('../../lib/gcode-vm');
const objtools = require('objtools');
const pasync = require('pasync');
const Operation = require('../server/operation');
const ListForm = require('../consoleui/list-form');
const commonSchema = require('common-schema');

/**
 * This gcode processors allows overriding things at job runtime.  Currently just supports feed multiplier.
 *
 * To ensure override changes take effect quickly, this processor limits the total number of lines buffered
 * and not yet executed downstream of this processor to a set minimum.  Because of this, this processor should
 * probably occur near the end of a processor chain.  It should also probably occur after the job recovery processors
 * so it doesn't interfere with that.
 *
 * @class RuntimeOverride
 * @constructor
 * @param {Object} options
 *   @param {Number} [maxTotalLinesBuffered=40] - Maximum number of buffered not-executed lines downstream
 */
class RuntimeOverride extends GcodeProcessor {

	constructor(options = {}) {
		super(options, 'runtimeoverride', true);
		this.maxTotalLinesBuffered = options.maxTotalLinesBuffered || 40;
		this.feedMultiplier = 1;
		this.vm = new GcodeVM(options);
		this.lastLineCounterExecuted = 0;
		this.nextExecutedWaiter = null;
	}

	getStatus() {
		return {
			feedMultiplier: this.feedMultiplier
		};
	}

	async processGcode(gline) {
		if (this.dryRun) return gline;
		this.vm.runGcodeLine(gline);
		let lineCounter = this.vm.lineCounter;
		if (lineCounter - this.lastLineCounterExecuted - 1 >= this.maxTotalLinesBuffered) {
			if (!this.nextExecutedWaiter) this.nextExecutedWaiter = pasync.waiter();
			await this.nextExecutedWaiter.promise;
		}
		if (this.feedMultiplier !== 1 && gline.has('F')) {
			gline.set('F', gline.get('F') * this.feedMultiplier);
			gline.addComment('ro');
		}
		gline.hookSync('executed', () => {
			if (lineCounter > this.lastLineCounterExecuted) {
				this.lastLineCounterExecuted = lineCounter;
			}
			if (this.nextExecutedWaiter && lineCounter - this.lastLineCounterExecuted - 1 < this.maxTotalLinesBuffered) {
				this.nextExecutedWaiter.resolve();
				this.nextExecutedWaiter = null;
			}
		});
		return gline;
	}

	setFeedMultiplier(m) {
		this.feedMultiplier = m;
		if (this.vm.getState().seenWordSet.F) {
			this.pushGcode(new GcodeLine('F' + (this.vm.getState().feed * m)));
		}
	}

}

RuntimeOverride.DEFAULT_ORDER = 950000;

class SetFeedMultiplierOperation extends Operation {

	getParamSchema() {
		return {
			feedMultiplier: {
				type: Number,
				required: true,
				default: 1,
				description: 'Multiplier for job feed rates'
			}
		};
	}

	async run(params) {
		findCurrentJobGcodeProcessor(this.tightcnc, 'runtimeoverride').setFeedMultiplier(params.feedMultiplier);
		return { success: true };
	}

}

function findCurrentJobGcodeProcessor(tightcnc, name, throwOnMissing = true) {
	let currentJob = tightcnc.jobManager.currentJob;
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

module.exports.RuntimeOverride = RuntimeOverride;
module.exports.SetFeedMultiplierOperation = SetFeedMultiplierOperation;
module.exports.registerServerComponents = function (tightcnc) {
	tightcnc.registerGcodeProcessor('runtimeoverride', RuntimeOverride);
	tightcnc.registerOperation('setFeedMultiplier', SetFeedMultiplierOperation);
};




module.exports.registerConsoleUIComponents = function (consoleui) {
	// Automatically add to all jobs created in the console UI
	consoleui.on('newJobObject', (jobOptions) => {
		if (!jobOptions.gcodeProcessors) jobOptions.gcodeProcessors = [];
		jobOptions.gcodeProcessors.push({
			name: 'runtimeoverride',
			options: {},
			order: 950000
		});
	});


	consoleui.modes.jobInfo.hookSync('buildStatusText', (textobj) => {
		let status = consoleui.lastStatus;
		let feedMultiplier = objtools.getPath(status, 'job.gcodeProcessors.runtimeoverride.feedMultiplier');
		if (feedMultiplier && feedMultiplier !== 1) {
			textobj.text += 'Feed multiplier: ' + feedMultiplier + '\n';
		}
	});

	const doFeedOverride = async() => {
		let form = new ListForm(consoleui);
		let mult = await form.showEditor(null, {
			type: 'number',
			required: true,
			validate: (v) => {
				if (!v || v < 0) throw new commonSchema.FieldError('invalid', 'Feed multiplier must be a positive number');
			}
		}, objtools.getPath(consoleui, 'lastStatus.job.gcodeProcessors.runtimeoverride.feedMultiplier') || 1);
		if (mult) {
			await consoleui.client.op('setFeedMultiplier', { feedMultiplier: mult });
		}
	};

	consoleui.modes.jobInfo.registerModeKey([ 'f' ], [ 'f' ], 'Feed Mult.', () => {
		doFeedOverride().catch((err) => consoleui.clientError(err));
	});
};

