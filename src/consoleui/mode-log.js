const ConsoleUIMode = require('./consoleui-mode');
const blessed = require('blessed');

class ModeLog extends ConsoleUIMode {

	constructor(consoleui) {
		super(consoleui);
		this.updateLoopRunning = false;
		this.modeActive = false;
		this.logConfig = consoleui.config.consoleui.log;
		this.lastLineNum = null;
		this.logStr = '';
	}

	async updateLog() {
		let newEntries = await this.consoleui.client.op('getLog', {
			start: (this.lastLineNum === null) ? 0 : (this.lastLineNum + 1),
			end: null,
			limit: this.logConfig.updateBatchLimit
		});
		if (!newEntries.length) return false;
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
		return true;
	}

	refreshLogDisplay() {
		this.logBox.setContent(this.logStr);
		if (this.logStr) this.logBox.setScrollPerc(100);
		this.consoleui.render();
	}

	startLogUpdateLoop() {
		this.updateLoopRunning = true;
		this.logUpdating = false;
		setInterval(() => {
			if (this.logUpdating) return;
			this.logUpdating = true;
			this.updateLog()
				.then((updated) => {
					this.logUpdating = false;
					if (this.modeActive && updated) {
						this.refreshLogDisplay();
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
		this.textbox.focus();
	}

	exitMode() {
		this.modeActive = false;
		super.exitMode();
	}

	init() {
		super.init();
		this.logBox = blessed.box({
			width: '100%',
			height: '100%-2',
			content: 'Foo\nBar\n',
			scrollable: true,
			scrollbar: {
				ch: '#',
				style: {
					//fg: 'blue'
				},
				track: {
					bg: 'gray'
				}

			},
			style: {
			}
		});
		this.box.append(this.logBox);
		this.separatorLine = blessed.line({
			type: 'line',
			orientation: 'horizontal',
			width: '100%',
			bottom: 1
		});
		this.box.append(this.separatorLine);
		
		this.textbox = blessed.textbox({
			inputOnFocus: true,
			height: 1,
			width: '100%',
			bottom: 0
		});
		this.box.append(this.textbox);

		const scrollUp = () => {
			this.logBox.scroll(-Math.ceil(this.logBox.height / 3))
			this.consoleui.render();
		};

		const scrollDown = () => {
			this.logBox.scroll(Math.ceil(this.logBox.height / 3))
			this.consoleui.render();
		};

		this.consoleui.registerHomeKey([ 'l', 'L' ], 'l', 'Log Mode', () => this.consoleui.activateMode('log'));
		
		this.registerModeKey([ 'escape' ], [ 'Esc' ], 'Home', () => this.consoleui.exitMode());
		this.registerModeKey([ 'pageup' ], [ 'PgUp' ], 'Scroll Up', scrollUp);
		this.registerModeKey([ 'pagedown' ], [ 'PgDn' ], 'Scroll Down', scrollDown);

		this.registerModeHint([ '<Any>' ], 'Type');
		this.registerModeHint([ 'Enter' ], 'Submit');

		this.textbox.key([ 'escape' ], () => this.consoleui.exitMode());
		this.textbox.key([ 'pageup' ], scrollUp);
		this.textbox.key([ 'pagedown' ], scrollDown);

		this.textbox.on('submit', () => {
			let line = this.textbox.getValue();
			this.textbox.clearValue();
			this.textbox.focus();
			this.consoleui.render();
			if (line.trim()) {
				this.consoleui.client.op('send', {
					line: line
				})
					.catch((err) => {
						this.consoleui.clientError(err);
					});
			}
		});
	}

}

module.exports = ModeLog;
module.exports.registerConsoleUI = function(consoleui) {
	consoleui.registerMode('log', new ModeLog(consoleui));
};

