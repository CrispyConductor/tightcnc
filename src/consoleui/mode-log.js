const ConsoleUIMode = require('./consoleui-mode');
const blessed = require('blessed');

class ModeLog extends ConsoleUIMode {

	constructor(consoleui) {
		super(consoleui);
		this.updateLoopRunning = false;
		this.modeActive = false;
		this.logConfig = consoleui.config.consoleui.log;
		this.lastLineNum = null;
		this.logStr = 'LogStart';
	}

	async updateLog() {
		let newEntries = await this.consoleui.client.op('getLog', {
			start: (this.lastLineNum === null) ? 0 : (this.lastLineNum + 1),
			end: null,
			limit: this.logConfig.updateBatchLimit
		});
		if (!newEntries.length) return;
		let firstLineNum = newEntries[0][0];
		let lastLineNum = newEntries[newEntries.length - 1][0];
		if (this.lastlineNum !== null && firstLineNum !== this.lastLineNum + 1) {
			// Either server log indexes reset, or we missed a gap in log data
			this.logStr = '';
		}
		for (let entry of newEntries) {
			this.logStr += entry[1] + '\n';
		}
		this.lastLineNum = newEntries[newEntries.length - 1][0];
		if (this.logStr.length > this.logConfig.bufferMaxSize) {
			this.logStr = this.logStr.slice(-this.logConfig.bufferMaxSize);
		}
	}

	startLogUpdateLoop() {
		this.updateLoopRunning = true;
		this.logUpdating = false;
		setInterval(() => {
			if (this.logUpdating) return;
			this.logUpdating = true;
			this.updateLog()
				.then(() => {
					this.logUpdating = false;
					if (this.modeActive) {
						this.logBox.setContent(this.logStr);
					}
				})
				.catch((err) => {
					this.consoleui.clientError(err);
					this.logUpdating = false;
				});
		}, this.logConfig.updateInterval);
	}

	activateMode() {
		super.activateMode();
		this.modeActive = true;
		if (!this.updateLoopRunning) this.startLogUpdateLoop();
	}

	exitMode() {
		this.modeActive = false;
		super.exitMode();
	}

	init() {
		super.init();
		this.logBox = blessed.box({
			width: '100%',
			height: '100%',
			content: ''
		});
		this.box.append(this.logBox);

		this.consoleui.registerHomeKey([ 'l', 'L' ], 'l', 'Log Mode', () => this.consoleui.activateMode('log'));
		this.registerModeKey([ 'escape' ], [ 'Esc' ], 'Home', () => this.consoleui.exitMode());
	}

}

module.exports = ModeLog;
module.exports.registerConsoleUI = function(consoleui) {
	consoleui.registerMode('log', new ModeLog(consoleui));
};

