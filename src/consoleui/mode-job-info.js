const ConsoleUIMode = require('./consoleui-mode');
const blessed = require('blessed');

function formatMinutes(secs) {
	let hours = Math.floor(secs / 3600);
	let minutes = Math.floor((secs - hours * 3600) / 60);
	if (minutes < 10) minutes = '0' + minutes;
	return '' + hours + ':' + minutes;
}

class ModeJobInfo extends ConsoleUIMode {

	constructor(consoleui) {
		super(consoleui);
		this.statusUpdateHandler = (status) => {
			let text = this.getStatusText(status);
			this.box.setContent(text);
			this.consoleui.render();
		};
	}

	getStatusText(status) {
		if (!status.job) return 'No current job.';
		let text = '';
		text += 'Job state: ' + status.job.state + '\n';
		text += 'Start time: ' + status.job.startTime + '\n';
		if (status.job.progress) {
			text += 'Progress: ' + status.job.progress.percentComplete.toFixed(1) + '%\n';
			text += 'Time running: ' + formatMinutes(status.job.progress.timeRunning) + '\n';
			text += 'Est. time remaining: ' + formatMinutes(status.job.progress.estTimeRemaining) + '\n';
		}
		if (status.job.gcodeProcessors && status.job.gcodeProcessors['final-job-vm']) {
			let vmStatus = status.job.gcodeProcessors['final-job-vm'];
			text += 'Units: ' + vmStatus.units + '\n';
			if (vmStatus.line) text += 'GCode line number: ' + vmStatus.line + '\n';
			text += 'Lines processed: ' + vmStatus.lineCounter + '\n';
		}
		if (status.job.state === 'error' && status.job.error) {
			text += 'Error: ' + JSON.stringify(status.job.error) + '\n';
		}
		return text;
	}

	activateMode() {
		super.activateMode();
		this.consoleui.on('statusUpdate', this.statusUpdateHandler);
		this.statusUpdateHandler(this.consoleui.lastStatus);
	}

	exitMode() {
		this.consoleui.removeListener('statusUpdate', this.statusUpdateHandler);
		super.exitMode();
	}

	init() {
		super.init();
		
		this.consoleui.registerHomeKey([ 'j', 'J' ], 'j', 'Job Info', () => this.consoleui.activateMode('jobInfo'), 4);
		
		this.registerModeKey([ 'escape' ], [ 'Esc' ], 'Home', () => this.consoleui.exitMode());

		// Pull in a few useful keybinds from the control mode
		let controlKeybinds = this.consoleui.config.consoleui.control.keybinds;
		let controlMode = this.consoleui.modes.control;
		const registerKeybind = (kb) => {
			this.registerModeKey(kb.keys, kb.keyNames, kb.label, () => {
				controlMode._executeKeybind(kb.action)
					.catch((err) => this.consoleui.clientError(err));
			});
		};
		for (let key of [ 'hold', 'resume', 'cancel' ]) {
			if (controlKeybinds[key]) {
				registerKeybind(controlKeybinds[key]);
			}
		}
	}

}

module.exports = ModeJobInfo;
module.exports.registerConsoleUI = function(consoleui) {
	consoleui.registerMode('jobInfo', new ModeJobInfo(consoleui));
};

